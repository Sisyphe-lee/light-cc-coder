import { TranscriptWriteError } from "../core/errors"
import type { SessionEvent, SessionEventDraft } from "../core/events"
import type { TurnState } from "../core/messages"
import { ContextAssembler } from "./ContextAssembler"
import type { AssembledProviderRequest, AssembleStepInput } from "./contextTypes"
import type { TranscriptSink } from "./transcript"

export type SessionEngineOptions = {
  id: string
  cwd: string
  transcript?: TranscriptSink
  onEvent: (event: SessionEvent) => void
  now?: () => string
  getToolSchemas?: () => unknown[] | undefined
}

export class SessionEngine {
  readonly id: string
  readonly cwd: string
  readonly state: TurnState = { messages: [] }
  private seq = 0
  private readonly transcript?: TranscriptSink
  private readonly onEvent: (event: SessionEvent) => void
  private readonly now: () => string
  private readonly contextAssembler: ContextAssembler
  private contextInitialized = false
  private sessionStartedEmitted = false

  constructor(options: SessionEngineOptions) {
    this.id = options.id
    this.cwd = options.cwd
    this.transcript = options.transcript
    this.onEvent = options.onEvent
    this.now = options.now ?? (() => new Date().toISOString())
    this.contextAssembler = new ContextAssembler({
      sessionId: this.id,
      cwd: this.cwd,
      now: this.now,
      getToolSchemas: options.getToolSchemas,
    })
  }

  async start(): Promise<void> {
    if (this.contextInitialized) return
    const contextSnapshot = await this.contextAssembler.initialize()
    if (!this.sessionStartedEmitted) {
      await this.emit({ type: "session.started", cwd: this.cwd })
      this.sessionStartedEmitted = true
    }
    await this.emit({ type: "context.session", snapshot: contextSnapshot })
    this.contextInitialized = true
  }

  async assembleProviderRequest(input: AssembleStepInput): Promise<AssembledProviderRequest> {
    if (!this.contextInitialized) {
      throw new Error("SessionEngine.start() must be called before assembling provider requests")
    }
    const assembled = this.contextAssembler.assembleStep(input)
    await this.emit({
      type: "context.step",
      turnId: input.turnId,
      stepId: input.stepId,
      snapshot: assembled.snapshot,
    })
    return assembled
  }

  async emit(draft: SessionEventDraft): Promise<SessionEvent> {
    const event = {
      seq: this.seq++,
      timestamp: this.now(),
      sessionId: this.id,
      ...draft,
    } as SessionEvent

    try {
      await this.transcript?.write(event)
    } catch (error) {
      const message = `Transcript write failed while writing ${draft.type}`
      const fatal = {
        seq: this.seq++,
        timestamp: this.now(),
        sessionId: this.id,
        turnId: "turnId" in draft ? draft.turnId : undefined,
        stepId: "stepId" in draft ? draft.stepId : undefined,
        type: "error",
        error: message,
        recoverable: false,
      } as SessionEvent
      this.onEvent(fatal)
      throw new TranscriptWriteError(message, error)
    }

    this.onEvent(event)
    return event
  }

  async close(): Promise<void> {
    await this.transcript?.close?.()
  }
}
