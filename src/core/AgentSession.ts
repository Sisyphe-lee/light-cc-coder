import { AsyncEventQueue } from "./AsyncEventQueue"
import { ActiveTurnError } from "./errors"
import type { SessionEvent } from "./events"
import { makeUserMessage, type InternalMessage } from "./messages"
import type { SessionOp } from "./ops"
import { resolve } from "node:path"
import { SessionEngine } from "../engine/SessionEngine"
import { projectMessages } from "../engine/messageProjection"
import { JsonlTranscriptWriter, replayProviderMessages, type TranscriptSink } from "../engine/transcript"
import { runTurn } from "../loop/runTurn"
import { ApprovalManager } from "../permissions/approval"
import type { Provider, ProviderMessage } from "../providers/types"
import type { ToolRuntime } from "../tools/ToolRuntime"

export type AgentSessionOptions = {
  id?: string
  cwd?: string
  provider: Provider
  toolRuntime: ToolRuntime
  transcript?: TranscriptSink | string
  maxSteps?: number
  now?: () => string
}

export class AgentSession {
  readonly id: string
  readonly cwd: string
  private readonly provider: Provider
  private readonly toolRuntime: ToolRuntime
  private readonly maxSteps: number
  private readonly queue = new AsyncEventQueue<SessionEvent>()
  private readonly engine: SessionEngine
  private readonly approvals: ApprovalManager
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
    const transcript =
      typeof options.transcript === "string" ? new JsonlTranscriptWriter(options.transcript) : options.transcript
    this.engine = new SessionEngine({
      id: this.id,
      cwd: this.cwd,
      transcript,
      now: options.now,
      getToolSchemas: () => getToolSchemas(this.toolRuntime),
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

  async start(): Promise<void> {
    if (this.started) return
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.engine.start()
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

    const controller = new AbortController()
    this.activeTurn = controller
    const turnId = this.makeId("turn")
    const userMessage = makeUserMessage(op.id ?? this.makeId("user"), op.content)

    try {
      await runTurn({
        sessionId: this.id,
        turnId,
        userMessage,
        state: this.engine.state,
        provider: this.provider,
        toolRuntime: this.toolRuntime,
        approvals: this.approvals,
        signal: controller.signal,
        maxSteps: this.maxSteps,
        assembleProviderRequest: (request) => this.engine.assembleProviderRequest(request),
        makeId: (prefix) => this.makeId(prefix),
        emit: (event) => this.engine.emit(event).then(() => undefined),
      })
    } finally {
      if (this.activeTurn === controller) {
        this.activeTurn = undefined
      }
    }
  }

  abort(reason?: string): void {
    this.activeTurn?.abort(reason ?? "aborted")
  }

  async close(): Promise<void> {
    await this.approvals.cancelAll()
    await this.engine.close()
    this.queue.close()
  }

  private makeId(prefix: string): string {
    this.nextId += 1
    return `${prefix}_${this.nextId}`
  }
}

function getToolSchemas(runtime: ToolRuntime): unknown[] | undefined {
  const maybe = runtime as ToolRuntime & { getToolSchemas?: () => unknown[] }
  return maybe.getToolSchemas?.()
}
