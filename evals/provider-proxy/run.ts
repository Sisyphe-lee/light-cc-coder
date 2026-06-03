#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

export const PROVIDER_PROXY_PROFILE_SCHEMA_VERSION = 1

export type ProviderProxyOptions = {
  listenHost: string
  port: number
  upstreamBaseUrl: string
  apiKeyEnv: string
  out: string
  model?: string
  env?: NodeJS.ProcessEnv
}

export type ProviderProxyHandle = {
  server: Bun.Server<undefined>
  port: number
  profilePath: string
  stop: () => Promise<void>
}

type NormalizedProviderProxyOptions = Omit<ProviderProxyOptions, "env"> & {
  env: NodeJS.ProcessEnv
  profilePath: string
}

type RequestMetadata = {
  id: string
  startedAt: string
  endedAt: string
  method: string
  path: string
  status: number | null
  streaming: boolean
  model: string | null
  latencyMs: number
  firstTokenMs: number | null
  usage: UsageMetadata | null
  error: ErrorMetadata | null
  retry: RetryMetadata
  cost: CostMetadata
}

type ProviderProxyProfile = {
  schemaVersion: typeof PROVIDER_PROXY_PROFILE_SCHEMA_VERSION
  kind: "metadata-only-provider-proxy"
  startedAt: string
  updatedAt: string
  privacy: {
    prompt: "not_recorded"
    response: "not_recorded"
    apiKey: "not_recorded"
  }
  proxy: {
    listenHost: string
    port: number
    upstreamBaseUrl: string
    apiKeyEnv: string
    model: string | null
  }
  totals: {
    requestCount: number
    successCount: number
    errorCount: number
    retryableErrorCount: number
    totalLatencyMs: number
    averageLatencyMs: number | null
    averageFirstTokenMs: number | null
    usage: UsageMetadata
    cost: CostMetadata
  }
  requests: RequestMetadata[]
}

type UsageMetadata = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
}

type ErrorMetadata = {
  kind: "upstream_http_error" | "proxy_error"
  status: number | null
  retryable: boolean
  message?: string
}

type RetryMetadata = {
  attempts: number
  retryable: boolean
  retryAfterMs?: number
}

type CostMetadata = {
  estimatedUsd: number | null
  currency: "USD"
  source: "not_configured"
}

type PreparedBody = {
  body?: BodyInit
  model: string | null
  streaming: boolean
}

type RequestTiming = {
  startedAt: string
  startedMs: number
  firstTokenMs: number | null
  usage: UsageMetadata | null
}

type OpenAIUsage = {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
  prompt_cache_hit_tokens?: unknown
  prompt_cache_miss_tokens?: unknown
  prompt_tokens_details?: { cached_tokens?: unknown }
  completion_tokens_details?: { reasoning_tokens?: unknown }
}

export async function startProviderProxy(options: ProviderProxyOptions): Promise<ProviderProxyHandle> {
  const normalized = normalizeOptions(options)
  const recorder = new ProfileRecorder(normalized)
  const server = Bun.serve({
    hostname: normalized.listenHost,
    port: normalized.port,
    fetch: (request) => handleProxyRequest(request, normalized, recorder),
  })

  const listenPort = server.port ?? normalized.port
  recorder.setPort(listenPort)
  await recorder.writeSnapshot()

  return {
    server,
    port: listenPort,
    profilePath: normalized.profilePath,
    stop: async () => {
      server.stop(true)
      await recorder.writeSnapshot()
    },
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    const handle = await startProviderProxy(options)
    console.log(`Provider proxy listening on http://${options.listenHost}:${handle.port}`)
    console.log(`Profile: ${handle.profilePath}`)
    await waitForShutdown()
    await handle.stop()
    return 0
  } catch (error) {
    console.error(stringifyError(error))
    return 1
  }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ProviderProxyOptions {
  const options: Partial<ProviderProxyOptions> = {
    listenHost: "127.0.0.1",
    port: 8787,
    apiKeyEnv: env.LIGHT_CC_API_KEY_ENV ?? "OPENAI_API_KEY",
    out: join(process.cwd(), ".light-cc", "evals", "provider-proxy"),
    env,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--listen-host") options.listenHost = requireValue(argv, ++index, arg)
    else if (arg === "--port") options.port = parsePort(requireValue(argv, ++index, arg), arg)
    else if (arg === "--upstream-base-url") options.upstreamBaseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--out") options.out = requireValue(argv, ++index, arg)
    else if (arg === "--model") options.model = requireValue(argv, ++index, arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!options.upstreamBaseUrl) throw new Error("--upstream-base-url is required")
  return normalizeOptions(options as ProviderProxyOptions)
}

async function handleProxyRequest(
  request: Request,
  options: NormalizedProviderProxyOptions,
  recorder: ProfileRecorder,
): Promise<Response> {
  const id = recorder.nextRequestId()
  const incomingUrl = new URL(request.url)
  const timing: RequestTiming = {
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    firstTokenMs: null,
    usage: null,
  }

  try {
    const prepared = await prepareBody(request, options.model)
    const upstreamUrl = buildUpstreamUrl(options.upstreamBaseUrl, incomingUrl)
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers, options),
      body: allowsBody(request.method) ? prepared.body : undefined,
      signal: request.signal,
    })

    return await proxyResponse(upstream, {
      id,
      request,
      incomingUrl,
      prepared,
      timing,
      recorder,
    })
  } catch (error) {
    const response = Response.json({ error: "provider proxy upstream request failed" }, { status: 502 })
    await recorder.record(
      buildRequestMetadata({
        id,
        method: request.method,
        path: incomingUrl.pathname,
        status: 502,
        streaming: false,
        model: options.model ?? null,
        timing,
        error: {
          kind: "proxy_error",
          status: 502,
          retryable: true,
          message: sanitizeErrorMessage(error),
        },
        retryAfterMs: undefined,
      }),
    )
    return response
  }
}

async function proxyResponse(
  upstream: Response,
  context: {
    id: string
    request: Request
    incomingUrl: URL
    prepared: PreparedBody
    timing: RequestTiming
    recorder: ProfileRecorder
  },
): Promise<Response> {
  const responseInit = {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  }
  const retryAfterMs = parseRetryAfterMs(upstream.headers.get("retry-after"))
  const shouldParseStream = context.prepared.streaming || isEventStream(upstream.headers)

  if (upstream.body && shouldParseStream) {
    const parser = new SseMetadataParser(context.timing)
    const stream = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          parser.feed(chunk)
          controller.enqueue(chunk)
        },
        async flush() {
          parser.finish()
          await context.recorder.record(
            buildRequestMetadata({
              id: context.id,
              method: context.request.method,
              path: context.incomingUrl.pathname,
              status: upstream.status,
              streaming: true,
              model: context.prepared.model,
              timing: context.timing,
              error: upstream.ok ? null : httpError(upstream.status),
              retryAfterMs,
            }),
          )
        },
      }),
    )
    return new Response(stream, responseInit)
  }

  try {
    const bytes = upstream.body ? new Uint8Array(await upstream.arrayBuffer()) : new Uint8Array()
    readJsonUsage(bytes, upstream.headers, context.timing)
    await context.recorder.record(
      buildRequestMetadata({
        id: context.id,
        method: context.request.method,
        path: context.incomingUrl.pathname,
        status: upstream.status,
        streaming: false,
        model: context.prepared.model,
        timing: context.timing,
        error: upstream.ok ? null : httpError(upstream.status),
        retryAfterMs,
      }),
    )
    return new Response(bytes, responseInit)
  } catch (error) {
    await context.recorder.record(
      buildRequestMetadata({
        id: context.id,
        method: context.request.method,
        path: context.incomingUrl.pathname,
        status: upstream.status,
        streaming: false,
        model: context.prepared.model,
        timing: context.timing,
        error: {
          kind: "proxy_error",
          status: upstream.status,
          retryable: true,
          message: sanitizeErrorMessage(error),
        },
        retryAfterMs,
      }),
    )
    return Response.json({ error: "provider proxy response read failed" }, { status: 502 })
  }
}

function buildRequestMetadata(input: {
  id: string
  method: string
  path: string
  status: number | null
  streaming: boolean
  model: string | null
  timing: RequestTiming
  error: ErrorMetadata | null
  retryAfterMs?: number
}): RequestMetadata {
  const latencyMs = Date.now() - input.timing.startedMs
  const retryable = input.error?.retryable ?? false
  return {
    id: input.id,
    startedAt: input.timing.startedAt,
    endedAt: new Date().toISOString(),
    method: input.method,
    path: input.path,
    status: input.status,
    streaming: input.streaming,
    model: input.model,
    latencyMs,
    firstTokenMs: input.timing.firstTokenMs,
    usage: input.timing.usage,
    error: input.error,
    retry: {
      attempts: 0,
      retryable,
      ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
    },
    cost: unknownCost(),
  }
}

async function prepareBody(request: Request, modelOverride?: string): Promise<PreparedBody> {
  if (!allowsBody(request.method) || !request.body) {
    return { model: modelOverride ?? null, streaming: false }
  }

  const bytes = await request.arrayBuffer()
  if (bytes.byteLength === 0) return { body: bytes, model: modelOverride ?? null, streaming: false }

  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("json")) {
    return { body: bytes, model: modelOverride ?? null, streaming: false }
  }

  const text = new TextDecoder().decode(bytes)
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return { body: bytes, model: modelOverride ?? null, streaming: false }
    const requestedModel = typeof parsed.model === "string" ? parsed.model : null
    const streaming = parsed.stream === true
    if (modelOverride) {
      parsed.model = modelOverride
      return { body: JSON.stringify(parsed), model: modelOverride, streaming }
    }
    return { body: bytes, model: requestedModel, streaming }
  } catch {
    return { body: bytes, model: modelOverride ?? null, streaming: false }
  }
}

function buildUpstreamHeaders(headers: Headers, options: NormalizedProviderProxyOptions): Headers {
  const forwarded = new Headers(headers)
  forwarded.delete("authorization")
  forwarded.delete("api-key")
  forwarded.delete("x-api-key")
  forwarded.delete("host")
  forwarded.delete("content-length")

  const apiKey = options.env[options.apiKeyEnv]
  if (apiKey) forwarded.set("authorization", `Bearer ${apiKey}`)
  return forwarded
}

function buildUpstreamUrl(upstreamBaseUrl: string, incomingUrl: URL): string {
  const upstream = new URL(upstreamBaseUrl)
  const basePath = upstream.pathname.replace(/\/+$/, "")
  const incomingPath = incomingUrl.pathname.startsWith("/") ? incomingUrl.pathname : `/${incomingUrl.pathname}`
  const targetPath =
    basePath && basePath !== "/" && (incomingPath === basePath || incomingPath.startsWith(`${basePath}/`))
      ? incomingPath
      : joinUrlPath(basePath, incomingPath)
  upstream.pathname = targetPath
  upstream.search = incomingUrl.search
  upstream.hash = ""
  upstream.username = ""
  upstream.password = ""
  return upstream.toString()
}

function joinUrlPath(basePath: string, incomingPath: string): string {
  const left = basePath === "/" ? "" : basePath.replace(/\/+$/, "")
  const right = incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`
  return `${left}${right}` || "/"
}

class SseMetadataParser {
  private readonly decoder = new TextDecoder()
  private buffer = ""

  constructor(private readonly timing: RequestTiming) {}

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.drain()
  }

  finish(): void {
    this.buffer += this.decoder.decode()
    const tail = this.buffer.trim()
    if (tail.length > 0) this.parseRawEvent(tail)
    this.buffer = ""
  }

  private drain(): void {
    let splitAt: number
    while ((splitAt = this.buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buffer.slice(0, splitAt)
      this.buffer = this.buffer.slice(splitAt + 2)
      this.parseRawEvent(rawEvent)
    }
  }

  private parseRawEvent(rawEvent: string): void {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data.length === 0 || data === "[DONE]") return

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    const usage = readUsageFromRecord(parsed)
    if (usage) this.timing.usage = usage
    if (this.timing.firstTokenMs === null && hasFirstTokenMetadata(parsed)) {
      this.timing.firstTokenMs = Date.now() - this.timing.startedMs
    }
  }
}

class ProfileRecorder {
  private readonly startedAt = new Date().toISOString()
  private readonly records: RequestMetadata[] = []
  private writeQueue: Promise<void> = Promise.resolve()
  private requestSeq = 0
  private port: number

  constructor(private readonly options: NormalizedProviderProxyOptions) {
    this.port = options.port
  }

  setPort(port: number): void {
    this.port = port
  }

  nextRequestId(): string {
    this.requestSeq += 1
    return `provider_proxy_req_${this.requestSeq}`
  }

  async record(record: RequestMetadata): Promise<void> {
    this.records.push(record)
    await this.writeSnapshot()
  }

  async writeSnapshot(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.options.profilePath), { recursive: true })
      await writeFile(this.options.profilePath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8")
    })
    await this.writeQueue
  }

  private snapshot(): ProviderProxyProfile {
    const firstTokenValues = this.records
      .map((record) => record.firstTokenMs)
      .filter((value): value is number => typeof value === "number")
    const totalLatencyMs = this.records.reduce((sum, record) => sum + record.latencyMs, 0)
    return {
      schemaVersion: PROVIDER_PROXY_PROFILE_SCHEMA_VERSION,
      kind: "metadata-only-provider-proxy",
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      privacy: {
        prompt: "not_recorded",
        response: "not_recorded",
        apiKey: "not_recorded",
      },
      proxy: {
        listenHost: this.options.listenHost,
        port: this.port,
        upstreamBaseUrl: sanitizeBaseUrl(this.options.upstreamBaseUrl),
        apiKeyEnv: this.options.apiKeyEnv,
        model: this.options.model ?? null,
      },
      totals: {
        requestCount: this.records.length,
        successCount: this.records.filter((record) => record.error === null).length,
        errorCount: this.records.filter((record) => record.error !== null).length,
        retryableErrorCount: this.records.filter((record) => record.error?.retryable).length,
        totalLatencyMs,
        averageLatencyMs: this.records.length === 0 ? null : roundMs(totalLatencyMs / this.records.length),
        averageFirstTokenMs: firstTokenValues.length === 0 ? null : roundMs(sum(firstTokenValues) / firstTokenValues.length),
        usage: this.records.reduce((total, record) => addUsage(total, record.usage), {}),
        cost: unknownCost(),
      },
      requests: this.records,
    }
  }
}

function readJsonUsage(bytes: Uint8Array, headers: Headers, timing: RequestTiming): void {
  if (!isJson(headers)) return
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!isRecord(parsed)) return
    const usage = readUsageFromRecord(parsed)
    if (usage) timing.usage = usage
  } catch {
    return
  }
}

function readUsageFromRecord(record: Record<string, unknown>): UsageMetadata | null {
  const raw = record.usage
  if (!isRecord(raw)) return null
  return extractUsage(raw as OpenAIUsage)
}

function extractUsage(raw: OpenAIUsage): UsageMetadata | null {
  const usage: UsageMetadata = {}
  assignFinite(usage, "inputTokens", raw.prompt_tokens)
  assignFinite(usage, "outputTokens", raw.completion_tokens)
  assignFinite(usage, "totalTokens", raw.total_tokens)
  assignFinite(usage, "cacheReadInputTokens", raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens)
  assignFinite(usage, "cacheWriteInputTokens", raw.prompt_cache_miss_tokens)
  assignFinite(usage, "reasoningTokens", raw.completion_tokens_details?.reasoning_tokens)
  return Object.keys(usage).length > 0 ? usage : null
}

function hasFirstTokenMetadata(record: Record<string, unknown>): boolean {
  const choices = record.choices
  if (!Array.isArray(choices)) return false
  return choices.some((choice) => {
    if (!isRecord(choice) || !isRecord(choice.delta)) return false
    const delta = choice.delta
    if (typeof delta.content === "string" && delta.content.length > 0) return true
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true
    return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
  })
}

function httpError(status: number): ErrorMetadata {
  return {
    kind: "upstream_http_error",
    status,
    retryable: isRetryableStatus(status),
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now())
  return undefined
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 240)
}

function sanitizeBaseUrl(value: string): string {
  const url = new URL(value)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

function normalizeOptions(options: ProviderProxyOptions): NormalizedProviderProxyOptions {
  const port = options.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535")
  if (!options.listenHost) throw new Error("--listen-host is required")
  if (!options.upstreamBaseUrl) throw new Error("--upstream-base-url is required")
  new URL(options.upstreamBaseUrl)
  return {
    ...options,
    port,
    env: options.env ?? process.env,
    profilePath: resolveProfilePath(options.out),
  }
}

function resolveProfilePath(out: string): string {
  const resolved = resolve(out)
  if (basename(resolved).endsWith(".json")) return resolved
  return join(resolved, "provider.profile.json")
}

function isJson(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("json")
}

function isEventStream(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
}

function allowsBody(method: string): boolean {
  const normalized = method.toUpperCase()
  return normalized !== "GET" && normalized !== "HEAD"
}

function assignFinite(target: UsageMetadata, key: keyof UsageMetadata, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value
}

function addUsage(total: UsageMetadata, usage: UsageMetadata | null): UsageMetadata {
  if (!usage) return total
  for (const key of Object.keys(usage) as Array<keyof UsageMetadata>) {
    const value = usage[key]
    if (typeof value === "number") total[key] = (total[key] ?? 0) + value
  }
  return total
}

function unknownCost(): CostMetadata {
  return {
    estimatedUsd: null,
    currency: "USD",
    source: "not_configured",
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000
}

function parsePort(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a port number`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`${flag} must be between 0 and 65535`)
  return parsed
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    const done = () => resolveShutdown()
    process.once("SIGINT", done)
    process.once("SIGTERM", done)
  })
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(): string {
  return [
    "Usage: bun evals/provider-proxy/run.ts --upstream-base-url <url> [--listen-host 127.0.0.1] [--port 8787]",
    "       bun evals/provider-proxy/run.ts --upstream-base-url https://api.example.com/v1 --api-key-env OPENAI_API_KEY --out .light-cc/evals/provider-proxy --model <model>",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
