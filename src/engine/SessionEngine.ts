import { TranscriptWriteError } from "../core/errors"
import type { SessionEvent, SessionEventDraft } from "../core/events"
import type { InternalMessage, TurnState } from "../core/messages"
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
import { NOOP_PROFILER, type Profiler, type ProfileAttributes } from "../profiling/profiler"
import { ContextAssembler, type RuntimeContextFacts } from "./ContextAssembler"
import type { AssembledProviderRequest, AssembleStepInput, ContextSnapshot } from "./contextTypes"
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
  getRuntimeContext?: () => RuntimeContextFacts | undefined
  getToolSchemas?: () => unknown[] | undefined
  getActiveSkills?: () => SkillSnapshot[]
  getMcpContext?: () => McpContextSnapshot | undefined
  getTodoContext?: () => string
  historySnip?: HistorySnipOptions
  contextBudget?: ContextBudgetInput
  compactTailMessages?: number
  initialMessages?: InternalMessage[]
  profiler?: Profiler
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
  readonly state: TurnState
  private seq = 0
  private readonly transcript?: TranscriptSink
  private readonly onEvent: (event: SessionEvent) => void
  private readonly now: () => string
  private readonly profiler: Profiler
  private readonly contextAssembler: ContextAssembler
  private readonly contextBudget: ReturnType<typeof createContextBudgetOptions>
  private readonly compactTailMessages: number
  private contextInitialized = false
  private sessionStartedEmitted = false
  private autoCompactFailures = 0
  private latestSessionSnapshot?: Awaited<ReturnType<ContextAssembler["initialize"]>>
  private latestContextSnapshot?: AssembledProviderRequest["snapshot"]

  constructor(options: SessionEngineOptions) {
    this.id = options.id
    this.cwd = options.cwd
    this.state = { messages: options.initialMessages?.slice() ?? [] }
    this.transcript = options.transcript
    this.onEvent = options.onEvent
    this.now = options.now ?? (() => new Date().toISOString())
    this.profiler = options.profiler ?? NOOP_PROFILER
    this.contextAssembler = new ContextAssembler({
      sessionId: this.id,
      cwd: this.cwd,
      now: this.now,
      getRuntimeContext: options.getRuntimeContext,
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
    const startupSpan = this.profiler.startSpan("startup.context", "startup")
    const contextSnapshot = await this.contextAssembler.initialize()
    await startupSpan.end("ok", { sourceCount: contextSnapshot.sources.length })
    this.latestSessionSnapshot = contextSnapshot
    await this.emit({ type: "context.session", snapshot: contextSnapshot })
    this.contextInitialized = true
  }

  async prepareProviderRequest(
    input: AssembleStepInput & {
      provider: Provider
      signal: AbortSignal
      makeId: (prefix: string) => string
    },
  ): Promise<AssembledProviderRequest> {
    let assembled = await this.assembleWithSpan(input)
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
        assembled = await this.assembleWithSpan({ ...input, messages: this.state.messages })
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
    // One coarse span over the whole compaction; the inner provider summary call
    // gets its own span. Spans are replay-invisible and do not affect the
    // compact.started/ended checkpoint ordering or recovery.
    const runSpan = this.profiler.startSpan("compact.run", "compact", {
      trigger: input.trigger,
      preCompactMessageCount: preMessages.length,
      preCompactEstimatedTokens: preEstimated,
    })
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
      await runSpan.end("error", { failureClass: "no_pairing_safe_prefix" })
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
        const summarySpan = this.profiler.startSpan("compact.provider_summary", "compact", { attempt: attempt + 1 })
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
          await summarySpan.end("ok")
          if (assistant.toolCalls.length > 0) {
            throw new Error("Compact provider returned tool calls despite a no-tools request")
          }
          summaryText = assistant.content
          break
        } catch (error) {
          await summarySpan.end("error")
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
      await runSpan.end("error", { failureClass: "summary_failed", omittedOldestGroups })
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
    await runSpan.end("ok", {
      postCompactEstimatedTokens: postEstimated,
      summarizedMessageCount: compactInput.length,
      keptMessageCount: selection.tailMessages.length,
      omittedOldestGroups,
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
      if (this.profiler.enabled && this.transcript) {
        const serialized = JSON.stringify(event)
        const t0 = this.profiler.now()
        await this.transcript.write(event)
        this.profiler.recordTranscriptWrite(event.type, Buffer.byteLength(serialized, "utf8"), this.profiler.now() - t0)
      } else {
        await this.transcript?.write(event)
      }
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

  // Coarse span over one context assembly (projection + token estimate + tool
  // schema hash). Counts/hashes only; the detailed snapshot stays in context.step.
  private async assembleWithSpan(input: AssembleStepInput): Promise<AssembledProviderRequest> {
    const span = this.profiler.startSpan("context.assemble_step", "context", {
      turnId: input.turnId,
      stepId: input.stepId,
    })
    try {
      const assembled = this.assembleProviderRequestSnapshot(input)
      await span.end("ok", contextSpanAttributes(assembled))
      return assembled
    } catch (error) {
      await span.end("error")
      throw error
    }
  }

  private async emitContextStep(input: AssembleStepInput, assembled: AssembledProviderRequest): Promise<void> {
    await this.emit({
      type: "context.step",
      turnId: input.turnId,
      stepId: input.stepId,
      snapshot: assembled.snapshot,
    })
    this.latestContextSnapshot = assembled.snapshot
  }

  renderStatusSummary(): string {
    return [
      `Session: ${this.id}`,
      `Workspace: ${this.cwd}`,
      `Messages: ${this.state.messages.length}`,
      `Context initialized: ${this.contextInitialized ? "yes" : "no"}`,
    ].join("\n")
  }

  renderContextSummary(): string {
    const snapshot = this.latestContextSnapshot ?? this.latestSessionSnapshot
    if (!snapshot) return "Context has not been initialized."
    const lines = [
      `Stable prefix hash: ${snapshot.stablePrefixHash}`,
      `Tool schema hash: ${snapshot.toolSchemaHash ?? "none"}`,
    ]
    if ("historyMessageCount" in snapshot) {
      const stepSnapshot = snapshot as ContextSnapshot
      lines.push(
        `History messages: ${stepSnapshot.historyMessageCount}`,
        `Provider messages: ${stepSnapshot.providerMessageCount}`,
        `Estimated tokens: ${stepSnapshot.estimatedTokens ?? "unknown"}`,
      )
      if ((stepSnapshot.historySnippedToolResults ?? 0) > 0) {
        lines.push(
          `Snipped tool results: ${stepSnapshot.historySnippedToolResults} (${stepSnapshot.historySnippedBytes ?? 0} bytes)`,
        )
      }
    }
    lines.push("Sources:")
    for (const source of snapshot.sources) {
      const note = source.note ? `; ${source.note}` : ""
      lines.push(`- ${source.order}. ${source.kind}: ${source.status}, ${source.bytes} bytes${note}`)
    }
    return lines.join("\n")
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

function contextSpanAttributes(assembled: AssembledProviderRequest): ProfileAttributes {
  const snapshot = assembled.snapshot
  const attrs: ProfileAttributes = {
    providerMessageCount: snapshot.providerMessageCount,
    prefixMessageCount: snapshot.prefixMessageCount,
    historyMessageCount: snapshot.historyMessageCount,
    sourceCount: snapshot.sources.length,
    toolSchemaChanged: snapshot.toolSchemaChanged,
    compactActive: snapshot.sources.some((source) => source.kind === "compact_slot" && source.status === "included"),
  }
  if (snapshot.estimatedTokens !== undefined) attrs.estimatedTokens = snapshot.estimatedTokens
  if (snapshot.toolSchemaHash !== undefined) attrs.toolSchemaHash = snapshot.toolSchemaHash
  if (snapshot.historySnippedToolResults !== undefined) attrs.historySnippedToolResults = snapshot.historySnippedToolResults
  if (snapshot.historySnippedBytes !== undefined) attrs.historySnippedBytes = snapshot.historySnippedBytes
  return attrs
}
