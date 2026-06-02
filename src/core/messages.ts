export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  promptCacheHitTokens?: number
  promptCacheMissTokens?: number
  reasoningTokens?: number
}

export type UserMessage = {
  id: string
  role: "user"
  content: string
}

export type ToolCall = {
  id: string
  name: string
  input: unknown
}

export type AssistantMessage = {
  id: string
  role: "assistant"
  content: string
  toolCalls: ToolCall[]
  finishReason?: string
  usage?: TokenUsage
  raw?: unknown
}

export type ToolResultMessage = {
  id: string
  role: "tool"
  toolCallId: string
  toolName: string
  content: string
  isError: boolean
}

export type InternalMessage = UserMessage | AssistantMessage | ToolResultMessage

export type TurnState = {
  messages: InternalMessage[]
}

export function makeUserMessage(id: string, content: string): UserMessage {
  return { id, role: "user", content }
}

export function makeAssistantMessage(args: {
  id: string
  content?: string
  toolCalls?: ToolCall[]
  finishReason?: string
  usage?: TokenUsage
  raw?: unknown
}): AssistantMessage {
  return {
    id: args.id,
    role: "assistant",
    content: args.content ?? "",
    toolCalls: args.toolCalls ?? [],
    finishReason: args.finishReason,
    usage: args.usage,
    raw: args.raw,
  }
}

export function makeToolResultMessage(args: {
  id: string
  call: ToolCall
  content: string
  isError?: boolean
}): ToolResultMessage {
  return {
    id: args.id,
    role: "tool",
    toolCallId: args.call.id,
    toolName: args.call.name,
    content: args.content,
    isError: args.isError ?? false,
  }
}
