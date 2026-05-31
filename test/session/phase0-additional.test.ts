import { describe, expect, test } from "bun:test"
import { AgentSession } from "../../src/core/AgentSession"
import { ProjectionError, TranscriptWriteError } from "../../src/core/errors"
import type { SessionEvent } from "../../src/core/events"
import { makeToolResultMessage } from "../../src/core/messages"
import { projectMessages } from "../../src/engine/messageProjection"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { assistant, call, collectAsync } from "../helpers"

describe("Phase 0 additional session/transcript/replay coverage", () => {
  test("events() consumers each receive the complete stream and close terminates pending consumers", async () => {
    const session = new AgentSession({
      id: "s-events",
      cwd: "/workspace",
      provider: new FakeProvider({ steps: [{ message: assistant("a1", "unused") }] }),
      toolRuntime: new FakeToolRuntime(),
    })
    const first = collectAsync(session.events())
    const second = collectAsync(session.events())

    await session.start()
    await session.close()

    expect((await first).map((event) => event.type)).toEqual(["session.started", "context.session"])
    expect((await second).map((event) => event.type)).toEqual(["session.started", "context.session"])
  })

  test("concurrent start() calls emit a single session.started event", async () => {
    const transcript = new RecordingTranscriptSink()
    const session = new AgentSession({
      id: "s-start-concurrent",
      cwd: "/workspace",
      provider: new FakeProvider({ steps: [{ message: assistant("a1", "unused") }] }),
      toolRuntime: new FakeToolRuntime(),
      transcript,
    })

    await Promise.all([session.start(), session.start(), session.start()])
    await session.close()

    expect(transcript.events.map((event) => event.type)).toEqual(["session.started", "context.session"])
  })

  test("session.started write failure clears the start promise and can be retried", async () => {
    const transcript = new FailOnceTranscriptSink("session.started")
    const session = new AgentSession({
      id: "s-start-retry",
      cwd: "/workspace",
      provider: new FakeProvider({ steps: [{ message: assistant("a1", "unused") }] }),
      toolRuntime: new FakeToolRuntime(),
      transcript,
    })

    await expect(session.start()).rejects.toThrow(TranscriptWriteError)
    await session.start()
    await session.close()

    expect(transcript.events.map((event) => event.type)).toEqual(["session.started", "context.session"])
  })

  test("transcript records assistant, tool call, and tool result events in replay order", async () => {
    const transcript = new RecordingTranscriptSink()
    const toolCall = call("c1", "echo", { value: 1 })
    const session = await AgentSession.create({
      id: "s-order",
      cwd: "/workspace",
      provider: new FakeProvider({
        steps: [
          { message: assistant("a1", "tool", [toolCall]) },
          { message: assistant("a2", "done") },
        ],
      }),
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "ok" } } }),
      transcript,
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    const types = transcript.events.map((event) => event.type)
    expect(types).toEqual([
      "session.started",
      "context.session",
      "turn.started",
      "user.message",
      "step.started",
      "context.step",
      "assistant.message",
      "tool.call",
      "tool.result",
      "step.ended",
      "step.started",
      "context.step",
      "assistant.message",
      "step.ended",
      "turn.ended",
    ])
    expect(replayProviderMessages(transcript.events)).toEqual(projectMessages(session.getMessages()))
  })

  test("replay ignores non-message events while projecting provider messages", () => {
    const toolCall = call("c1", "echo", { value: 1 })
    const toolResult = makeToolResultMessage({ id: "r1", call: toolCall, content: "ok" })

    expect(
      replayProviderMessages([
        event("session.started", { cwd: "/workspace" }),
        event("turn.started", { turnId: "turn_1" }),
        event("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "hello" } }),
        event("step.started", { turnId: "turn_1", stepId: "step_1" }),
        event("assistant.delta", { turnId: "turn_1", stepId: "step_1", text: "ignored" }),
        event("assistant.message", { turnId: "turn_1", stepId: "step_1", message: assistant("a1", "tool", [toolCall]) }),
        event("tool.call", { turnId: "turn_1", stepId: "step_1", call: toolCall }),
        event("tool.result", { turnId: "turn_1", stepId: "step_1", result: toolResult }),
        event("step.ended", { turnId: "turn_1", stepId: "step_1", reason: "tool_results" }),
        event("error", { turnId: "turn_1", error: "ignored", recoverable: true }),
        event("turn.ended", { turnId: "turn_1", reason: "max_steps" }),
      ]),
    ).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "tool",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ value: 1 }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ])
  })

  test("replay rejects tool results that cross turn boundaries", () => {
    const toolCall = call("c1", "echo")
    const toolResult = makeToolResultMessage({ id: "r1", call: toolCall, content: "late" })

    expect(() =>
      replayProviderMessages([
        event("turn.started", { turnId: "turn_1" }),
        event("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "first" } }),
        event("step.started", { turnId: "turn_1", stepId: "step_1" }),
        event("assistant.message", { turnId: "turn_1", stepId: "step_1", message: assistant("a1", "tool", [toolCall]) }),
        event("step.ended", { turnId: "turn_1", stepId: "step_1", reason: "max_steps" }),
        event("turn.ended", { turnId: "turn_1", reason: "max_steps" }),
        event("turn.started", { turnId: "turn_2" }),
        event("tool.result", { turnId: "turn_2", stepId: "step_2", result: toolResult }),
      ]),
    ).toThrow(ProjectionError)
  })

  test("assistant.message transcript write failures reject before appending assistant history", async () => {
    const transcript = new FailAlwaysTranscriptSink("assistant.message")
    const session = await AgentSession.create({
      id: "s-assistant-fail",
      cwd: "/workspace",
      provider: new FakeProvider({ steps: [{ message: assistant("a1", "done") }] }),
      toolRuntime: new FakeToolRuntime(),
      transcript,
    })

    await expect(session.submit({ type: "user_message", content: "hello" })).rejects.toThrow(TranscriptWriteError)
    await session.close()

    expect(session.getMessages().map((message) => message.role)).toEqual(["user"])
    expect(transcript.events.map((item) => item.type)).toEqual([
      "session.started",
      "context.session",
      "turn.started",
      "user.message",
      "step.started",
      "context.step",
    ])
  })

  test("tool.result transcript write failures do not leave unpaired assistant tool calls in session state", async () => {
    const transcript = new FailAlwaysTranscriptSink("tool.result")
    const session = await AgentSession.create({
      id: "s-tool-result-fail",
      cwd: "/workspace",
      provider: new FakeProvider({ steps: [{ message: assistant("a1", "tool", [call("c1", "echo")]) }] }),
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "ok" } } }),
      transcript,
    })

    await expect(session.submit({ type: "user_message", content: "hello" })).rejects.toThrow(TranscriptWriteError)
    await session.close()

    expect(() => projectMessages(session.getMessages())).not.toThrow()
  })
})

class RecordingTranscriptSink implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

class FailOnceTranscriptSink extends RecordingTranscriptSink {
  private failed = false

  constructor(private readonly failType: SessionEvent["type"]) {
    super()
  }

  override async write(event: SessionEvent): Promise<void> {
    if (!this.failed && event.type === this.failType) {
      this.failed = true
      throw new Error(`fail once ${this.failType}`)
    }
    await super.write(event)
  }
}

class FailAlwaysTranscriptSink extends RecordingTranscriptSink {
  constructor(private readonly failType: SessionEvent["type"]) {
    super()
  }

  override async write(event: SessionEvent): Promise<void> {
    if (event.type === this.failType) {
      throw new Error(`fail always ${this.failType}`)
    }
    await super.write(event)
  }
}

function event(type: SessionEvent["type"], fields: Record<string, unknown>): SessionEvent {
  return {
    seq: 0,
    timestamp: "2026-05-31T00:00:00.000Z",
    sessionId: "s-replay",
    type,
    ...fields,
  } as SessionEvent
}
