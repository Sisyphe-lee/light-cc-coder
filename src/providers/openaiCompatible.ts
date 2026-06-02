import { makeAssistantMessage, type TokenUsage, type ToolCall } from "../core/messages"
import { invalidToolInput } from "../tools/ToolRuntime"
import type { ModelEvent, Provider, ProviderRequest, ProviderUsage } from "./types"

export type OpenAICompatibleProviderOptions = {
  baseUrl: string
  apiKey: string
  model: string
  fetch?: FetchLike
  // Opt-in (profiling only): request and surface bounded usage/cache token
  // counters. Off by default so normal runs send the same wire request as before.
  includeUsage?: boolean
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type ToolCallAccumulator = {
  index: number
  id?: string
  name?: string
  arguments: string
}

export class OpenAICompatibleProvider implements Provider {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: FetchLike
  private readonly includeUsage: boolean

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.apiKey = options.apiKey
    this.model = options.model
    this.fetchImpl = options.fetch ?? fetch
    this.includeUsage = options.includeUsage ?? false
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      tools: request.tools,
      stream: true,
    }
    if (this.includeUsage) body.stream_options = { include_usage: true }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(`OpenAI-compatible provider request failed: ${response.status} ${detail}`.trim())
    }

    const content: string[] = []
    const toolCalls = new Map<number, ToolCallAccumulator>()
    let usage: ProviderUsage | undefined
    let messageUsage: TokenUsage | undefined
    for await (const event of readSse(response.body, signal)) {
      if (event === "[DONE]") break
      let parsed: OpenAIStreamChunk
      try {
        parsed = JSON.parse(event) as OpenAIStreamChunk
      } catch {
        continue
      }
      if ("error" in parsed) {
        throw new Error(parsed.error.message)
      }
      if (this.includeUsage && parsed.usage) {
        usage = extractUsage(parsed.usage)
        messageUsage = normalizeUsage(parsed.usage)
      }
      const choice = parsed.choices?.[0]
      const delta = choice?.delta
      if (!delta) continue
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content.push(delta.content)
        yield { type: "text_delta", text: delta.content }
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index
        const existing: ToolCallAccumulator = toolCalls.get(index) ?? { index, arguments: "" }
        if (call.id) existing.id = call.id
        if (call.function?.name) existing.name = call.function.name
        if (call.function?.arguments) existing.arguments += call.function.arguments
        toolCalls.set(index, existing)
      }
    }

    if (usage) {
      yield { type: "usage", usage }
    }

    yield {
      type: "assistant_message",
      message: makeAssistantMessage({
        id: `${request.stepId ?? "assistant"}_message`,
        content: content.join(""),
        usage: messageUsage,
        toolCalls: Array.from(toolCalls.values())
          .sort((left, right) => left.index - right.index)
          .map((item) => toToolCall(item)),
      }),
    }
  }
}

function normalizeUsage(usage: OpenAIUsage): TokenUsage {
  return {
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    promptCacheHitTokens:
      numberOrUndefined(usage.prompt_cache_hit_tokens) ??
      numberOrUndefined(usage.prompt_tokens_details?.cached_tokens),
    promptCacheMissTokens: numberOrUndefined(usage.prompt_cache_miss_tokens),
    reasoningTokens: numberOrUndefined(usage.completion_tokens_details?.reasoning_tokens),
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    if (signal.aborted) throw new Error(String(signal.reason ?? "aborted"))
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let splitAt: number
    while ((splitAt = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, splitAt)
      buffer = buffer.slice(splitAt + 2)
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (data.length > 0) yield data
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith("data:")) yield tail.slice(5).trimStart()
}

function toToolCall(item: ToolCallAccumulator): ToolCall {
  return {
    id: item.id ?? `tool_call_${item.index}`,
    name: item.name ?? "",
    input: parseToolArguments(item.arguments),
  }
}

function parseToolArguments(raw: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    return invalidToolInput(raw, error instanceof Error ? error.message : String(error))
  }
}

// Extract only bounded numeric counters. Never retain the raw usage object.
function extractUsage(raw: OpenAIUsage): ProviderUsage | undefined {
  const usage: ProviderUsage = {}
  if (isFiniteNumber(raw.prompt_tokens)) usage.inputTokens = raw.prompt_tokens
  if (isFiniteNumber(raw.completion_tokens)) usage.outputTokens = raw.completion_tokens
  if (isFiniteNumber(raw.total_tokens)) usage.totalTokens = raw.total_tokens
  const cachedRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens
  if (isFiniteNumber(cachedRead)) usage.cacheReadInputTokens = cachedRead
  return Object.keys(usage).length > 0 ? usage : undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

type OpenAIUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

type OpenAIStreamChunk =
  | {
      choices?: Array<{
        delta?: {
          content?: string
          tool_calls?: Array<{
            index: number
            id?: string
            function?: {
              name?: string
              arguments?: string
            }
          }>
        }
      }>
      usage?: OpenAIUsage | null
    }
  | { error: { message: string } }
