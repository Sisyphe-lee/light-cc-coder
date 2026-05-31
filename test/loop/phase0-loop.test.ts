import { describe, expect, test } from "bun:test"
import { PairingError } from "../../src/core/errors"
import type { SessionEventDraft } from "../../src/core/events"
import type { TurnState } from "../../src/core/messages"
import { projectMessages } from "../../src/engine/messageProjection"
import { runTurn, type RunTurnInput } from "../../src/loop/runTurn"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { assistant, call, createDraftRecorder, createIdFactory, deferred, user } from "../helpers"

describe("Phase 0 loop kernel", () => {
  test("text-only turn completes after one assistant message", async () => {
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    const result = await runLoopTurn({
      sessionId: "s1",
      turnId: "t1",
      userMessage: user(),
      state,
      provider,
      toolRuntime: new FakeToolRuntime(),
      signal: new AbortController().signal,
      emit: recorder.emit,
      makeId: createIdFactory(),
    })

    expect(result.reason).toBe("completed")
    expect(provider.requests).toHaveLength(1)
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(recorder.events.map((event) => event.type)).toContain("turn.ended")
  })

  test("single tool call appends exactly one matching result and continues", async () => {
    const toolCall = call("c1", "echo", { text: "x" })
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "need tool", [toolCall]) },
        { message: assistant("a2", "done") },
      ],
    })
    const state: TurnState = { messages: [] }

    const result = await runLoopTurn({
      sessionId: "s1",
      turnId: "t1",
      userMessage: user(),
      state,
      provider,
      toolRuntime: new FakeToolRuntime({
        tools: { echo: { handler: (input) => JSON.stringify(input) } },
      }),
      signal: new AbortController().signal,
      emit: createDraftRecorder().emit,
      makeId: createIdFactory(),
    })

    expect(result.reason).toBe("completed")
    expect(provider.requests).toHaveLength(2)
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const toolResult = state.messages[2]
    expect(toolResult.role).toBe("tool")
    if (toolResult.role === "tool") {
      expect(toolResult.toolCallId).toBe("c1")
      expect(toolResult.isError).toBe(false)
    }
  })

  test("multiple tool calls append results in provider order", async () => {
    const calls = [call("c1", "one"), call("c2", "two")]
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "tools", calls) },
        { message: assistant("a2", "done") },
      ],
    })
    const state: TurnState = { messages: [] }

    await runLoopTurn({
      sessionId: "s1",
      turnId: "t1",
      userMessage: user(),
      state,
      provider,
      toolRuntime: new FakeToolRuntime({
        tools: {
          one: { handler: () => "1" },
          two: { handler: () => "2" },
        },
      }),
      signal: new AbortController().signal,
      emit: createDraftRecorder().emit,
      makeId: createIdFactory(),
    })

    const results = state.messages.filter((message) => message.role === "tool")
    expect(results.map((result) => (result.role === "tool" ? result.toolCallId : ""))).toEqual(["c1", "c2"])
  })

  test("unknown tool becomes isError true tool result", async () => {
    const result = await runToolErrorCase(new FakeToolRuntime(), call("c1", "missing"))
    expect(result.isError).toBe(true)
    expect(result.content).toContain("Unknown tool")
  })

  test("invalid tool input becomes isError true tool result", async () => {
    const result = await runToolErrorCase(
      new FakeToolRuntime({
        tools: { validate_me: { validate: () => "bad input", handler: () => "unused" } },
      }),
      call("c1", "validate_me"),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain("bad input")
  })

  test("tool exception becomes isError true tool result", async () => {
    const result = await runToolErrorCase(
      new FakeToolRuntime({
        tools: {
          explode: {
            handler: () => {
              throw new Error("boom")
            },
          },
        },
      }),
      call("c1", "explode"),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain("boom")
  })

  test("fake runtime pairing violation emits fatal error", async () => {
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "tools", [call("c1", "echo")]) }] })
    const state: TurnState = { messages: [] }
    const recorder = createDraftRecorder()

    await expect(
      runLoopTurn({
        sessionId: "s1",
        turnId: "t1",
        userMessage: user(),
        state,
        provider,
        toolRuntime: new FakeToolRuntime({
          tools: { echo: { handler: () => "x" } },
          violation: "missing",
        }),
        signal: new AbortController().signal,
        emit: recorder.emit,
        makeId: createIdFactory(),
      }),
    ).rejects.toThrow(PairingError)

    const fatal = recorder.events.find((event) => event.type === "error")
    expect(fatal).toMatchObject({ type: "error", recoverable: false })
  })

  test("maxSteps pairs final tool calls before ending", async () => {
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "tools", [call("c1", "echo")]) }] })
    const state: TurnState = { messages: [] }

    const result = await runLoopTurn({
      sessionId: "s1",
      turnId: "t1",
      userMessage: user(),
      state,
      provider,
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "x" } } }),
      signal: new AbortController().signal,
      maxSteps: 1,
      emit: createDraftRecorder().emit,
      makeId: createIdFactory(),
    })

    expect(result.reason).toBe("max_steps")
    expect(provider.requests).toHaveLength(1)
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
  })

  test("abort before final assistant does not append partial assistant history", async () => {
    const wait = deferred()
    const provider = new FakeProvider({
      steps: [{ deltas: ["partial"], waitBeforeMessage: wait.promise, message: assistant("a1", "late") }],
    })
    const state: TurnState = { messages: [] }
    const controller = new AbortController()
    const recorder = createDraftRecorder()

    const running = runLoopTurn({
      sessionId: "s1",
      turnId: "t1",
      userMessage: user(),
      state,
      provider,
      toolRuntime: new FakeToolRuntime(),
      signal: controller.signal,
      emit: recorder.emit,
      makeId: createIdFactory(),
    })

    while (!recorder.events.some((event) => event.type === "assistant.delta")) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    controller.abort("stop")

    const result = await running
    expect(result.reason).toBe("aborted")
    expect(state.messages.map((message) => message.role)).toEqual(["user"])
    expect(recorder.events.some((event) => event.type === "assistant.message")).toBe(false)
  })

  test("abort after assistant tool calls appends abort results for every pending call", async () => {
    const calls = [call("c1", "echo"), call("c2", "echo")]
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "tools", calls) }] })
    const state: TurnState = { messages: [] }
    const controller = new AbortController()
    const recorder: SessionEventDraft[] = []

    const result = await runLoopTurn({
      sessionId: "s1",
      turnId: "t1",
      userMessage: user(),
      state,
      provider,
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "should not run" } } }),
      signal: controller.signal,
      emit: async (event) => {
        recorder.push(event)
        if (event.type === "assistant.message") controller.abort("after assistant")
      },
      makeId: createIdFactory(),
    })

    expect(result.reason).toBe("aborted")
    const results = state.messages.filter((message) => message.role === "tool")
    expect(results).toHaveLength(2)
    expect(results.map((message) => (message.role === "tool" ? message.isError : false))).toEqual([true, true])
    expect(results.map((message) => (message.role === "tool" ? message.toolCallId : ""))).toEqual(["c1", "c2"])
  })
})

async function runToolErrorCase(toolRuntime: FakeToolRuntime, toolCall: ReturnType<typeof call>) {
  const provider = new FakeProvider({
    steps: [
      { message: assistant("a1", "tool", [toolCall]) },
      { message: assistant("a2", "done") },
    ],
  })
  const state: TurnState = { messages: [] }
  await runLoopTurn({
    sessionId: "s1",
    turnId: "t1",
    userMessage: user(),
    state,
    provider,
    toolRuntime,
    signal: new AbortController().signal,
    emit: createDraftRecorder().emit,
    makeId: createIdFactory(),
  })
  const result = state.messages.find((message) => message.role === "tool")
  expect(result?.role).toBe("tool")
  if (!result || result.role !== "tool") {
    throw new Error("Expected a tool result")
  }
  return result
}

function runLoopTurn(input: Omit<RunTurnInput, "assembleProviderRequest">) {
  return runTurn({
    ...input,
    assembleProviderRequest: async ({ messages }) => ({ messages: projectMessages(messages) }),
  })
}
