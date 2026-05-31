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
import type { Provider, ProviderMessage } from "../providers/types"
import type { ApprovalRequester } from "../permissions/types"
import type { ToolArtifactStore } from "../context/toolArtifacts"
import type { ToolRuntime } from "../tools/ToolRuntime"
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
  signal: AbortSignal
  maxSteps?: number
  assembleProviderRequest: (input: AssembleProviderRequestInput) => Promise<AssembleProviderRequestResult>
  compactOnOverflow?: (input: { turnId: string; stepId: string; error: unknown }) => Promise<boolean>
  emit?: (event: SessionEventDraft) => Promise<void>
  makeId?: (prefix: string) => string
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
      for (const result of results) {
        await emit({ type: "tool.result", turnId: input.turnId, stepId, result })
        input.state.messages.push(result)
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
  while (true) {
    const providerRequest = await args.assembleProviderRequest({
      turnId: args.input.turnId,
      stepId: args.stepId,
      messages: args.input.state.messages,
    })
    try {
      return await executeStep({
        provider: args.input.provider,
        request: {
          messages: providerRequest.messages,
          tools: providerRequest.tools,
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          stepId: args.stepId,
        },
        signal: args.input.signal,
        onDelta: (text) => args.emit({ type: "assistant.delta", turnId: args.input.turnId, stepId: args.stepId, text }),
      })
    } catch (error) {
      if (didOverflowRetry || !args.input.compactOnOverflow || !isContextOverflow(error)) throw error
      didOverflowRetry = true
      const compacted = await args.input.compactOnOverflow({
        turnId: args.input.turnId,
        stepId: args.stepId,
        error,
      })
      if (!compacted) throw error
    }
  }
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
