import { createHash } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { SessionEventDraft } from "../core/events"
import { NOOP_PROFILER, type Profiler, type ProfileSpanHandle } from "../profiling/profiler"
import type { ToolObservation } from "../tools/result"
import { ToolExecutionError } from "../tools/result"
import type { JsonSchema } from "../tools/schemas"
import type { ToolDefinition } from "../tools/registry"

export type McpServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  startupTimeoutMs?: number
  callTimeoutMs?: number
}

export type McpServerContext = {
  name: string
  status: "ready" | "failed"
  toolCount: number
  configHash: string
  error?: string
}

export type McpContextSnapshot = {
  servers: McpServerContext[]
  toolCount: number
  configHash: string
}

export type McpConnectionResult = {
  context: McpContextSnapshot
  clients: McpStdioClient[]
  tools: ToolDefinition[]
}

type JsonRpcMessage = {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type McpListedTool = {
  name: string
  description?: string
  inputSchema?: JsonSchema
  annotations?: {
    readOnlyHint?: boolean
  }
}

export async function connectMcpServers(
  configs: McpServerConfig[],
  options: { emit?: (event: SessionEventDraft) => Promise<void>; signal: AbortSignal; profiler?: Profiler } = {
    signal: new AbortController().signal,
  },
): Promise<McpConnectionResult> {
  const profiler = options.profiler ?? NOOP_PROFILER
  const clients: McpStdioClient[] = []
  const tools: ToolDefinition[] = []
  const servers: McpServerContext[] = []
  const usedToolNames = new Set<string>()
  for (const config of configs) {
    const serverName = sanitizeMcpName(config.name)
    const configHash = hashStable(redactConfig(config))
    await options.emit?.({ type: "mcp.server.started", serverName: config.name, configHash })
    // One coarse span per server covering spawn + initialize + tools/list; the
    // two requests are recorded as marks rather than separate spans.
    const startSpan = profiler.startSpan("mcp.start_server", "mcp", { serverName: config.name, configHash })
    const client = new McpStdioClient(config)
    try {
      const listed = await client.start(options.signal, startSpan)
      const adapted = listed.map((tool) => adaptMcpTool({ serverName, rawServerName: config.name, tool, client }))
      for (const tool of adapted) {
        if (usedToolNames.has(tool.name)) {
          throw new Error(`MCP tool name collision after sanitization: ${tool.name}`)
        }
        usedToolNames.add(tool.name)
      }
      clients.push(client)
      tools.push(...adapted)
      servers.push({ name: config.name, status: "ready", toolCount: adapted.length, configHash })
      await startSpan.end("ok", { toolCount: adapted.length, stderrBytes: byteLength(client.stderrPreview()) })
      await options.emit?.({
        type: "mcp.server.ready",
        serverName: config.name,
        toolCount: adapted.length,
        configHash,
        stderr: client.stderrPreview(),
      })
    } catch (error) {
      client.close()
      const message = error instanceof Error ? error.message : String(error)
      servers.push({ name: config.name, status: "failed", toolCount: 0, configHash, error: message })
      await startSpan.end("error", { stderrBytes: byteLength(client.stderrPreview()) })
      await options.emit?.({
        type: "mcp.server.failed",
        serverName: config.name,
        configHash,
        error: message,
        stderr: client.stderrPreview(),
      })
    }
  }
  return {
    clients,
    tools,
    context: {
      servers,
      toolCount: tools.length,
      configHash: hashStable(configs.map(redactConfig)),
    },
  }
}

export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 0
  private stdoutBuffer = ""
  private stderr = ""
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
      timer: ReturnType<typeof setTimeout>
      onAbort?: () => void
      signal?: AbortSignal
    }
  >()

  constructor(readonly config: McpServerConfig) {}

  async start(signal: AbortSignal, span?: ProfileSpanHandle): Promise<McpListedTool[]> {
    if (this.child) throw new Error(`MCP server already started: ${this.config.name}`)
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => this.handleStdout(String(chunk)))
    this.child.stderr.on("data", (chunk) => this.captureStderr(String(chunk)))
    this.child.once("error", (error) => this.rejectPending(error))
    this.child.once("exit", (code, exitSignal) => {
      this.rejectPending(new Error(`MCP server exited (code=${code ?? "null"}, signal=${exitSignal ?? "null"})`))
    })

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "light-cc-coder", version: "0.0.0" },
      },
      this.config.startupTimeoutMs ?? 5000,
      signal,
    )
    span?.mark("initializeMs")
    this.notify("notifications/initialized", {})
    const listed = await this.request("tools/list", {}, this.config.startupTimeoutMs ?? 5000, signal)
    span?.mark("toolsListMs")
    return parseToolList(listed)
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolObservation> {
    try {
      const result = await this.request(
        "tools/call",
        { name, arguments: args },
        this.config.callTimeoutMs ?? 30_000,
        signal,
      )
      const rendered = renderMcpToolResult(result)
      return { content: rendered.content, isError: rendered.isError, preserveErrorContent: rendered.isError }
    } catch (error) {
      if (signal.aborted) {
        throw new ToolExecutionError("aborted", `MCP tool call aborted: ${String(signal.reason ?? "aborted")}`)
      }
      throw new ToolExecutionError(
        "runtime_error",
        `MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  close(): void {
    this.rejectPending(new Error("MCP server closed"))
    this.child?.kill()
    this.child = undefined
  }

  stderrPreview(): string | undefined {
    return this.stderr || undefined
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child
    if (!child || child.killed) return Promise.reject(new Error("MCP server is not running"))
    if (signal?.aborted) return Promise.reject(new Error(String(signal.reason ?? "aborted")))
    const id = ++this.nextId
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pending.get(id)
        if (pending?.onAbort && pending.signal) pending.signal.removeEventListener("abort", pending.onAbort)
        if (pending) clearTimeout(pending.timer)
        this.pending.delete(id)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onAbort = signal
        ? () => {
            cleanup()
            this.close()
            reject(new Error(String(signal.reason ?? "aborted")))
          }
        : undefined
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timer,
        onAbort,
        signal,
      })
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8")
    })
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8")
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n")
      if (newline === -1) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        continue
      }
      if (typeof message.id !== "number") continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      if (message.error) {
        pending.reject(new Error(message.error.message || `MCP error ${message.error.code ?? ""}`.trim()))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private captureStderr(chunk: string): void {
    this.stderr = capMiddle(this.stderr + chunk, 4096)
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function adaptMcpTool(input: {
  serverName: string
  rawServerName: string
  tool: McpListedTool
  client: McpStdioClient
}): ToolDefinition {
  const rawToolName = input.tool.name
  const name = `mcp__${input.serverName}__${sanitizeMcpName(rawToolName)}`
  const inputSchema = normalizeSchema(input.tool.inputSchema)
  return {
    name,
    description: input.tool.description || `MCP tool ${rawToolName} from ${input.rawServerName}`,
    inputSchema,
    readOnly: input.tool.annotations?.readOnlyHint === true,
    parse(value) {
      validateMcpInput(value, inputSchema, name)
      return value ?? {}
    },
    async execute(value, ctx) {
      const span = (ctx.profiler ?? NOOP_PROFILER).startSpan("mcp.tool_call", "mcp", {
        serverName: input.rawServerName,
        toolName: rawToolName,
      })
      try {
        const result = await input.client.callTool(rawToolName, value ?? {}, ctx.signal)
        await span.end(result.isError ? "error" : "ok", { isError: result.isError === true })
        return result
      } catch (error) {
        await span.end("error")
        throw error
      }
    },
  }
}

function parseToolList(value: unknown): McpListedTool[] {
  const tools = (value as { tools?: unknown[] } | undefined)?.tools
  if (!Array.isArray(tools)) throw new Error("MCP tools/list result must contain a tools array")
  return tools.map((tool, index) => {
    const record = tool as Record<string, unknown>
    if (!record || typeof record !== "object" || typeof record.name !== "string" || record.name.length === 0) {
      throw new Error(`MCP tools[${index}] is missing a name`)
    }
    return {
      name: record.name,
      description: typeof record.description === "string" ? record.description : undefined,
      inputSchema: normalizeSchema(record.inputSchema),
      annotations:
        typeof record.annotations === "object" && record.annotations !== null
          ? { readOnlyHint: (record.annotations as { readOnlyHint?: unknown }).readOnlyHint === true }
          : undefined,
    }
  })
}

function validateMcpInput(value: unknown, schema: JsonSchema, toolName: string): void {
  validateJsonValue(value, schema, toolName)
}

function validateJsonValue(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.enum && !schema.enum.some((item) => stableJson(item) === stableJson(value))) {
    throw new ToolExecutionError("invalid_input", `${path} must be one of ${schema.enum.map(String).join(", ")}`)
  }

  if (schema.type && !schemaAllowsType(schema.type, value)) {
    throw new ToolExecutionError("invalid_input", `${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`)
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    if (!isPlainObject(value)) throw new ToolExecutionError("invalid_input", `${path} input must be an object`)
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record)) throw new ToolExecutionError("invalid_input", `${key} is required`)
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) validateJsonValue(record[key], childSchema, `${path}.${key}`)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) throw new ToolExecutionError("invalid_input", `${path}.${key} is not allowed`)
      }
    }
  }

  if (schema.type === "array" || schema.items) {
    if (!Array.isArray(value)) throw new ToolExecutionError("invalid_input", `${path} must be an array`)
    if (schema.items) {
      value.forEach((item, index) => validateJsonValue(item, schema.items!, `${path}[${index}]`))
    }
  }
}

function schemaAllowsType(type: string | string[], value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type]
  return types.some((item) => {
    if (item === "string") return typeof value === "string"
    if (item === "number") return typeof value === "number" && Number.isFinite(value)
    if (item === "integer") return Number.isInteger(value)
    if (item === "boolean") return typeof value === "boolean"
    if (item === "array") return Array.isArray(value)
    if (item === "object") return isPlainObject(value)
    if (item === "null") return value === null
    return true
  })
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function renderMcpToolResult(value: unknown): { content: string; isError: boolean } {
  const record = value as { content?: unknown[]; structuredContent?: unknown; isError?: boolean } | undefined
  const isError = record?.isError === true
  const content = Array.isArray(record?.content) ? record.content : []
  const rendered = content.map(renderMcpContent).filter((item) => item.length > 0)
  if (record && "structuredContent" in record) {
    rendered.push(boundedJson(record.structuredContent))
  }
  return {
    isError,
    content: rendered.length > 0 ? rendered.join("\n") : boundedJson(value),
  }
}

function renderMcpContent(value: unknown): string {
  const record = value as Record<string, unknown>
  if (record && typeof record === "object" && record.type === "text" && typeof record.text === "string") {
    return record.text
  }
  if (record && typeof record === "object" && (record.type === "image" || record.type === "resource")) {
    return `[unsupported MCP ${String(record.type)} content]`
  }
  return boundedJson(value)
}

function normalizeSchema(value: unknown): JsonSchema {
  if (value && typeof value === "object") return value as JsonSchema
  return { type: "object", additionalProperties: true }
}

function sanitizeMcpName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
  if (!sanitized) throw new Error(`Invalid MCP name after sanitization: ${value}`)
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized
}

function redactConfig(config: McpServerConfig): unknown {
  return {
    name: config.name,
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd,
    startupTimeoutMs: config.startupTimeoutMs,
    callTimeoutMs: config.callTimeoutMs,
    envKeys: Object.keys(config.env ?? {}).sort(),
  }
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function boundedJson(value: unknown): string {
  return capMiddle(stableJson(value), 8192)
}

function byteLength(value: string | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0
}

function capMiddle(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= maxBytes) return value
  const half = Math.max(0, Math.floor((maxBytes - 64) / 2))
  return `${value.slice(0, half)}\n[truncated: capped at ${maxBytes} bytes]\n${value.slice(-half)}`
}
