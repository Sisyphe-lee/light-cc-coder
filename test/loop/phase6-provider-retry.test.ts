import { describe, expect, test } from "bun:test"
import type { SessionEventDraft } from "../../src/core/events"
import type { TurnState } from "../../src/core/messages"
import { projectMessages } from "../../src/engine/messageProjection"
import { runTurn } from "../../src/loop/runTurn"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { assistant, createDraftRecorder, createIdFactory, user } from "../helpers"

describe("Phase 6 provider retry classification", () => {
  test("retries transient pre-delta provider failures before committing assistant history", async () => {
    const provider = new FakeProvider({
      steps: [
        { error: "OpenAI-compatible provider request failed: 500 temporarily unavailable" },
        { message: assistant("a1", "recovered") },
      ],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    const result = await runBasicTurn({ provider, state, recorder })

    expect(result.reason).toBe("completed")
    expect(provider.requests).toHaveLength(2)
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(providerRetryEvents(recorder.events)).toEqual([
      expect.objectContaining({ classification: "server_error", attempt: 1, nextAttempt: 2, delayMs: 0 }),
    ])
    expect(providerFailureEvents(recorder.events)).toHaveLength(0)
  })

  test("does not retry provider failures after assistant delta", async () => {
    const provider = new FakeProvider({
      steps: [{ deltas: ["partial"], error: "OpenAI-compatible provider request failed: 500 after delta" }],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    await expect(runBasicTurn({ provider, state, recorder })).rejects.toThrow("500 after delta")

    expect(provider.requests).toHaveLength(1)
    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(providerRetryEvents(recorder.events)).toHaveLength(0)
    expect(providerFailureEvents(recorder.events)).toEqual([
      expect.objectContaining({ classification: "partial_delta_failure", hadAssistantDelta: true, retryable: false }),
    ])
  })

  test("does not retry auth errors or ordinary client errors", async () => {
    for (const [message, classification] of [
      ["OpenAI-compatible provider request failed: 401 bad key", "auth_error"],
      ["OpenAI-compatible provider request failed: 400 invalid request", "client_error"],
    ] as const) {
      const provider = new FakeProvider({ steps: [{ error: message }] })
      const state: TurnState = { messages: [] }
      const recorder = createDraftRecorder()

      await expect(runBasicTurn({ provider, state, recorder })).rejects.toThrow(message)

      expect(provider.requests).toHaveLength(1)
      expect(providerRetryEvents(recorder.events)).toHaveLength(0)
      expect(providerFailureEvents(recorder.events)).toEqual([
        expect.objectContaining({ classification, retryable: false }),
      ])
    }
  })

  test("context overflow stays on compact retry path instead of ordinary provider retry", async () => {
    const provider = new FakeProvider({
      steps: [{ error: "context length too large" }, { message: assistant("a1", "after compact") }],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()
    let compactCalls = 0

    const result = await runBasicTurn({
      provider,
      state,
      recorder,
      compactOnOverflow: async () => {
        compactCalls += 1
        return true
      },
    })

    expect(result.reason).toBe("completed")
    expect(compactCalls).toBe(1)
    expect(provider.requests).toHaveLength(2)
    expect(providerRetryEvents(recorder.events)).toHaveLength(0)
    expect(providerFailureEvents(recorder.events)).toHaveLength(0)
  })
})

function runBasicTurn(args: {
  provider: FakeProvider
  state: TurnState
  recorder: ReturnType<typeof createDraftRecorder>
  compactOnOverflow?: () => Promise<boolean>
}) {
  return runTurn({
    sessionId: "s1",
    turnId: "t1",
    userMessage: user(),
    state: args.state,
    provider: args.provider,
    toolRuntime: new FakeToolRuntime(),
    signal: new AbortController().signal,
    assembleProviderRequest: async ({ messages }) => ({ messages: projectMessages(messages) }),
    compactOnOverflow: args.compactOnOverflow,
    providerRetry: { maxRetries: 2, initialDelayMs: 0 },
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
