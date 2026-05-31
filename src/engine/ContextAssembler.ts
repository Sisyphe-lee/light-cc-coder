import { createHash } from "node:crypto"
import { join } from "node:path"
import { loadRootAgentsMd, type AgentsMdContext } from "../context/agentsMd"
import { estimateProviderRequestTokens } from "../context/contextBudget"
import type { ProviderMessage } from "../providers/types"
import {
  projectMessagesWithDiagnostics,
  type HistoryProjectionDiagnostics,
  type HistorySnipOptions,
} from "./messageProjection"
import type {
  AssembledProviderRequest,
  AssembleStepInput,
  ContextSessionSnapshot,
  ContextSnapshot,
  ContextSourceKind,
  ContextSourceSnapshot,
  ContextSourceStatus,
} from "./contextTypes"

export type ContextAssemblerOptions = {
  sessionId: string
  cwd: string
  now: () => string
  getToolSchemas?: () => unknown[] | undefined
  historySnip?: HistorySnipOptions
}

export type CompactContextSnapshot = {
  compactId: string
  summaryHash: string
  messageCount: number
}

export const GLOBAL_SYSTEM_PROMPT = [
  "You are light-cc-coder, a lightweight coding agent running in a terminal.",
  "",
  "# Operating Principles",
  "Work in real repositories. Inspect relevant files before editing. Prefer concrete observations over speculation. Treat project instructions supplied in context as authoritative.",
  "",
  "# Working With Code",
  "Use dedicated read, search, and edit tools before shell fallbacks. Make small, auditable edits that preserve local style and ownership boundaries. Avoid unrelated refactors.",
  "",
  "# Tools and Recovery",
  "Tool errors are information. Adjust your approach and continue from observed results. After changing code, verify with targeted commands when available, and say when verification is unavailable.",
  "",
  "# Safety and Communication",
  "Do not intentionally access secrets or credentials. Do not write outside the workspace. Prompt text is not a substitute for tool and runtime enforcement. Be concise and factual; report changed files, verification, and blockers.",
].join("\n")

const SOURCE_ORDER: ContextSourceKind[] = [
  "global_system_prompt",
  "user_prompt_slot",
  "runtime_facts",
  "project_instructions",
  "memory_slot",
  "git_slot",
  "skills_slot",
  "mcp_slot",
  "compact_slot",
  "history_projection",
  "tool_schemas",
]

type InitializedContext = {
  createdAt: string
  agentsMd?: AgentsMdContext
  agentsMdError?: string
  runtimeFacts: string
  prefixMessages: ProviderMessage[]
  stablePrefixHash: string
  initialToolSchemas?: unknown[]
  initialToolSchemaHash?: string
  sessionSnapshot: ContextSessionSnapshot
}

export class ContextAssembler {
  private initialized?: InitializedContext
  private compactSnapshot?: CompactContextSnapshot

  constructor(private readonly options: ContextAssemblerOptions) {}

  setCompactSnapshot(snapshot: CompactContextSnapshot | undefined): void {
    this.compactSnapshot = snapshot ? { ...snapshot } : undefined
  }

  async initialize(): Promise<ContextSessionSnapshot> {
    if (this.initialized) return cloneSessionSnapshot(this.initialized.sessionSnapshot)

    const createdAt = this.options.now()
    let agentsMd: AgentsMdContext | undefined
    let agentsMdError: string | undefined
    try {
      agentsMd = await loadRootAgentsMd(this.options.cwd)
    } catch (error) {
      agentsMdError = error instanceof Error ? error.message : String(error)
    }

    const runtimeFacts = renderRuntimeFacts({ cwd: this.options.cwd, createdAt })
    const prefixMessages = renderPrefixMessages({ runtimeFacts, agentsMd })
    const stablePrefixHash = hashStable(prefixMessages)
    const initialToolSchemas = this.getToolSchemas()
    const initialToolSchemaHash = toolSchemaHash(initialToolSchemas)
    const sources = this.buildSources({
      agentsMd,
      agentsMdError,
      runtimeFacts,
      historyMessages: [],
      toolSchemas: initialToolSchemas,
      toolSchemaHash: initialToolSchemaHash,
    })

    const sessionSnapshot: ContextSessionSnapshot = {
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      createdAt,
      sources,
      stablePrefixHash,
      toolSchemaHash: initialToolSchemaHash,
    }

    this.initialized = {
      createdAt,
      agentsMd,
      agentsMdError,
      runtimeFacts,
      prefixMessages,
      stablePrefixHash,
      initialToolSchemas,
      initialToolSchemaHash,
      sessionSnapshot,
    }
    return cloneSessionSnapshot(sessionSnapshot)
  }

  assembleStep(input: AssembleStepInput): AssembledProviderRequest {
    const context = this.requireInitialized()
    const projectedHistory = projectMessagesWithDiagnostics(input.messages, { snip: this.options.historySnip })
    const historyMessages = projectedHistory.messages
    const toolSchemas = this.getToolSchemas()
    const currentToolSchemaHash = toolSchemaHash(toolSchemas)
    const messages = [...context.prefixMessages, ...historyMessages]
    const sources = this.buildSources({
      agentsMd: context.agentsMd,
      agentsMdError: context.agentsMdError,
      runtimeFacts: context.runtimeFacts,
      historyMessages,
      historyDiagnostics: projectedHistory.diagnostics,
      toolSchemas,
      toolSchemaHash: currentToolSchemaHash,
    })
    const historyHash = hashStable(historyMessages)
    const estimatedTokens = estimateProviderRequestTokens({ messages, tools: toolSchemas })
    const snapshot: ContextSnapshot = {
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      createdAt: context.createdAt,
      turnId: input.turnId,
      stepId: input.stepId,
      sources,
      stablePrefixHash: context.stablePrefixHash,
      toolSchemaHash: currentToolSchemaHash,
      toolSchemaChanged: currentToolSchemaHash !== context.initialToolSchemaHash,
      historyHash,
      historyMessageCount: historyMessages.length,
      prefixMessageCount: context.prefixMessages.length,
      providerMessageCount: messages.length,
      requestHash: hashStable({ messages, tools: toolSchemas ?? null }),
      estimatedTokens,
      historySnippedToolResults: projectedHistory.diagnostics.snippedToolResults,
      historySnippedBytes: projectedHistory.diagnostics.snippedBytes,
    }

    return { messages, tools: toolSchemas, snapshot }
  }

  private requireInitialized(): InitializedContext {
    if (!this.initialized) {
      throw new Error("ContextAssembler.initialize() must be called before assembleStep()")
    }
    return this.initialized
  }

  private getToolSchemas(): unknown[] | undefined {
    const schemas = this.options.getToolSchemas?.()
    return schemas ? schemas.slice() : undefined
  }

  private buildSources(input: {
    agentsMd?: AgentsMdContext
    agentsMdError?: string
    runtimeFacts: string
    historyMessages: ProviderMessage[]
    historyDiagnostics?: HistoryProjectionDiagnostics
    toolSchemas?: unknown[]
    toolSchemaHash?: string
  }): ContextSourceSnapshot[] {
    return [
      source("global_system_prompt", "light-cc-coder/global-system-prompt", "included", GLOBAL_SYSTEM_PROMPT),
      emptySlot("user_prompt_slot", "reserved/user-prompt"),
      source("runtime_facts", "session/runtime-facts", "included", input.runtimeFacts),
      projectInstructionsSource(this.options.cwd, input.agentsMd, input.agentsMdError),
      emptySlot("memory_slot", "reserved/memory"),
      emptySlot("git_slot", "reserved/git"),
      emptySlot("skills_slot", "reserved/skills"),
      emptySlot("mcp_slot", "reserved/mcp"),
      compactSource(this.compactSnapshot),
      historySource(input.historyMessages, input.historyDiagnostics),
      toolSchemasSource(input.toolSchemas, input.toolSchemaHash),
    ]
  }
}

export function renderRuntimeFacts(input: { cwd: string; createdAt: string }): string {
  return [
    "# Session Snapshot",
    `Workspace root (snapshot): ${input.cwd}`,
    `Session started at (snapshot): ${input.createdAt}`,
  ].join("\n")
}

export function renderProjectInstructions(agentsMd: AgentsMdContext): string {
  const sections = ["<system-reminder>", "Project instructions from AGENTS.md:", "", agentsMd.content]
  if (agentsMd.truncated) {
    sections.push("", `[truncated: AGENTS.md capped at ${agentsMd.maxBytes} bytes]`)
  }
  sections.push("</system-reminder>")
  return sections.join("\n")
}

function renderPrefixMessages(input: { runtimeFacts: string; agentsMd?: AgentsMdContext }): ProviderMessage[] {
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content: `${GLOBAL_SYSTEM_PROMPT}\n\n${input.runtimeFacts}`,
    },
  ]

  if (input.agentsMd && input.agentsMd.content.length > 0) {
    messages.push({
      role: "user",
      content: renderProjectInstructions(input.agentsMd),
    })
  }

  return messages
}

function source(
  kind: ContextSourceKind,
  id: string,
  status: ContextSourceStatus,
  content: string,
  extra: Omit<Partial<ContextSourceSnapshot>, "kind" | "id" | "status" | "order" | "bytes" | "hash"> = {},
): ContextSourceSnapshot {
  return {
    kind,
    id,
    status,
    order: sourceOrder(kind),
    bytes: byteLength(content),
    hash: hashText(content),
    ...extra,
  }
}

function emptySlot(kind: ContextSourceKind, id: string): ContextSourceSnapshot {
  return {
    kind,
    id,
    status: "empty",
    order: sourceOrder(kind),
    bytes: 0,
    note: "reserved for a later phase",
  }
}

function projectInstructionsSource(
  cwd: string,
  agentsMd: AgentsMdContext | undefined,
  error: string | undefined,
): ContextSourceSnapshot {
  const path = join(cwd, "AGENTS.md")
  if (error) {
    return {
      kind: "project_instructions",
      id: "project/root-agents-md",
      status: "error",
      order: sourceOrder("project_instructions"),
      bytes: 0,
      path,
      note: error,
    }
  }
  if (!agentsMd) {
    return {
      kind: "project_instructions",
      id: "project/root-agents-md",
      status: "missing",
      order: sourceOrder("project_instructions"),
      bytes: 0,
      path,
    }
  }
  if (agentsMd.content.length === 0) {
    return {
      kind: "project_instructions",
      id: "project/root-agents-md",
      status: "empty",
      order: sourceOrder("project_instructions"),
      bytes: 0,
      hash: agentsMd.hash,
      path,
    }
  }
  return source(
    "project_instructions",
    "project/root-agents-md",
    agentsMd.truncated ? "truncated" : "included",
    renderProjectInstructions(agentsMd),
    {
      path,
      note: agentsMd.truncated
        ? `read ${agentsMd.bytes} of ${agentsMd.originalBytes} bytes`
        : `read ${agentsMd.bytes} bytes`,
    },
  )
}

function compactSource(snapshot: CompactContextSnapshot | undefined): ContextSourceSnapshot {
  if (!snapshot) return emptySlot("compact_slot", "reserved/compact")
  return {
    kind: "compact_slot",
    id: "session/latest-compact",
    status: "included",
    order: sourceOrder("compact_slot"),
    bytes: 0,
    hash: snapshot.summaryHash,
    note: `${snapshot.compactId}; active messages=${snapshot.messageCount}`,
  }
}

function historySource(
  messages: ProviderMessage[],
  diagnostics: HistoryProjectionDiagnostics | undefined,
): ContextSourceSnapshot {
  const content = stableJson(messages)
  const noteParts = [`${messages.length} provider messages`]
  if (diagnostics && diagnostics.snippedToolResults > 0) {
    noteParts.push(
      `${diagnostics.snippedToolResults} old tool results snipped (${diagnostics.snippedBytes} original bytes)`,
    )
  }
  return {
    kind: "history_projection",
    id: "history/projected-messages",
    status: messages.length === 0 ? "empty" : "included",
    order: sourceOrder("history_projection"),
    bytes: byteLength(content),
    hash: hashText(content),
    note: noteParts.join("; "),
  }
}

function toolSchemasSource(schemas: unknown[] | undefined, hash: string | undefined): ContextSourceSnapshot {
  if (!schemas) {
    return {
      kind: "tool_schemas",
      id: "tools/provider-schemas",
      status: "empty",
      order: sourceOrder("tool_schemas"),
      bytes: 0,
      note: "tool runtime did not expose schemas",
    }
  }
  const content = stableJson(schemas)
  return {
    kind: "tool_schemas",
    id: "tools/provider-schemas",
    status: schemas.length === 0 ? "empty" : "included",
    order: sourceOrder("tool_schemas"),
    bytes: byteLength(content),
    hash,
    note: `${schemas.length} tools`,
  }
}

function sourceOrder(kind: ContextSourceKind): number {
  const index = SOURCE_ORDER.indexOf(kind)
  if (index === -1) throw new Error(`Unknown context source kind: ${kind}`)
  return index + 1
}

function toolSchemaHash(schemas: unknown[] | undefined): string | undefined {
  return schemas ? hashStable(schemas) : undefined
}

function hashStable(value: unknown): string {
  return hashText(stableJson(value))
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function cloneSessionSnapshot(snapshot: ContextSessionSnapshot): ContextSessionSnapshot {
  return {
    ...snapshot,
    sources: snapshot.sources.map((source) => ({ ...source })),
  }
}
