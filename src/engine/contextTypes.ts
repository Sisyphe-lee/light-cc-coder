import type { InternalMessage } from "../core/messages"
import type { ProviderMessage } from "../providers/types"

export type ContextSourceKind =
  | "global_system_prompt"
  | "user_prompt_slot"
  | "runtime_facts"
  | "project_instructions"
  | "tool_schemas"
  | "history_projection"
  | "memory_slot"
  | "todo_slot"
  | "git_slot"
  | "skills_slot"
  | "mcp_slot"
  | "compact_slot"

export type ContextSourceStatus = "included" | "empty" | "missing" | "truncated" | "error"

export type ContextSourceSnapshot = {
  kind: ContextSourceKind
  id: string
  status: ContextSourceStatus
  order: number
  bytes: number
  hash?: string
  path?: string
  note?: string
}

export type ContextSessionSnapshot = {
  sessionId: string
  cwd: string
  createdAt: string
  sources: ContextSourceSnapshot[]
  stablePrefixHash: string
  toolSchemaHash?: string
}

export type ContextSnapshot = {
  sessionId: string
  cwd: string
  createdAt: string
  turnId: string
  stepId: string
  sources: ContextSourceSnapshot[]
  stablePrefixHash: string
  toolSchemaHash?: string
  toolSchemaChanged: boolean
  historyHash: string
  historyMessageCount: number
  prefixMessageCount: number
  providerMessageCount: number
  requestHash: string
  estimatedTokens?: number
  historySnippedToolResults?: number
  historySnippedBytes?: number
}

export type AssembleStepInput = {
  turnId: string
  stepId: string
  messages: InternalMessage[]
}

export type AssembledProviderRequest = {
  messages: ProviderMessage[]
  tools?: unknown[]
  snapshot: ContextSnapshot
}
