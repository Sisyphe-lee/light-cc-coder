import { describe, expect, test } from "bun:test"
import type { SessionEvent, SessionEventDraft } from "../../src/core/events"
import type { TurnState } from "../../src/core/messages"
import { projectMessages } from "../../src/engine/messageProjection"
import { replayProviderMessages } from "../../src/engine/transcript"
import { runTurn, type RunTurnResult } from "../../src/loop/runTurn"
import { FakeProvider } from "../../src/providers/FakeProvider"
import type { ModelEvent, Provider, ProviderRequest } from "../../src/providers/types"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { assistant, call, createDraftRecorder, createIdFactory, user } from "../helpers"

describe("Phase 6 provider retry trigger boundaries", () => {
  for (const scenario of transientFailureScenarios()) {
    test(`retries ${scenario.name} before any assistant delta`, async () => {
      const provider = scenario.provider()
      const state: TurnState = { messages: [] }
      const recorder = createDraftRecorder()

      const result = await runBasicTurn({ provider, state, recorder })

      expect(result.reason).toBe("completed")
      expect(provider.requests).toHaveLength(2)
      expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(recorder.events.some((event) => event.type === "assistant.delta")).toBe(false)
      expect(providerRetryEvents(recorder.events)).toEqual([
        expect.objectContaining({
          attempt: 1,
          nextAttempt: 2,
          classification: scenario.classification,
          delayMs: 0,
        }),
      ])
      expect(providerFailureEvents(recorder.events)).toHaveLength(0)
    })
  }

  test("does not retry a transient provider failure after an assistant delta", async () => {
    const provider = new FakeProvider({
      steps: [{ deltas: ["working"], error: "OpenAI-compatible provider request failed: 429 too many requests" }],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    await expect(runBasicTurn({ provider, state, recorder })).rejects.toThrow("429 too many requests")

    expect(provider.requests).toHaveLength(1)
    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(recorder.events.map((event) => event.type)).toContain("assistant.delta")
    expect(recorder.events.some((event) => event.type === "assistant.message")).toBe(false)
    expect(providerRetryEvents(recorder.events)).toHaveLength(0)
    expect(providerFailureEvents(recorder.events)).toEqual([
      expect.objectContaining({
        classification: "partial_delta_failure",
        retryable: false,
        hadAssistantDelta: true,
      }),
    ])
  })

  test("retries a later provider step when the current assistant message has not committed yet", async () => {
    const toolCall = call("c1", "echo")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "need tool", [toolCall]) },
        { error: "OpenAI-compatible provider request failed: 408 request timeout" },
        { message: assistant("a2", "recovered after tool result") },
      ],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    const result = await runBasicTurn({
      provider,
      state,
      recorder,
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "tool output" } } }),
    })

    expect(result.reason).toBe("completed")
    expect(provider.requests).toHaveLength(3)
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(providerRetryEvents(recorder.events)).toEqual([
      expect.objectContaining({ classification: "timeout", attempt: 1, nextAttempt: 2 }),
    ])
    expect(providerFailureEvents(recorder.events)).toHaveLength(0)
    expect(provider.requests[1].messages).toEqual(provider.requests[2].messages)
    expect(provider.requests[1].messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
  })

  test("abort during the provider step ends the turn without provider retry or failure diagnostics", async () => {
    const controller = new AbortController()
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "should not commit") }],
      onRequest: () => controller.abort("user interrupted"),
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    const result = await runBasicTurn({ provider, state, recorder, signal: controller.signal })

    expect(result).toEqual({ reason: "aborted", steps: 1 })
    expect(provider.requests).toHaveLength(1)
    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(recorder.events.some((event) => event.type === "assistant.message")).toBe(false)
    expect(providerRetryEvents(recorder.events)).toHaveLength(0)
    expect(providerFailureEvents(recorder.events)).toHaveLength(0)
  })

  test("context overflow calls compact and never emits ordinary provider retry diagnostics", async () => {
    const provider = new FakeProvider({
      steps: [{ error: "maximum context length exceeded" }, { message: assistant("a1", "after compact") }],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()
    const compactCalls: Array<{ turnId: string; stepId: string; error: unknown }> = []

    const result = await runBasicTurn({
      provider,
      state,
      recorder,
      compactOnOverflow: async (input) => {
        compactCalls.push(input)
        return true
      },
    })

    expect(result.reason).toBe("completed")
    expect(compactCalls).toHaveLength(1)
    expect(compactCalls[0]).toMatchObject({ turnId: "t1", stepId: "step_1" })
    expect(provider.requests).toHaveLength(2)
    expect(providerRetryEvents(recorder.events)).toHaveLength(0)
    expect(providerFailureEvents(recorder.events)).toHaveLength(0)
  })

  test("context overflow that compact refuses still does not fall through to provider retry", async () => {
    const provider = new FakeProvider({ steps: [{ error: "prompt is too large for this model" }] })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()
    let compactCalls = 0

    await expect(
      runBasicTurn({
        provider,
        state,
        recorder,
        compactOnOverflow: async () => {
          compactCalls += 1
          return false
        },
      }),
    ).rejects.toThrow("prompt is too large for this model")

    expect(compactCalls).toBe(1)
    expect(provider.requests).toHaveLength(1)
    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(providerRetryEvents(recorder.events)).toHaveLength(0)
    expect(providerFailureEvents(recorder.events)).toHaveLength(0)
  })

  test("provider retry and failure diagnostics stay replay-invisible", async () => {
    const retryProvider = new FakeProvider({
      steps: [
        { error: "OpenAI-compatible provider request failed: 500 transient" },
        { message: assistant("a1", "recovered") },
      ],
    })
    const retryState: TurnState = { messages: [] }
    const retryRecorder = createDraftRecorder()

    await runBasicTurn({ provider: retryProvider, state: retryState, recorder: retryRecorder })

    expect(providerRetryEvents(retryRecorder.events)).toHaveLength(1)
    expect(replayProviderMessages(materialize(retryRecorder.events))).toEqual(projectMessages(retryState.messages))
    expect(JSON.stringify(replayProviderMessages(materialize(retryRecorder.events)))).not.toContain("provider.retry")

    const failureProvider = new FakeProvider({
      steps: [
        { error: "OpenAI-compatible provider request failed: 500 still down" },
        { error: "OpenAI-compatible provider request failed: 500 still down" },
      ],
    })
    const failureState: TurnState = { messages: [] }
    const failureRecorder = createDraftRecorder()

    await expect(
      runBasicTurn({
        provider: failureProvider,
        state: failureState,
        recorder: failureRecorder,
        providerRetry: { maxRetries: 1, initialDelayMs: 0 },
      }),
    ).rejects.toThrow("500 still down")

    expect(providerRetryEvents(failureRecorder.events)).toHaveLength(1)
    expect(providerFailureEvents(failureRecorder.events)).toEqual([
      expect.objectContaining({ classification: "server_error", attempts: 2, retryable: true }),
    ])
    expect(replayProviderMessages(materialize(failureRecorder.events))).toEqual(projectMessages(failureState.messages))
    expect(JSON.stringify(replayProviderMessages(materialize(failureRecorder.events)))).not.toContain("provider.failure")
  })
})

function transientFailureScenarios(): Array<{
  name: string
  classification: string
  provider: () => RecordingProvider
}> {
  return [
    {
      name: "429 rate limit",
      classification: "rate_limit",
      provider: () => fakeProvider([{ error: "OpenAI-compatible provider request failed: 429 too many requests" }]),
    },
    {
      name: "429 token rate limit",
      classification: "rate_limit",
      provider: () => fakeProvider([{ error: "OpenAI-compatible provider request failed: 429 token rate limit exceeded" }]),
    },
    {
      name: "408 timeout",
      classification: "timeout",
      provider: () => fakeProvider([{ error: "OpenAI-compatible provider request failed: 408 request timeout" }]),
    },
    {
      name: "5xx server error",
      classification: "server_error",
      provider: () => fakeProvider([{ error: "OpenAI-compatible provider request failed: 503 service unavailable" }]),
    },
    {
      name: "network error",
      classification: "network_or_stream",
      provider: () => fakeProvider([{ error: "network ECONNRESET while streaming response" }]),
    },
    {
      name: "pre-delta empty stream drop",
      classification: "network_or_stream",
      provider: () => new SequenceProvider([async function* () {}, async function* () { yield assistantEvent("a1") }]),
    },
  ]
}

function fakeProvider(failingSteps: ConstructorParameters<typeof FakeProvider>[0]["steps"]): RecordingProvider {
  return new FakeProvider({ steps: [...failingSteps, { message: assistant("a1", "recovered") }] })
}

function assistantEvent(id: string): ModelEvent {
  return { type: "assistant_message", message: assistant(id, "recovered") }
}

type RecordingProvider = Provider & { readonly requests: ProviderRequest[] }

class SequenceProvider implements RecordingProvider {
  readonly requests: ProviderRequest[] = []
  private readonly streams: Array<(request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>>

  constructor(streams: Array<(request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>>) {
    this.streams = streams
  }

  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.length
    this.requests.push(request)
    const stream = this.streams[index]
    if (!stream) throw new Error(`SequenceProvider has no stream ${index}`)
    return stream(request, signal)
  }
}

function runBasicTurn(args: {
  provider: RecordingProvider
  state: TurnState
  recorder: ReturnType<typeof createDraftRecorder>
  signal?: AbortSignal
  toolRuntime?: FakeToolRuntime
  compactOnOverflow?: (input: { turnId: string; stepId: string; error: unknown }) => Promise<boolean>
  providerRetry?: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number }
}): Promise<RunTurnResult> {
  return runTurn({
    sessionId: "s1",
    turnId: "t1",
    userMessage: user(),
    state: args.state,
    provider: args.provider,
    toolRuntime: args.toolRuntime ?? new FakeToolRuntime(),
    signal: args.signal ?? new AbortController().signal,
    assembleProviderRequest: async ({ messages }) => ({ messages: projectMessages(messages) }),
    compactOnOverflow: args.compactOnOverflow,
    providerRetry: args.providerRetry ?? { maxRetries: 2, initialDelayMs: 0 },
    emit: args.recorder.emit,
    makeId: createIdFactory(),
  })
}

function providerRetryEvents(events: SessionEventDraft[]) {
  return events.filter((event) => event.type === "provider.retry")
}

function providerFailureEvents(events: SessionEventDraft[]) {
  return events.filter((event) => event.type === "provider.failure")
}

function materialize(events: SessionEventDraft[]): SessionEvent[] {
  return events.map(
    (event, index) =>
      ({
        seq: index + 1,
        timestamp: "2026-06-01T00:00:00.000Z",
        sessionId: "s1",
        ...event,
      }) as SessionEvent,
  )
}
