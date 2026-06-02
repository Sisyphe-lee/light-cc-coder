import { PairingError, TranscriptWriteError, abortReason, isAbortError } from "../core/errors"
import type { SessionEventDraft, TurnEndReason } from "../core/events"
import {
  makeToolResultMessage,
  type AssistantMessage,
  type InternalMessage,
  type ToolCall,
  type ToolResultMessage,
  type TurnState,
  type UserMessage,
} from "../core/messages"
import type { Provider, ProviderMessage, ProviderUsage } from "../providers/types"
import type { ApprovalRequester } from "../permissions/types"
import type { ToolArtifactStore } from "../context/toolArtifacts"
import type { ToolRuntime } from "../tools/ToolRuntime"
import type { SessionHooks } from "../extensions/hooks"
import { NOOP_PROFILER, type Profiler } from "../profiling/profiler"
import { takePostResultDiagnostics } from "../tools/result"
import { executeStep } from "./executeStep"

export type AssembleProviderRequestInput = {
  turnId: string
  stepId: string
  messages: InternalMessage[]
}

export type AssembleProviderRequestResult = {
  messages: ProviderMessage[]
  tools?: unknown[]
}

export type RunTurnInput = {
  sessionId: string
  turnId: string
  userMessage: UserMessage
  state: TurnState
  provider: Provider
  toolRuntime: ToolRuntime
  approvals?: ApprovalRequester
  artifacts?: ToolArtifactStore
  hooks?: SessionHooks
  profiler?: Profiler
  signal: AbortSignal
  maxSteps?: number
  assembleProviderRequest: (input: AssembleProviderRequestInput) => Promise<AssembleProviderRequestResult>
  compactOnOverflow?: (input: { turnId: string; stepId: string; error: unknown }) => Promise<boolean>
  providerRetry?: ProviderRetryOptions
  emit?: (event: SessionEventDraft) => Promise<void>
  makeId?: (prefix: string) => string
}

export type ProviderRetryOptions = {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

export type RunTurnResult = {
  reason: TurnEndReason
  steps: number
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const maxSteps = input.maxSteps ?? 10
  const emit = input.emit ?? (async () => {})
  const makeId = input.makeId ?? defaultId
  const assembleProviderRequest = input.assembleProviderRequest
  let steps = 0

  await emit({ type: "turn.started", turnId: input.turnId })
  await emit({ type: "user.message", turnId: input.turnId, message: input.userMessage })
  input.state.messages.push(input.userMessage)

  if (input.signal.aborted) {
    return endTurn(emit, input.turnId, "aborted", steps)
  }

  for (let index = 0; index < maxSteps; index++) {
    steps += 1
    const stepId = makeId("step")
    await emit({ type: "step.started", turnId: input.turnId, stepId })

    let assistant: AssistantMessage
    try {
      assistant = await executeProviderStepWithOverflowRetry({
        input,
        stepId,
        emit,
        assembleProviderRequest,
      })
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) {
        await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "aborted" })
        return endTurn(emit, input.turnId, "aborted", steps)
      }
      await emit({
        type: "error",
        turnId: input.turnId,
        stepId,
        error: error instanceof Error ? error.message : String(error),
        recoverable: false,
      })
      await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "error" })
      await endTurn(emit, input.turnId, "error", steps)
      throw error
    }

    const stepMessageStart = input.state.messages.length
    await emit({ type: "assistant.message", turnId: input.turnId, stepId, message: assistant })
    input.state.messages.push(assistant)

    if (assistant.toolCalls.length === 0) {
      await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "assistant_message" })
      return endTurn(emit, input.turnId, "completed", steps)
    }

    for (const call of assistant.toolCalls) {
      await emit({ type: "tool.call", turnId: input.turnId, stepId, call })
    }

    let toolOutcome: { results: ToolResultMessage[]; aborted: boolean }
    try {
      toolOutcome = await runToolsOrAbort({
        calls: assistant.toolCalls,
        input,
        stepId,
        makeId,
      })
    } catch (error) {
      input.state.messages.splice(stepMessageStart)
      throw error
    }
    const { results, aborted } = toolOutcome

    try {
      validateToolResultBatch(assistant.toolCalls, results)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.state.messages.splice(stepMessageStart)
      const pairingErrorResults = assistant.toolCalls.map((call) =>
        makeToolResultMessage({
          id: makeId("tool_result"),
          call,
          content: `Tool runtime pairing violation: ${message}`,
          isError: true,
        }),
      )
      input.state.messages.push(assistant)
      try {
        for (const result of pairingErrorResults) {
          await emit({ type: "tool.result", turnId: input.turnId, stepId, result })
          input.state.messages.push(result)
        }
      } catch (writeError) {
        input.state.messages.splice(stepMessageStart)
        throw writeError
      }
      await emit({
        type: "error",
        turnId: input.turnId,
        stepId,
        error: message,
        recoverable: false,
      })
      await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "error" })
      await endTurn(emit, input.turnId, "error", steps)
      throw error
    }

    try {
      const postResultDiagnostics: SessionEventDraft[] = []
      for (const result of results) {
        await emit({ type: "tool.result", turnId: input.turnId, stepId, result })
        input.state.messages.push(result)
        postResultDiagnostics.push(...takePostResultDiagnostics(result))
      }
      for (const diagnostic of postResultDiagnostics) {
        await emit(diagnostic)
      }
    } catch (error) {
      input.state.messages.splice(stepMessageStart)
      throw error
    }

    if (aborted || input.signal.aborted) {
      await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "aborted" })
      return endTurn(emit, input.turnId, "aborted", steps)
    }

    if (index === maxSteps - 1) {
      await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "max_steps" })
      return endTurn(emit, input.turnId, "max_steps", steps)
    }

    await emit({ type: "step.ended", turnId: input.turnId, stepId, reason: "tool_results" })
  }

  return endTurn(emit, input.turnId, "max_steps", steps)
}

function validateToolResultBatch(calls: ToolCall[], results: ToolResultMessage[]): void {
  if (results.length !== calls.length) {
    throw new PairingError(`Tool runtime returned ${results.length} results for ${calls.length} calls`)
  }

  const seen = new Set<string>()
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    const result = results[index]
    if (seen.has(result.toolCallId)) {
      throw new PairingError(`Tool runtime returned duplicate result for call ${result.toolCallId}`)
    }
    seen.add(result.toolCallId)
    if (result.toolCallId !== call.id) {
      throw new PairingError(`Tool result order mismatch: expected ${call.id}, got ${result.toolCallId}`)
    }
    if (result.toolName !== call.name) {
      throw new PairingError(`Tool result name mismatch for call ${call.id}`)
    }
  }
}

async function runToolsOrAbort(args: {
  calls: ToolCall[]
  input: RunTurnInput
  stepId: string
  makeId: (prefix: string) => string
}): Promise<{ results: ToolResultMessage[]; aborted: boolean }> {
  if (args.input.signal.aborted) {
    return {
      results: abortResults(args.calls, args.input.signal, args.makeId),
      aborted: true,
    }
  }

  try {
    return {
      results: await abortable(
        args.input.toolRuntime.runBatch(args.calls, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          stepId: args.stepId,
          signal: args.input.signal,
          approvals: args.input.approvals,
          artifacts: args.input.artifacts,
          hooks: args.input.hooks,
          profiler: args.input.profiler,
          emit: args.input.emit,
        }),
        args.input.signal,
      ),
      aborted: false,
    }
  } catch (error) {
    if (error instanceof TranscriptWriteError) {
      throw error
    }
    if (args.input.signal.aborted || isAbortError(error)) {
      return {
        results: abortResults(args.calls, args.input.signal, args.makeId),
        aborted: true,
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      results: args.calls.map((call) =>
        makeToolResultMessage({
          id: args.makeId("tool_result"),
          call,
          content: `Tool runtime error: ${message}`,
          isError: true,
        }),
      ),
      aborted: false,
    }
  }
}

async function executeProviderStepWithOverflowRetry(args: {
  input: RunTurnInput
  stepId: string
  emit: (event: SessionEventDraft) => Promise<void>
  assembleProviderRequest: (input: AssembleProviderRequestInput) => Promise<AssembleProviderRequestResult>
}): Promise<AssistantMessage> {
  let didOverflowRetry = false
  let attempt = 0
  const retryOptions = normalizeProviderRetry(args.input.providerRetry)
  const profiler = args.input.profiler ?? NOOP_PROFILER
  while (true) {
    attempt += 1
    const providerRequest = await args.assembleProviderRequest({
      turnId: args.input.turnId,
      stepId: args.stepId,
      messages: args.input.state.messages,
    })
    let hadAssistantDelta = false
    // One coarse span per provider attempt: durationMs is the stream duration,
    // with first-token latency, delta/tool counts, and bounded usage as attributes.
    const span = profiler.startSpan("provider.step", "provider", {
      turnId: args.input.turnId,
      stepId: args.stepId,
      attempt,
    })
    let textDeltaCount = 0
    let textBytes = 0
    let usage: ProviderUsage | undefined
    try {
      const assistant = await executeStep({
        provider: args.input.provider,
        request: {
          messages: providerRequest.messages,
          tools: providerRequest.tools,
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          stepId: args.stepId,
        },
        signal: args.input.signal,
        onFirstChunk: () => span.mark("firstTokenMs"),
        onUsage: (value) => {
          usage = value
        },
        onDelta: async (text) => {
          hadAssistantDelta = true
          textDeltaCount += 1
          textBytes += Buffer.byteLength(text, "utf8")
          await args.emit({ type: "assistant.delta", turnId: args.input.turnId, stepId: args.stepId, text })
        },
      })
      await span.end("ok", {
        textDeltaCount,
        textBytes,
        toolCallCount: assistant.toolCalls.length,
        ...usageAttributes(usage),
      })
      return assistant
    } catch (error) {
      if (error instanceof TranscriptWriteError) {
        await span.end("error", { textDeltaCount, textBytes })
        throw error
      }
      if (args.input.signal.aborted || isAbortError(error)) {
        await span.end("aborted", { textDeltaCount, textBytes })
        throw error
      }

      const failure = classifyProviderFailure(error, hadAssistantDelta)
      await span.end("error", { textDeltaCount, textBytes, failureClass: failure.classification })
      if (failure.classification === "context_overflow") {
        if (didOverflowRetry || !args.input.compactOnOverflow) throw error
        didOverflowRetry = true
        const compacted = await args.input.compactOnOverflow({
          turnId: args.input.turnId,
          stepId: args.stepId,
          error,
        })
        if (!compacted) throw error
        continue
      }

      if (!failure.retryable || attempt > retryOptions.maxRetries) {
        await args.emit({
          type: "provider.failure",
          turnId: args.input.turnId,
          stepId: args.stepId,
          attempts: attempt,
          classification: failure.classification,
          message: failure.message,
          retryable: failure.retryable,
          hadAssistantDelta,
        })
        throw error
      }

      const delayMs = retryDelayMs(attempt, retryOptions)
      await args.emit({
        type: "provider.retry",
        turnId: args.input.turnId,
        stepId: args.stepId,
        attempt,
        nextAttempt: attempt + 1,
        maxRetries: retryOptions.maxRetries,
        classification: failure.classification,
        message: failure.message,
        delayMs,
      })
      await sleep(delayMs, args.input.signal)
    }
  }
}

function usageAttributes(usage: ProviderUsage | undefined): Record<string, number> {
  if (!usage) return {}
  const attrs: Record<string, number> = {}
  if (usage.inputTokens !== undefined) attrs.inputTokens = usage.inputTokens
  if (usage.outputTokens !== undefined) attrs.outputTokens = usage.outputTokens
  if (usage.totalTokens !== undefined) attrs.totalTokens = usage.totalTokens
  if (usage.cacheReadInputTokens !== undefined) attrs.cacheReadInputTokens = usage.cacheReadInputTokens
  if (usage.cacheWriteInputTokens !== undefined) attrs.cacheWriteInputTokens = usage.cacheWriteInputTokens
  return attrs
}

function normalizeProviderRetry(options: ProviderRetryOptions | undefined): Required<ProviderRetryOptions> {
  return {
    maxRetries: options?.maxRetries ?? 2,
    initialDelayMs: options?.initialDelayMs ?? 250,
    maxDelayMs: options?.maxDelayMs ?? 2_000,
  }
}

function classifyProviderFailure(
  error: unknown,
  hadAssistantDelta: boolean,
): { classification: string; message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error)
  if (hadAssistantDelta) return { classification: "partial_delta_failure", message, retryable: false }
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) {
    return { classification: "rate_limit", message, retryable: true }
  }
  if (/\b408\b|\btimeout\b|timed out/i.test(message)) {
    return { classification: "timeout", message, retryable: true }
  }
  if (/\b5\d\d\b|server error|bad gateway|service unavailable|gateway timeout/i.test(message)) {
    return { classification: "server_error", message, retryable: true }
  }
  if (
    /Provider stream ended without an assistant message|stream.*(drop|ended|closed|terminated)|network|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(
      message,
    )
  ) {
    return { classification: "network_or_stream", message, retryable: true }
  }
  if (/\b(401|403)\b|unauthorized|forbidden|auth/i.test(message)) {
    return { classification: "auth_error", message, retryable: false }
  }
  if (isContextOverflow(error)) return { classification: "context_overflow", message, retryable: false }
  if (/\b4\d\d\b|bad request|invalid request/i.test(message)) {
    return { classification: "client_error", message, retryable: false }
  }
  if (/malformed|invalid json|parse|schema/i.test(message)) {
    return { classification: "malformed_response", message, retryable: false }
  }
  return { classification: "unknown", message, retryable: false }
}

function retryDelayMs(attempt: number, options: Required<ProviderRetryOptions>): number {
  if (options.initialDelayMs <= 0 || options.maxRetries <= 0) return 0
  return Math.min(options.initialDelayMs * 2 ** Math.max(0, attempt - 1), options.maxDelayMs)
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal.aborted) throw new Error(abortReason(signal))
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error(abortReason(signal)))
    }
    function cleanup() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
    }
    function finish() {
      cleanup()
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /context|prompt|token|tokens|maximum context|too large|too long|length/i.test(message)
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Error(abortReason(signal)))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function abortResults(
  calls: ToolCall[],
  signal: AbortSignal,
  makeId: (prefix: string) => string,
): ToolResultMessage[] {
  const reason = signal.aborted ? abortReason(signal) : "aborted"
  return calls.map((call) =>
    makeToolResultMessage({
      id: makeId("tool_result"),
      call,
      content: `Tool call aborted: ${reason}`,
      isError: true,
    }),
  )
}

async function endTurn(
  emit: (event: SessionEventDraft) => Promise<void>,
  turnId: string,
  reason: TurnEndReason,
  steps: number,
): Promise<RunTurnResult> {
  await emit({ type: "turn.ended", turnId, reason })
  return { reason, steps }
}

let fallbackId = 0
function defaultId(prefix: string): string {
  fallbackId += 1
  return `${prefix}_${fallbackId}`
}
