import type { AssistantMessage } from "../core/messages"

export type ProviderToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ProviderToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export type ProviderRequest = {
  messages: ProviderMessage[]
  tools?: unknown[]
  sessionId?: string
  turnId?: string
  stepId?: string
}

// Bounded numeric usage counters. Profiling-only; never carries raw provider
// payload. Fields are absent when the provider does not report them.
export type ProviderUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "assistant_message"; message: AssistantMessage }
  | { type: "error"; error: string }

export interface Provider {
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}
