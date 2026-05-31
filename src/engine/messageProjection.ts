import { ProjectionError } from "../core/errors"
import type { AssistantMessage, InternalMessage, ToolCall, ToolResultMessage } from "../core/messages"
import type { ProviderMessage, ProviderToolCall } from "../providers/types"

export type HistorySnipOptions = {
  enabled?: boolean
  recentMessageCount?: number
  minToolResultBytes?: number
  minErrorToolResultBytes?: number
}

export type HistoryProjectionDiagnostics = {
  projectedMessageCount: number
  snippedToolResults: number
  snippedBytes: number
  recentTailStartIndex: number
  recentMessageCount: number
}

export type MessageProjectionOptions = {
  snip?: HistorySnipOptions
}

export type MessageProjectionResult = {
  messages: ProviderMessage[]
  diagnostics: HistoryProjectionDiagnostics
}

export function projectMessages(messages: InternalMessage[], options: MessageProjectionOptions = {}): ProviderMessage[] {
  return projectMessagesWithDiagnostics(messages, options).messages
}

export function projectMessagesWithDiagnostics(
  messages: InternalMessage[],
  options: MessageProjectionOptions = {},
): MessageProjectionResult {
  const projected: ProviderMessage[] = []
  let pending: ToolCall[] = []
  const seenToolResults = new Set<string>()
  const snipOptions = normalizeSnipOptions(options.snip)
  const recentTailStartIndex = Math.max(0, messages.length - snipOptions.recentMessageCount)
  let snippedToolResults = 0
  let snippedBytes = 0

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === "tool") {
      if (seenToolResults.has(message.toolCallId)) {
        throw new ProjectionError(`Duplicate tool result for call ${message.toolCallId}`)
      }
      if (pending.length === 0) {
        throw new ProjectionError(`Orphan tool result for call ${message.toolCallId}`)
      }
      const expected = pending[0]
      if (message.toolCallId !== expected.id) {
        const stillPending = pending.some((call) => call.id === message.toolCallId)
        if (stillPending) {
          throw new ProjectionError(
            `Reordered tool result for call ${message.toolCallId}; expected ${expected.id}`,
          )
        }
        throw new ProjectionError(`Orphan tool result for call ${message.toolCallId}`)
      }
      seenToolResults.add(message.toolCallId)
      pending = pending.slice(1)
      const projectedResult = projectToolResult(message, shouldSnipToolResult(message, index, recentTailStartIndex, snipOptions))
      if (projectedResult.snipped) {
        snippedToolResults += 1
        snippedBytes += byteLength(message.content)
      }
      projected.push(projectedResult.message)
      continue
    }

    if (pending.length > 0) {
      throw new ProjectionError(`Missing tool result for call ${pending[0].id}`)
    }

    if (message.role === "user") {
      projected.push({ role: "user", content: message.content })
      continue
    }

    projected.push(projectAssistant(message))
    pending = message.toolCalls.slice()
  }

  if (pending.length > 0) {
    throw new ProjectionError(`Missing tool result for call ${pending[0].id}`)
  }

  return {
    messages: projected,
    diagnostics: {
      projectedMessageCount: projected.length,
      snippedToolResults,
      snippedBytes,
      recentTailStartIndex,
      recentMessageCount: snipOptions.recentMessageCount,
    },
  }
}

function projectAssistant(message: AssistantMessage): ProviderMessage {
  if (message.toolCalls.length === 0) {
    return { role: "assistant", content: message.content }
  }
  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.toolCalls.map(projectToolCall),
  }
}

function projectToolCall(call: ToolCall): ProviderToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.input ?? null),
    },
  }
}

function projectToolResult(message: ToolResultMessage, snip: boolean): { message: ProviderMessage; snipped: boolean } {
  return {
    message: {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: snip
        ? `[snipped old tool result: ${message.toolName}, original bytes=${byteLength(message.content)}, kept in transcript]`
        : message.content,
    },
    snipped: snip,
  }
}

function normalizeSnipOptions(options: HistorySnipOptions | undefined): Required<HistorySnipOptions> {
  return {
    enabled: options?.enabled ?? false,
    recentMessageCount: options?.recentMessageCount ?? 24,
    minToolResultBytes: options?.minToolResultBytes ?? 16 * 1024,
    minErrorToolResultBytes: options?.minErrorToolResultBytes ?? 64 * 1024,
  }
}

function shouldSnipToolResult(
  message: ToolResultMessage,
  index: number,
  recentTailStartIndex: number,
  options: Required<HistorySnipOptions>,
): boolean {
  if (!options.enabled) return false
  if (index >= recentTailStartIndex) return false
  const threshold = message.isError ? options.minErrorToolResultBytes : options.minToolResultBytes
  return byteLength(message.content) > threshold
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
