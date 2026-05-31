import { createHash } from "node:crypto"
import { ProjectionError } from "../core/errors"
import { makeUserMessage, type InternalMessage, type UserMessage } from "../core/messages"
import { projectMessages } from "../engine/messageProjection"
import type { ProviderMessage } from "../providers/types"
import { estimateMessagesTokens, estimateTokens } from "./contextBudget"

export type CompactTrigger = "manual" | "auto" | "overflow_retry"

export type TailSelection = {
  tailStartIndex: number
  tailStartMessageId?: string
  summarizedMessages: InternalMessage[]
  tailMessages: InternalMessage[]
}

export type CompactPrompt = {
  messages: ProviderMessage[]
  omittedOldestGroups: number
  inputTokens: number
}

export type CompactSummary = {
  message: UserMessage
  summaryHash: string
}

export const DEFAULT_COMPACT_TAIL_MESSAGES = 24

export function selectPairingSafeTail(
  messages: InternalMessage[],
  recentMessageCount = DEFAULT_COMPACT_TAIL_MESSAGES,
): TailSelection {
  projectMessages(messages)
  if (messages.length === 0) {
    return { tailStartIndex: 0, summarizedMessages: [], tailMessages: [] }
  }
  const groups = groupMessages(messages)
  const candidate = Math.max(0, messages.length - recentMessageCount)
  const group = groups.find((item) => candidate >= item.start && candidate < item.end)
  const tailStartIndex = group?.start ?? 0
  return {
    tailStartIndex,
    tailStartMessageId: messages[tailStartIndex]?.id,
    summarizedMessages: messages.slice(0, tailStartIndex),
    tailMessages: messages.slice(tailStartIndex),
  }
}

export function buildCompactPrompt(input: {
  messages: InternalMessage[]
  instruction?: string
  omittedOldestGroups?: number
}): CompactPrompt {
  const omittedOldestGroups = input.omittedOldestGroups ?? 0
  const sections = [
    "Summarize the previous coding-session history into a compact checkpoint.",
    "",
    "Preserve task goals, explicit user constraints, project instructions that affected behavior, files read, files changed, important commands and outcomes, failed commands or denials, decisions already made, and the current next step.",
    "Do not invent facts. Keep the summary concise but sufficient for continuing the session.",
  ]
  if (input.instruction) {
    sections.push("", `Additional compact instruction: ${input.instruction}`)
  }
  if (omittedOldestGroups > 0) {
    sections.push(
      "",
      `Note: ${omittedOldestGroups} oldest complete message groups were omitted from this compact input because it was too large.`,
    )
  }

  const history = renderMessagesForCompact(input.messages)
  const messages: ProviderMessage[] = [
    { role: "system", content: sections.join("\n") },
    {
      role: "user",
      content: [
        "Compact this earlier conversation history:",
        "",
        history.length > 0 ? history : "[no compactable prior messages]",
      ].join("\n"),
    },
  ]
  return {
    messages,
    omittedOldestGroups,
    inputTokens: estimateMessagesTokens(messages),
  }
}

export function dropOldestCompleteGroup(messages: InternalMessage[]): { messages: InternalMessage[]; dropped: boolean } {
  projectMessages(messages)
  const groups = groupMessages(messages)
  if (groups.length === 0) return { messages, dropped: false }
  const first = groups[0]
  return { messages: messages.slice(first.end), dropped: true }
}

export function makeCompactSummaryMessage(input: {
  id: string
  summary: string
  omittedOldestGroups?: number
}): CompactSummary {
  const lines = [
    "<system-reminder>",
    "Conversation compacted. Summary of earlier work:",
    "",
    input.summary.trim() || "No prior summary was provided.",
  ]
  if ((input.omittedOldestGroups ?? 0) > 0) {
    lines.push(
      "",
      `[compact note: ${input.omittedOldestGroups} oldest complete message groups were omitted from the compact input because it exceeded the context budget]`,
    )
  }
  lines.push("</system-reminder>")
  const content = lines.join("\n")
  return {
    message: makeUserMessage(input.id, content),
    summaryHash: createHash("sha256").update(content).digest("hex"),
  }
}

export function estimateInternalMessagesTokens(messages: InternalMessage[]): number {
  return estimateTokens(renderMessagesForCompact(messages))
}

function groupMessages(messages: InternalMessage[]): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === "tool") {
      throw new ProjectionError(`Tail grouping found orphan tool result for call ${message.toolCallId}`)
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      const end = index + 1 + message.toolCalls.length
      groups.push({ start: index, end })
      index = end - 1
      continue
    }
    groups.push({ start: index, end: index + 1 })
  }
  return groups
}

function renderMessagesForCompact(messages: InternalMessage[]): string {
  return messages
    .map((message, index) => {
      if (message.role === "user") {
        return `#${index + 1} user ${message.id}\n${message.content}`
      }
      if (message.role === "assistant") {
        const calls =
          message.toolCalls.length > 0
            ? `\nTool calls: ${message.toolCalls.map((call) => `${call.name}(${call.id})`).join(", ")}`
            : ""
        return `#${index + 1} assistant ${message.id}\n${message.content}${calls}`
      }
      return `#${index + 1} tool ${message.toolName} ${message.toolCallId} error=${message.isError}\n${message.content}`
    })
    .join("\n\n")
}
