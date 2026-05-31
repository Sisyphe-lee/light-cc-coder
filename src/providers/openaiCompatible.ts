import { makeAssistantMessage, type ToolCall } from "../core/messages"
import { invalidToolInput } from "../tools/ToolRuntime"
import type { ModelEvent, Provider, ProviderRequest } from "./types"

export type OpenAICompatibleProviderOptions = {
  baseUrl: string
  apiKey: string
  model: string
  fetch?: FetchLike
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

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.apiKey = options.apiKey
    this.model = options.model
    this.fetchImpl = options.fetch ?? fetch
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        tools: request.tools,
        stream: true,
      }),
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(`OpenAI-compatible provider request failed: ${response.status} ${detail}`.trim())
    }

    const content: string[] = []
    const toolCalls = new Map<number, ToolCallAccumulator>()
    for await (const event of readSse(response.body, signal)) {
      if (event === "[DONE]") break
      const parsed = JSON.parse(event) as OpenAIStreamChunk
      if ("error" in parsed) {
        throw new Error(parsed.error.message)
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

    yield {
      type: "assistant_message",
      message: makeAssistantMessage({
        id: `${request.stepId ?? "assistant"}_message`,
        content: content.join(""),
        toolCalls: Array.from(toolCalls.values())
          .sort((left, right) => left.index - right.index)
          .map((item) => toToolCall(item)),
      }),
    }
  }
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
    }
  | { error: { message: string } }
