import { TranscriptWriteError } from "../core/errors"
import type { SessionEvent, SessionEventDraft } from "../core/events"
import type { TurnState } from "../core/messages"
import {
  buildCompactPrompt,
  dropOldestCompleteGroup,
  estimateInternalMessagesTokens,
  makeCompactSummaryMessage,
  selectPairingSafeTail,
  type CompactTrigger,
} from "../context/compaction"
import { createContextBudgetOptions, isContextTooLargeError, type ContextBudgetInput } from "../context/contextBudget"
import type { Provider } from "../providers/types"
import { executeStep } from "../loop/executeStep"
import { ContextAssembler } from "./ContextAssembler"
import type { AssembledProviderRequest, AssembleStepInput } from "./contextTypes"
import type { HistorySnipOptions } from "./messageProjection"
import type { TranscriptSink } from "./transcript"
import type { McpContextSnapshot } from "../extensions/mcp"
import type { SkillSnapshot } from "../extensions/skills"

export type SessionEngineOptions = {
  id: string
  cwd: string
  transcript?: TranscriptSink
  onEvent: (event: SessionEvent) => void
  now?: () => string
  getToolSchemas?: () => unknown[] | undefined
  getActiveSkills?: () => SkillSnapshot[]
  getMcpContext?: () => McpContextSnapshot | undefined
  getTodoContext?: () => string
  historySnip?: HistorySnipOptions
  contextBudget?: ContextBudgetInput
  compactTailMessages?: number
}

export type CompactRequest = {
  compactId?: string
  trigger: CompactTrigger
  instruction?: string
  provider: Provider
  signal: AbortSignal
  makeId: (prefix: string) => string
  preCompactEstimatedTokens?: number
}

export type CompactResult =
  | { status: "succeeded"; compactId: string; postCompactEstimatedTokens: number }
  | { status: "failed"; compactId: string; error: string }

export class SessionEngine {
  readonly id: string
  readonly cwd: string
  readonly state: TurnState = { messages: [] }
  private seq = 0
  private readonly transcript?: TranscriptSink
  private readonly onEvent: (event: SessionEvent) => void
  private readonly now: () => string
  private readonly contextAssembler: ContextAssembler
  private readonly contextBudget: ReturnType<typeof createContextBudgetOptions>
  private readonly compactTailMessages: number
  private contextInitialized = false
  private sessionStartedEmitted = false
  private autoCompactFailures = 0

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
      getActiveSkills: options.getActiveSkills,
      getMcpContext: options.getMcpContext,
      getTodoContext: options.getTodoContext,
      historySnip: options.historySnip,
    })
    this.contextBudget = createContextBudgetOptions(options.contextBudget)
    this.compactTailMessages = options.compactTailMessages ?? 24
  }

  async start(beforeContext?: () => Promise<void>): Promise<void> {
    if (this.contextInitialized) return
    if (!this.sessionStartedEmitted) {
      await this.emit({ type: "session.started", cwd: this.cwd })
      this.sessionStartedEmitted = true
    }
    await beforeContext?.()
    const contextSnapshot = await this.contextAssembler.initialize()
    await this.emit({ type: "context.session", snapshot: contextSnapshot })
    this.contextInitialized = true
  }

  async assembleProviderRequest(input: AssembleStepInput): Promise<AssembledProviderRequest> {
    if (!this.contextInitialized) {
      throw new Error("SessionEngine.start() must be called before assembling provider requests")
    }
    const assembled = this.contextAssembler.assembleStep(input)
    await this.emitContextStep(input, assembled)
    return assembled
  }

  async prepareProviderRequest(
    input: AssembleStepInput & {
      provider: Provider
      signal: AbortSignal
      makeId: (prefix: string) => string
    },
  ): Promise<AssembledProviderRequest> {
    let assembled = this.assembleProviderRequestSnapshot(input)
    const estimated = assembled.snapshot.estimatedTokens ?? 0
    if (
      estimated >= this.contextBudget.hardCompactTokens &&
      this.autoCompactFailures < 3 &&
      this.state.messages.length > 0
    ) {
      const compact = await this.compact({
        trigger: "auto",
        provider: input.provider,
        signal: input.signal,
        makeId: input.makeId,
        preCompactEstimatedTokens: estimated,
      })
      if (compact.status === "succeeded") {
        this.autoCompactFailures = 0
        assembled = this.assembleProviderRequestSnapshot({ ...input, messages: this.state.messages })
      } else {
        this.autoCompactFailures += 1
        if (estimated >= this.contextBudget.blockingTokens) {
          throw new Error(
            `Provider request exceeds context budget (${estimated} estimated tokens) and auto compact failed: ${compact.error}`,
          )
        }
      }
    }

    const finalEstimated = assembled.snapshot.estimatedTokens ?? 0
    if (finalEstimated >= this.contextBudget.blockingTokens) {
      throw new Error(`Provider request exceeds blocking context budget (${finalEstimated} estimated tokens)`)
    }
    await this.emitContextStep(input, assembled)
    return assembled
  }

  async compact(input: CompactRequest): Promise<CompactResult> {
    if (!this.contextInitialized) {
      throw new Error("SessionEngine.start() must be called before compact")
    }
    const compactId = input.compactId ?? input.makeId("compact")
    const preMessages = this.state.messages.slice()
    const preEstimated = input.preCompactEstimatedTokens ?? estimateInternalMessagesTokens(preMessages)
    await this.emit({
      type: "compact.started",
      compactId,
      trigger: input.trigger,
      preCompactMessageCount: preMessages.length,
      estimatedTokens: preEstimated,
    })

    let selection
    try {
      selection = selectPairingSafeTail(preMessages, this.compactTailMessages)
      if (selection.summarizedMessages.length === 0) {
        throw new Error("No pairing-safe prefix is available to compact")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.emitCompactFailed(compactId, input.trigger, preEstimated, message)
      return { status: "failed", compactId, error: message }
    }

    let compactInput = selection.summarizedMessages
    let omittedOldestGroups = 0
    let summaryText: string | undefined
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let prompt = buildCompactPrompt({
          messages: compactInput,
          instruction: input.instruction,
          omittedOldestGroups,
        })
        while (prompt.inputTokens > this.contextBudget.compactInputTokens) {
          const dropped = dropOldestCompleteGroup(compactInput)
          if (!dropped.dropped) break
          compactInput = dropped.messages
          omittedOldestGroups += 1
          prompt = buildCompactPrompt({
            messages: compactInput,
            instruction: input.instruction,
            omittedOldestGroups,
          })
        }
        try {
          const assistant = await executeStep({
            provider: input.provider,
            request: {
              messages: prompt.messages,
              tools: [],
              sessionId: this.id,
              stepId: compactId,
            },
            signal: input.signal,
          })
          if (assistant.toolCalls.length > 0) {
            throw new Error("Compact provider returned tool calls despite a no-tools request")
          }
          summaryText = assistant.content
          break
        } catch (error) {
          if (!isContextTooLargeError(error) || attempt === 2) throw error
          const dropped = dropOldestCompleteGroup(compactInput)
          if (!dropped.dropped) throw error
          compactInput = dropped.messages
          omittedOldestGroups += 1
        }
      }
      if (summaryText === undefined) {
        throw new Error("Compact provider ended without a summary")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.emitCompactFailed(compactId, input.trigger, preEstimated, message)
      return { status: "failed", compactId, error: message }
    }

    const summary = makeCompactSummaryMessage({
      id: `${compactId}_summary`,
      summary: summaryText,
      omittedOldestGroups,
    })
    const nextMessages = [summary.message, ...selection.tailMessages]
    const postEstimated = estimateInternalMessagesTokens(nextMessages)
    await this.emit({
      type: "compact.ended",
      compactId,
      trigger: input.trigger,
      status: "succeeded",
      summaryMessage: summary.message,
      summaryHash: summary.summaryHash,
      tailStartMessageId: selection.tailStartMessageId,
      summarizedMessageCount: compactInput.length,
      keptMessageCount: selection.tailMessages.length,
      preCompactEstimatedTokens: preEstimated,
      postCompactEstimatedTokens: postEstimated,
      omittedOldestGroups,
    })
    this.state.messages.splice(0, this.state.messages.length, ...nextMessages)
    this.contextAssembler.setCompactSnapshot({
      compactId,
      summaryHash: summary.summaryHash,
      messageCount: nextMessages.length,
    })
    return { status: "succeeded", compactId, postCompactEstimatedTokens: postEstimated }
  }

  async compactForOverflow(input: Omit<CompactRequest, "trigger">): Promise<CompactResult> {
    return this.compact({ ...input, trigger: "overflow_retry" })
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

  private assembleProviderRequestSnapshot(input: AssembleStepInput): AssembledProviderRequest {
    if (!this.contextInitialized) {
      throw new Error("SessionEngine.start() must be called before assembling provider requests")
    }
    return this.contextAssembler.assembleStep(input)
  }

  private async emitContextStep(input: AssembleStepInput, assembled: AssembledProviderRequest): Promise<void> {
    await this.emit({
      type: "context.step",
      turnId: input.turnId,
      stepId: input.stepId,
      snapshot: assembled.snapshot,
    })
  }

  private async emitCompactFailed(
    compactId: string,
    trigger: CompactTrigger,
    preCompactEstimatedTokens: number,
    error: string,
  ): Promise<void> {
    await this.emit({
      type: "compact.ended",
      compactId,
      trigger,
      status: "failed",
      error,
      preCompactEstimatedTokens,
    })
    await this.emit({ type: "error", error: `Compact failed: ${error}`, recoverable: true })
  }
}
