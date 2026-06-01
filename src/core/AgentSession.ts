import { AsyncEventQueue } from "./AsyncEventQueue"
import { ActiveTurnError } from "./errors"
import type { SessionEvent } from "./events"
import { makeUserMessage, type InternalMessage } from "./messages"
import type { SessionOp } from "./ops"
import { resolve } from "node:path"
import type { ContextBudgetInput } from "../context/contextBudget"
import { ToolArtifactStore } from "../context/toolArtifacts"
import { SessionEngine } from "../engine/SessionEngine"
import type { HistorySnipOptions } from "../engine/messageProjection"
import { projectMessages } from "../engine/messageProjection"
import { JsonlTranscriptWriter, replayProviderMessages, type TranscriptSink } from "../engine/transcript"
import { executeSlashCommand, parseSlashCommand, type SlashCommandInvocation } from "../extensions/commands"
import { runStopHooks, runUserPromptSubmitHooks, type SessionHooks } from "../extensions/hooks"
import { connectMcpServers, type McpContextSnapshot, type McpServerConfig, type McpStdioClient } from "../extensions/mcp"
import { loadSkills, type SkillSnapshot } from "../extensions/skills"
import { runTurn } from "../loop/runTurn"
import { ApprovalManager } from "../permissions/approval"
import type { Provider, ProviderMessage } from "../providers/types"
import type { TodoState } from "../tools/builtins/todo"
import type { ToolRuntime } from "../tools/ToolRuntime"

export type AgentSessionOptions = {
  id?: string
  cwd?: string
  provider: Provider
  toolRuntime: ToolRuntime
  initialMessages?: InternalMessage[]
  idSeed?: number
  transcript?: TranscriptSink | string
  maxSteps?: number
  providerRetry?: {
    maxRetries?: number
    initialDelayMs?: number
    maxDelayMs?: number
  }
  maxContextTokens?: number
  contextBudget?: ContextBudgetInput
  historySnip?: HistorySnipOptions
  compactTailMessages?: number
  artifactDir?: string
  toolResultArtifactBytes?: number
  toolResultPreviewBytes?: number
  hooks?: SessionHooks
  mcpServers?: McpServerConfig[]
  skillDirs?: string[]
  enabledSkills?: string[]
  todoState?: TodoState
  slashCommands?: AgentSessionSlashCommands
  now?: () => string
}

export type AgentSessionSlashCommands = {
  configReport?: string
  renderSessions?: () => Promise<string> | string
  renderDiff?: () => Promise<string> | string
}

export class AgentSession {
  readonly id: string
  readonly cwd: string
  private readonly provider: Provider
  private readonly toolRuntime: ToolRuntime
  private readonly maxSteps: number
  private readonly providerRetry?: AgentSessionOptions["providerRetry"]
  private readonly artifacts: ToolArtifactStore
  private readonly queue = new AsyncEventQueue<SessionEvent>()
  private readonly engine: SessionEngine
  private readonly approvals: ApprovalManager
  private readonly hooks?: SessionHooks
  private readonly mcpServers: McpServerConfig[]
  private readonly skillDirs: string[]
  private readonly enabledSkills: string[]
  private readonly todoState?: TodoState
  private readonly slashCommands?: AgentSessionSlashCommands
  private activeSkills: SkillSnapshot[] = []
  private mcpContext?: McpContextSnapshot
  private mcpClients: McpStdioClient[] = []
  private extensionsInitialized = false
  private activeTurn?: AbortController
  private started = false
  private startPromise?: Promise<void>
  private nextId = 0

  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const session = new AgentSession(options)
    await session.start()
    return session
  }

  static replayProviderMessages(events: SessionEvent[]): ProviderMessage[] {
    return replayProviderMessages(events)
  }

  constructor(options: AgentSessionOptions) {
    this.id = options.id ?? `session_${Math.random().toString(36).slice(2)}`
    this.cwd = resolve(options.cwd ?? process.cwd())
    this.provider = options.provider
    this.toolRuntime = options.toolRuntime
    this.maxSteps = options.maxSteps ?? 10
    this.providerRetry = options.providerRetry
    this.hooks = options.hooks
    this.mcpServers = options.mcpServers ?? []
    this.skillDirs = options.skillDirs ?? []
    this.enabledSkills = options.enabledSkills ?? []
    this.todoState = options.todoState ?? this.toolRuntime.getTodoState?.()
    this.slashCommands = options.slashCommands
    this.nextId = options.idSeed ?? 0
    const transcriptPath = typeof options.transcript === "string" ? options.transcript : undefined
    const transcript: TranscriptSink | undefined =
      typeof options.transcript === "string" ? new JsonlTranscriptWriter(options.transcript) : options.transcript
    this.artifacts = new ToolArtifactStore({
      sessionId: this.id,
      cwd: this.cwd,
      transcriptPath,
      artifactDir: options.artifactDir,
      thresholdBytes: options.toolResultArtifactBytes,
      previewBytes: options.toolResultPreviewBytes,
    })
    this.engine = new SessionEngine({
      id: this.id,
      cwd: this.cwd,
      transcript,
      now: options.now,
      getToolSchemas: () => getToolSchemas(this.toolRuntime),
      getActiveSkills: () => this.activeSkills,
      getMcpContext: () => this.mcpContext,
      getTodoContext: () => this.todoState?.summary() ?? "",
      historySnip: options.historySnip ?? { enabled: true },
      contextBudget: {
        ...options.contextBudget,
        maxContextTokens: options.maxContextTokens ?? options.contextBudget?.maxContextTokens,
      },
      compactTailMessages: options.compactTailMessages,
      initialMessages: options.initialMessages,
      onEvent: (event) => this.queue.push(event),
    })
    this.approvals = new ApprovalManager({
      makeId: (prefix) => this.makeId(prefix),
      emit: (event) => this.engine.emit(event).then(() => undefined),
    })
  }

  events(): AsyncIterable<SessionEvent> {
    return this.queue
  }

  getMessages(): InternalMessage[] {
    return this.engine.state.messages.slice()
  }

  projectProviderMessages(): ProviderMessage[] {
    return projectMessages(this.engine.state.messages)
  }

  renderStatusSummary(): string {
    return this.engine.renderStatusSummary()
  }

  renderContextSummary(): string {
    return this.engine.renderContextSummary()
  }

  async start(): Promise<void> {
    if (this.started) return
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.engine.start(() => this.initializeExtensions())
        this.started = true
      })()
    }
    try {
      await this.startPromise
    } catch (error) {
      this.startPromise = undefined
      throw error
    }
  }

  async submit(op: SessionOp): Promise<void> {
    await this.start()

    if (op.type === "abort") {
      this.abort(op.reason)
      return
    }

    if (op.type === "approval.respond") {
      const ok = await this.approvals.respond(op.approvalId, op.decision)
      if (!ok) {
        await this.engine.emit({
          type: "error",
          error: `No pending approval for ${op.approvalId}`,
          recoverable: true,
        })
      }
      return
    }

    if (this.activeTurn) {
      const error = new ActiveTurnError()
      await this.engine.emit({ type: "error", error: error.message, recoverable: true })
      throw error
    }

    if (op.type === "compact.request") {
      const controller = new AbortController()
      this.activeTurn = controller
      try {
        await this.engine.compact({
          compactId: op.id,
          trigger: "manual",
          instruction: op.instruction,
          provider: this.provider,
          signal: controller.signal,
          makeId: (prefix) => this.makeId(prefix),
        })
      } finally {
        if (this.activeTurn === controller) {
          this.activeTurn = undefined
        }
      }
      return
    }

    const command = parseSlashCommand(op.content)
    if (command) {
      await this.handleSlashCommand(command)
      return
    }

    const controller = new AbortController()
    this.activeTurn = controller
    const turnId = this.makeId("turn")
    try {
      const promptHook = await runUserPromptSubmitHooks({
        hooks: this.hooks,
        emit: (event) => this.engine.emit(event).then(() => undefined),
        input: {
          sessionId: this.id,
          cwd: this.cwd,
          prompt: op.content,
          signal: controller.signal,
        },
      })
      if (promptHook.status === "blocked") {
        await this.engine.emit({ type: "error", error: `Prompt blocked by hook: ${promptHook.reason}`, recoverable: true })
        return
      }

      const userMessage = makeUserMessage(op.id ?? this.makeId("user"), promptHook.prompt)

      const result = await runTurn({
        sessionId: this.id,
        turnId,
        userMessage,
        state: this.engine.state,
        provider: this.provider,
        toolRuntime: this.toolRuntime,
        approvals: this.approvals,
        hooks: this.hooks,
        signal: controller.signal,
        maxSteps: this.maxSteps,
        providerRetry: this.providerRetry,
        artifacts: this.artifacts,
        assembleProviderRequest: (request) =>
          this.engine.prepareProviderRequest({
            ...request,
            provider: this.provider,
            signal: controller.signal,
            makeId: (prefix) => this.makeId(prefix),
          }),
        compactOnOverflow: async () => {
          const result = await this.engine.compactForOverflow({
            provider: this.provider,
            signal: controller.signal,
            makeId: (prefix) => this.makeId(prefix),
          })
          return result.status === "succeeded"
        },
        makeId: (prefix) => this.makeId(prefix),
        emit: (event) => this.engine.emit(event).then(() => undefined),
      })
      await runStopHooks({
        hooks: this.hooks,
        emit: (event) => this.engine.emit(event).then(() => undefined),
        input: {
          sessionId: this.id,
          turnId,
          reason: result.reason,
          signal: controller.signal,
        },
      })
    } finally {
      if (this.activeTurn === controller) {
        this.activeTurn = undefined
      }
    }
  }

  abort(reason?: string): void {
    this.activeTurn?.abort(reason ?? "aborted")
    for (const client of this.mcpClients) client.close()
    this.mcpClients = []
  }

  async close(): Promise<void> {
    await this.approvals.cancelAll()
    for (const client of this.mcpClients) {
      client.close()
      await this.engine.emit({ type: "mcp.server.stopped", serverName: client.config.name })
    }
    this.mcpClients = []
    await this.toolRuntime.close?.()
    await this.engine.close()
    this.queue.close()
  }

  private makeId(prefix: string): string {
    this.nextId += 1
    return `${prefix}_${this.nextId}`
  }

  private async initializeExtensions(): Promise<void> {
    if (this.extensionsInitialized) return
    this.extensionsInitialized = true

    if (this.skillDirs.length > 0 || this.enabledSkills.length > 0) {
      const loaded = await loadSkills({ directories: this.skillDirs, enabledSkills: this.enabledSkills })
      this.activeSkills = loaded.active
      for (const diagnostic of loaded.diagnostics) {
        if (diagnostic.status === "activated") {
          const skill = this.activeSkills.find((item) => item.name === diagnostic.name || item.path === diagnostic.path)
          if (skill) {
            await this.engine.emit({
              type: "skill.activated",
              name: skill.name,
              path: skill.path,
              hash: skill.hash,
              bytes: skill.bytes,
              truncated: skill.truncated,
            })
          }
        } else if (diagnostic.status === "error" || diagnostic.status === "skipped") {
          await this.engine.emit({
            type: "error",
            error: `Skill ${diagnostic.status}: ${diagnostic.name ?? diagnostic.path}${diagnostic.message ? ` (${diagnostic.message})` : ""}`,
            recoverable: true,
          })
        }
      }
    }

    if (this.mcpServers.length > 0) {
      if (!this.toolRuntime.registerTool) {
        throw new Error("MCP servers require a ToolRuntime that supports registerTool")
      }
      const controller = new AbortController()
      const connected = await connectMcpServers(this.mcpServers, {
        signal: controller.signal,
        emit: (event) => this.engine.emit(event).then(() => undefined),
      })
      for (const tool of connected.tools) this.toolRuntime.registerTool(tool)
      this.mcpClients = connected.clients
      this.mcpContext = connected.context
    }
  }

  private async handleSlashCommand(command: SlashCommandInvocation): Promise<void> {
    await this.engine.emit({ type: "command.invoked", command: command.rawCommand, args: command.args })
    const sessions = command.command === "sessions" ? await this.slashCommands?.renderSessions?.() : undefined
    const diff = command.command === "diff" ? await this.slashCommands?.renderDiff?.() : undefined
    const result = executeSlashCommand(command, {
      tools: this.toolRuntime.listTools?.(),
      permissionMode: this.toolRuntime.getPermissionMode?.(),
      todoState: this.todoState,
      status: this.renderStatusSummary(),
      config: this.slashCommands?.configReport,
      context: this.renderContextSummary(),
      sessions,
      diff,
    })
    if (result.type === "output") {
      await this.engine.emit({
        type: "command.output",
        command: result.command,
        content: result.content,
        hostAction: result.hostAction,
        hostActionArgs: result.hostActionArgs,
      })
      return
    }

    const controller = new AbortController()
    this.activeTurn = controller
    try {
      const compact = await this.engine.compact({
        trigger: "manual",
        instruction: result.instruction,
        provider: this.provider,
        signal: controller.signal,
        makeId: (prefix) => this.makeId(prefix),
      })
      await this.engine.emit({
        type: "command.output",
        command: result.command,
        content: compact.status === "succeeded" ? "Compact completed." : `Compact failed: ${compact.error}`,
      })
    } finally {
      if (this.activeTurn === controller) this.activeTurn = undefined
    }
  }
}

function getToolSchemas(runtime: ToolRuntime): unknown[] | undefined {
  const maybe = runtime as ToolRuntime & { getToolSchemas?: () => unknown[] }
  return maybe.getToolSchemas?.()
}
