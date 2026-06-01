import { createHash } from "node:crypto"
import { join } from "node:path"
import { loadRootAgentsMd, type AgentsMdContext } from "../context/agentsMd"
import { estimateProviderRequestTokens } from "../context/contextBudget"
import { renderSkillsContext, type SkillSnapshot } from "../extensions/skills"
import type { McpContextSnapshot } from "../extensions/mcp"
import type { PermissionMode } from "../permissions/types"
import type { OsSandboxMode } from "../runtime/sandbox/config"
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
  getRuntimeContext?: () => RuntimeContextFacts | undefined
  getToolSchemas?: () => unknown[] | undefined
  getActiveSkills?: () => SkillSnapshot[]
  getMcpContext?: () => McpContextSnapshot | undefined
  getTodoContext?: () => string
  historySnip?: HistorySnipOptions
}

export type RuntimeContextFacts = {
  permissionMode?: PermissionMode
  osSandbox?: {
    mode: OsSandboxMode
    status?: "off" | "not_initialized" | "active" | "fallback" | "unavailable"
    fallbackReason?: string
    settingsPath?: string
    allowDomains?: string[]
    allowWrites?: string[]
  }
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
  "todo_slot",
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
  activeSkills: SkillSnapshot[]
  skillsContent: string
  mcpContext?: McpContextSnapshot
  mcpContent: string
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

    const runtimeFacts = this.renderCurrentRuntimeFacts(createdAt)
    const activeSkills = this.getActiveSkills()
    const skillsContent = renderSkillsContext(activeSkills)
    const mcpContext = this.options.getMcpContext?.()
    const mcpContent = renderMcpContext(mcpContext)
    const basePrefixMessages = renderBasePrefixMessages({ runtimeFacts, agentsMd })
    const stablePrefixMessages = [...basePrefixMessages, ...renderStaticExtensionMessages({ skillsContent, mcpContent })]
    const stablePrefixHash = hashStable(stablePrefixMessages)
    const initialToolSchemas = this.getToolSchemas()
    const initialToolSchemaHash = toolSchemaHash(initialToolSchemas)
    const sources = this.buildSources({
      agentsMd,
      agentsMdError,
      runtimeFacts,
      todoContext: this.getTodoContext(),
      activeSkills,
      skillsContent,
      mcpContext,
      mcpContent,
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
      activeSkills,
      skillsContent,
      mcpContext,
      mcpContent,
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
    const todoContext = this.getTodoContext()
    const runtimeFacts = this.renderCurrentRuntimeFacts(context.createdAt)
    const basePrefixMessages = renderBasePrefixMessages({ runtimeFacts, agentsMd: context.agentsMd })
    const dynamicPrefixMessages = renderDynamicExtensionMessages({
      todoContext,
      skillsContent: context.skillsContent,
      mcpContent: context.mcpContent,
    })
    const stablePrefixMessages = [...basePrefixMessages, ...renderStaticExtensionMessages({
      skillsContent: context.skillsContent,
      mcpContent: context.mcpContent,
    })]
    const currentStablePrefixHash = hashStable(stablePrefixMessages)
    const messages = [...basePrefixMessages, ...dynamicPrefixMessages, ...historyMessages]
    const sources = this.buildSources({
      agentsMd: context.agentsMd,
      agentsMdError: context.agentsMdError,
      runtimeFacts,
      todoContext,
      activeSkills: context.activeSkills,
      skillsContent: context.skillsContent,
      mcpContext: context.mcpContext,
      mcpContent: context.mcpContent,
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
      stablePrefixHash: currentStablePrefixHash,
      toolSchemaHash: currentToolSchemaHash,
      toolSchemaChanged: currentToolSchemaHash !== context.initialToolSchemaHash,
      historyHash,
      historyMessageCount: historyMessages.length,
      prefixMessageCount: basePrefixMessages.length + dynamicPrefixMessages.length,
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
    todoContext?: string
    activeSkills?: SkillSnapshot[]
    skillsContent?: string
    mcpContext?: McpContextSnapshot
    mcpContent?: string
  }): ContextSourceSnapshot[] {
    return [
      source("global_system_prompt", "light-cc-coder/global-system-prompt", "included", GLOBAL_SYSTEM_PROMPT),
      emptySlot("user_prompt_slot", "reserved/user-prompt"),
      source("runtime_facts", "session/runtime-facts", "included", input.runtimeFacts),
      projectInstructionsSource(this.options.cwd, input.agentsMd, input.agentsMdError),
      emptySlot("memory_slot", "reserved/memory"),
      todoSource(input.todoContext ?? ""),
      emptySlot("git_slot", "reserved/git"),
      skillsSource(input.activeSkills ?? [], input.skillsContent ?? ""),
      mcpSource(input.mcpContext, input.mcpContent ?? ""),
      compactSource(this.compactSnapshot),
      historySource(input.historyMessages, input.historyDiagnostics),
      toolSchemasSource(input.toolSchemas, input.toolSchemaHash),
    ]
  }

  private getActiveSkills(): SkillSnapshot[] {
    return this.options.getActiveSkills?.().slice() ?? []
  }

  private getTodoContext(): string {
    return this.options.getTodoContext?.() ?? ""
  }

  private renderCurrentRuntimeFacts(createdAt: string): string {
    return renderRuntimeFacts({
      cwd: this.options.cwd,
      createdAt,
      facts: this.options.getRuntimeContext?.(),
    })
  }
}

export function renderRuntimeFacts(input: { cwd: string; createdAt: string; facts?: RuntimeContextFacts }): string {
  const lines = [
    "# Session Snapshot",
    `Workspace root (snapshot): ${input.cwd}`,
    `Session started at (snapshot): ${input.createdAt}`,
  ]
  const permissionMode = input.facts?.permissionMode
  if (permissionMode) {
    lines.push("", "# Permission and Sandbox Context", `Permission mode: ${permissionMode}`)
    if (permissionMode === "read-only") {
      lines.push(
        "Allowed: read, grep, glob, and todo.",
        "Denied: edit, write, apply_patch, bash, and write-capable or opaque MCP tools.",
      )
    } else if (permissionMode === "workspace-write") {
      lines.push(
        "Allowed: workspace-scoped file tools and read-only tools.",
        "Requires approval: bash, except allowlisted git inspection commands; write-capable or opaque MCP tools.",
        "Always denied: sensitive paths and hard-denied shell commands.",
      )
    } else {
      lines.push(
        "Allowed: non-hard-denied tools without interactive approval.",
        "Still enforced: workspace path boundaries, sensitive path denies, hard-denied shell commands, and tool schemas.",
      )
    }
  }
  if (input.facts?.osSandbox) {
    const sandbox = input.facts.osSandbox
    lines.push(`OS sandbox mode: ${sandbox.mode}`)
    lines.push(`OS sandbox status: ${sandbox.status ?? (sandbox.mode === "off" ? "off" : "not_initialized")}`)
    if (sandbox.fallbackReason) lines.push(`OS sandbox fallback reason: ${sandbox.fallbackReason}`)
    if (sandbox.mode === "auto") {
      lines.push("Auto mode may fall back to unsandboxed LocalRuntime if the backend is unavailable.")
    } else if (sandbox.mode === "required") {
      lines.push("Required mode fails closed when the sandbox backend is unavailable.")
    } else {
      lines.push("OS sandbox is disabled; shell commands use LocalRuntime after permission checks.")
    }
    lines.push(
      `Sandbox network allowlist: ${sandbox.allowDomains && sandbox.allowDomains.length > 0 ? sandbox.allowDomains.join(", ") : "none"}`,
      `Sandbox extra write allowlist: ${sandbox.allowWrites && sandbox.allowWrites.length > 0 ? sandbox.allowWrites.join(", ") : "none"}`,
    )
    if (sandbox.settingsPath) lines.push(`Sandbox settings path: ${sandbox.settingsPath}`)
  }
  return lines.join("\n")
}

export function renderProjectInstructions(agentsMd: AgentsMdContext): string {
  const sections = ["<system-reminder>", "Project instructions from AGENTS.md:", "", agentsMd.content]
  if (agentsMd.truncated) {
    sections.push("", `[truncated: AGENTS.md capped at ${agentsMd.maxBytes} bytes]`)
  }
  sections.push("</system-reminder>")
  return sections.join("\n")
}

function renderBasePrefixMessages(input: { runtimeFacts: string; agentsMd?: AgentsMdContext }): ProviderMessage[] {
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

function renderDynamicExtensionMessages(input: {
  todoContext: string
  skillsContent: string
  mcpContent: string
}): ProviderMessage[] {
  const messages: ProviderMessage[] = []
  if (input.todoContext.length > 0) {
    messages.push({ role: "user", content: wrapReminder("Session todo context:", input.todoContext) })
  }
  messages.push(...renderStaticExtensionMessages(input))
  return messages
}

function renderStaticExtensionMessages(input: { skillsContent: string; mcpContent: string }): ProviderMessage[] {
  const messages: ProviderMessage[] = []
  if (input.skillsContent.length > 0) {
    messages.push({ role: "user", content: wrapReminder("Active skill instructions:", input.skillsContent) })
  }
  if (input.mcpContent.length > 0) {
    messages.push({ role: "user", content: wrapReminder("MCP extension context:", input.mcpContent) })
  }
  return messages
}

function wrapReminder(title: string, content: string): string {
  return ["<system-reminder>", title, "", content, "</system-reminder>"].join("\n")
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

function todoSource(content: string): ContextSourceSnapshot {
  if (content.length === 0) return emptySlot("todo_slot", "session/todo")
  return source("todo_slot", "session/todo", "included", content)
}

function skillsSource(skills: SkillSnapshot[], content: string): ContextSourceSnapshot {
  if (skills.length === 0 || content.length === 0) return emptySlot("skills_slot", "reserved/skills")
  const truncated = skills.some((skill) => skill.truncated)
  return source("skills_slot", "session/active-skills", truncated ? "truncated" : "included", content, {
    note: `${skills.length} active skill${skills.length === 1 ? "" : "s"}`,
  })
}

function mcpSource(context: McpContextSnapshot | undefined, content: string): ContextSourceSnapshot {
  if (!context) return emptySlot("mcp_slot", "reserved/mcp")
  return {
    kind: "mcp_slot",
    id: "session/mcp",
    status: context.toolCount > 0 ? "included" : "empty",
    order: sourceOrder("mcp_slot"),
    bytes: byteLength(content),
    hash: context.configHash,
    note: `${context.servers.length} server${context.servers.length === 1 ? "" : "s"}; ${context.toolCount} tool${context.toolCount === 1 ? "" : "s"}`,
  }
}

function renderMcpContext(context: McpContextSnapshot | undefined): string {
  if (!context) return ""
  const lines = ["# MCP Servers", `Connected tools: ${context.toolCount}`, `Config hash: ${context.configHash}`]
  for (const server of context.servers) {
    const suffix = server.status === "failed" && server.error ? `; error=${server.error}` : ""
    lines.push(`- ${server.name}: ${server.status}, tools=${server.toolCount}, config=${server.configHash}${suffix}`)
  }
  return lines.join("\n")
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
