import { describe, expect, test } from "bun:test"
import { AbortTurnError, PairingError } from "../../src/core/errors"
import { makeToolResultMessage, type ToolCall, type ToolResultMessage, type TurnState } from "../../src/core/messages"
import { projectMessages } from "../../src/engine/messageProjection"
import { runTurn } from "../../src/loop/runTurn"
import { FakeProvider } from "../../src/providers/FakeProvider"
import type { ModelEvent, Provider, ProviderRequest } from "../../src/providers/types"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import type { ToolContext, ToolRuntime } from "../../src/tools/ToolRuntime"
import { assistant, call, createDraftRecorder, createIdFactory, deferred, user } from "../helpers"

describe("Phase 0 loop kernel additional coverage", () => {
  test("provider error event emits fatal error and does not append partial assistant history", async () => {
    const provider = new FakeProvider({ steps: [{ deltas: ["partial"], error: "provider down" }] })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    await expect(runBasicTurn({ provider, state, recorder })).rejects.toThrow("provider down")

    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(recorder.events.map((event) => event.type)).toEqual([
      "turn.started",
      "user.message",
      "step.started",
      "assistant.delta",
      "provider.failure",
      "error",
      "step.ended",
      "turn.ended",
    ])
    expect(recorder.events.find((event) => event.type === "provider.failure")).toMatchObject({
      type: "provider.failure",
      classification: "partial_delta_failure",
      retryable: false,
      hadAssistantDelta: true,
    })
    expect(recorder.events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      error: "provider down",
      recoverable: false,
    })
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.ended", reason: "error" })
  })

  test("provider empty stream is fatal and does not append an assistant message", async () => {
    const provider: Provider = {
      async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {},
    }
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    await expect(runBasicTurn({ provider, state, recorder })).rejects.toThrow(
      "Provider stream ended without an assistant message",
    )

    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(recorder.events.some((event) => event.type === "assistant.message")).toBe(false)
    expect(recorder.events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      recoverable: false,
    })
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.ended", reason: "error" })
  })

  test("tool runtime batch throw becomes model-visible error results and continuation proceeds", async () => {
    const toolCall = call("c1", "explode_batch")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "tool", [toolCall]) },
        { message: assistant("a2", "done") },
      ],
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()
    const runtime: ToolRuntime = {
      async runBatch(_calls: ToolCall[], _ctx: ToolContext): Promise<ToolResultMessage[]> {
        throw new Error("runtime unavailable")
      },
    }

    const result = await runBasicTurn({ provider, toolRuntime: runtime, state, recorder })

    expect(result.reason).toBe("completed")
    expect(provider.requests).toHaveLength(2)
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const toolResult = state.messages.find((message) => message.role === "tool")
    expect(toolResult).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      toolName: "explode_batch",
      isError: true,
    })
    expect(toolResult?.content).toContain("Tool runtime error: runtime unavailable")
    expect(recorder.events.map((event) => event.type)).toContain("tool.result")
  })

  for (const scenario of pairingScenarios()) {
    test(`pairing violation from tool runtime is fatal: ${scenario.name}`, async () => {
      const provider = new FakeProvider({ steps: [{ message: assistant("a1", "tools", scenario.calls) }] })
      const state: TurnState = { messages: [] }
      const recorder = createDraftRecorder()
      const runtime: ToolRuntime = {
        async runBatch(_calls: ToolCall[], _ctx: ToolContext): Promise<ToolResultMessage[]> {
          return scenario.results
        },
      }

      await expect(runBasicTurn({ provider, toolRuntime: runtime, state, recorder })).rejects.toThrow(PairingError)

      const toolResults = recorder.events.filter((event) => event.type === "tool.result")
      expect(toolResults).toHaveLength(scenario.calls.length)
      expect(toolResults.map((event) => (event.type === "tool.result" ? event.result.toolCallId : ""))).toEqual(
        scenario.calls.map((item) => item.id),
      )
      expect(
        toolResults.every(
          (event) =>
            event.type === "tool.result" &&
            event.result.isError &&
            event.result.content.includes("Tool runtime pairing violation"),
        ),
      ).toBe(true)
      expect(recorder.events.find((event) => event.type === "error")).toMatchObject({
        type: "error",
        recoverable: false,
      })
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.ended", reason: "error" })
    })
  }

  for (const maxSteps of [0, -1]) {
    test(`maxSteps=${maxSteps} is exhausted before provider call`, async () => {
      const provider = new FakeProvider({ steps: [{ message: assistant("a1", "should not run") }] })
      const state: TurnState = { messages: [] }
      const recorder = createDraftRecorder()

      const result = await runBasicTurn({ provider, state, recorder, maxSteps })

      expect(result).toEqual({ reason: "max_steps", steps: 0 })
      expect(provider.requests).toHaveLength(0)
      expect(state.messages.map((message) => message.role)).toEqual(["user"])
      expect(recorder.events.map((event) => event.type)).toEqual(["turn.started", "user.message", "turn.ended"])
    })
  }

  test("abort during tool runtime appends abort results for pending calls", async () => {
    const calls = [call("c1", "slow"), call("c2", "slow")]
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "tools", calls) }] })
    const state: TurnState = { messages: [] }
    const controller = new AbortController()
    const enteredRuntime = deferred<void>()
    const recorder = createDraftRecorder()
    const runtime: ToolRuntime = {
      async runBatch(_calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]> {
        enteredRuntime.resolve()
        return new Promise<ToolResultMessage[]>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new AbortTurnError("tool stopped")), { once: true })
        })
      },
    }

    const running = runBasicTurn({ provider, toolRuntime: runtime, state, recorder, signal: controller.signal })
    await enteredRuntime.promise
    controller.abort("tool stopped")

    const result = await running
    const toolResults = state.messages.filter((message) => message.role === "tool")

    expect(result.reason).toBe("aborted")
    expect(toolResults).toHaveLength(2)
    expect(toolResults.map((message) => (message.role === "tool" ? message.toolCallId : ""))).toEqual(["c1", "c2"])
    expect(toolResults.every((message) => message.role === "tool" && message.isError)).toBe(true)
    expect(toolResults.map((message) => (message.role === "tool" ? message.content : ""))).toEqual([
      "Tool call aborted: tool stopped",
      "Tool call aborted: tool stopped",
    ])
  })

  test("abort does not hang when provider ignores the abort signal", async () => {
    const provider: Provider = {
      stream(): AsyncIterable<ModelEvent> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<ModelEvent>>(() => {}),
              return: async () => ({ value: undefined, done: true }),
            }
          },
        }
      },
    }
    const state: TurnState = { messages: [] }
    const controller = new AbortController()
    const recorder = createDraftRecorder()

    const running = runBasicTurn({ provider, state, recorder, signal: controller.signal })
    while (!recorder.events.some((event) => event.type === "step.started")) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    controller.abort("provider stopped")

    const result = await running

    expect(result.reason).toBe("aborted")
    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.ended", reason: "aborted" })
  })

  test("abort does not hang when tool runtime ignores the abort signal", async () => {
    const calls = [call("c1", "stuck"), call("c2", "stuck")]
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "tools", calls) }] })
    const state: TurnState = { messages: [] }
    const controller = new AbortController()
    const recorder = createDraftRecorder()
    const runtime: ToolRuntime = {
      async runBatch(_calls: ToolCall[], _ctx: ToolContext): Promise<ToolResultMessage[]> {
        return new Promise<ToolResultMessage[]>(() => {})
      },
    }

    const running = runBasicTurn({ provider, toolRuntime: runtime, state, recorder, signal: controller.signal })
    while (!recorder.events.some((event) => event.type === "tool.call")) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    controller.abort("tool runtime stopped")

    const result = await running
    const toolResults = state.messages.filter((message) => message.role === "tool")

    expect(result.reason).toBe("aborted")
    expect(toolResults).toHaveLength(2)
    expect(toolResults.map((message) => (message.role === "tool" ? message.toolCallId : ""))).toEqual(["c1", "c2"])
    expect(toolResults.every((message) => message.role === "tool" && message.isError)).toBe(true)
  })

  test("event order records tool results before continuation provider request", async () => {
    const seenAtProvider: string[][] = []
    const provider = new FakeProvider({
      steps: [
        { deltas: ["thinking"], message: assistant("a1", "tool", [call("c1", "echo")]) },
        { message: assistant("a2", "done") },
      ],
      onRequest: () => {
        seenAtProvider.push(recorder.events.map((event) => event.type))
      },
    })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    const result = await runBasicTurn({
      provider,
      state,
      recorder,
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "ok" } } }),
    })

    expect(result.reason).toBe("completed")
    expect(recorder.events.map((event) => event.type)).toEqual([
      "turn.started",
      "user.message",
      "step.started",
      "assistant.delta",
      "assistant.message",
      "tool.call",
      "tool.result",
      "step.ended",
      "step.started",
      "assistant.message",
      "step.ended",
      "turn.ended",
    ])
    expect(seenAtProvider).toHaveLength(2)
    expect(seenAtProvider[1]).toContain("tool.result")
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
  })
})

function pairingScenarios(): Array<{
  name: string
  calls: ToolCall[]
  results: ToolResultMessage[]
}> {
  const first = call("c1", "echo")
  const second = call("c2", "echo")
  return [
    {
      name: "duplicate result",
      calls: [first, second],
      results: [resultFor(first, "r1"), resultFor(first, "r2")],
    },
    {
      name: "reordered result",
      calls: [first, second],
      results: [resultFor(second, "r1"), resultFor(first, "r2")],
    },
    {
      name: "orphan result",
      calls: [first],
      results: [
        {
          id: "orphan_result",
          role: "tool",
          toolCallId: "orphan_call",
          toolName: "echo",
          content: "orphan",
          isError: true,
        },
      ],
    },
  ]
}

function resultFor(toolCall: ToolCall, id: string): ToolResultMessage {
  return makeToolResultMessage({ id, call: toolCall, content: "ok" })
}

function runBasicTurn(args: {
  provider: Provider
  state: TurnState
  recorder: ReturnType<typeof createDraftRecorder>
  toolRuntime?: ToolRuntime
  signal?: AbortSignal
  maxSteps?: number
}) {
  return runTurn({
    sessionId: "s1",
    turnId: "t1",
    userMessage: user(),
    state: args.state,
    provider: args.provider,
    toolRuntime: args.toolRuntime ?? new FakeToolRuntime(),
    signal: args.signal ?? new AbortController().signal,
    maxSteps: args.maxSteps,
    assembleProviderRequest: async ({ messages }) => ({ messages: projectMessages(messages) }),
    emit: args.recorder.emit,
    makeId: createIdFactory(),
  })
}
