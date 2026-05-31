import { ProjectionError } from "../core/errors"
import type { AssistantMessage, InternalMessage, ToolCall, ToolResultMessage } from "../core/messages"
import type { ProviderMessage, ProviderToolCall } from "../providers/types"

export function projectMessages(messages: InternalMessage[]): ProviderMessage[] {
  const projected: ProviderMessage[] = []
  let pending: ToolCall[] = []
  const seenToolResults = new Set<string>()

  for (const message of messages) {
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
      projected.push(projectToolResult(message))
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

  return projected
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

function projectToolResult(message: ToolResultMessage): ProviderMessage {
  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: message.content,
  }
}
