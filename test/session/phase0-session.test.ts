import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AgentSession } from "../../src/core/AgentSession"
import { ActiveTurnError, ProjectionError, TranscriptWriteError } from "../../src/core/errors"
import type { SessionEvent } from "../../src/core/events"
import { makeToolResultMessage } from "../../src/core/messages"
import { projectMessages } from "../../src/engine/messageProjection"
import { messagesFromEvents, readJsonlTranscript, replayProviderMessages } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { assistant, call, collectAsync, deferred, MemoryTranscriptSink } from "../helpers"

describe("Phase 0 session wrapper", () => {
  test("submit(user_message) emits turn.started and persists user.message before provider call", async () => {
    const transcript = new MemoryTranscriptSink()
    const seenAtProviderCall: string[][] = []
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "done") }],
      onRequest: () => {
        seenAtProviderCall.push(transcript.events.map((event) => (event as SessionEvent).type))
      },
    })
    const session = await AgentSession.create({
      id: "s1",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()
    const events = await collectAsync(session.events())

    expect(events.map((event) => event.type)).toContain("turn.started")
    expect(seenAtProviderCall[0]).toContain("user.message")
    expect(provider.requests).toHaveLength(1)
  })

  test("active turn guard rejects a second user message while a turn is running", async () => {
    const wait = deferred()
    const requested = deferred()
    const provider = new FakeProvider({
      steps: [{ waitBeforeMessage: wait.promise, message: assistant("a1", "done") }],
      onRequest: () => requested.resolve(),
    })
    const session = await AgentSession.create({
      id: "s1",
      provider,
      toolRuntime: new FakeToolRuntime(),
    })

    const first = session.submit({ type: "user_message", content: "one" })
    await requested.promise

    await expect(session.submit({ type: "user_message", content: "two" })).rejects.toThrow(ActiveTurnError)
    session.abort("stop")
    wait.resolve()
    await first
    await session.close()
  })

  test("transcript replay reconstructs the same provider messages as in-memory projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "light-cc-phase0-"))
    const transcriptPath = join(dir, "session.jsonl")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "tool", [call("c1", "echo", { value: 1 })]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await AgentSession.create({
      id: "s1",
      provider,
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "result" } } }),
      transcript: transcriptPath,
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    const events = await readJsonlTranscript(transcriptPath)
    const replayed = replayProviderMessages(events)
    const inMemory = projectMessages(session.getMessages())
    expect(replayed).toEqual(inMemory)
    expect(AgentSession.replayProviderMessages(events)).toEqual(inMemory)
    expect(session.projectProviderMessages()).toEqual(inMemory)
  })

  test("replay detects missing, duplicate, orphan, or reordered tool results", () => {
    const firstCall = call("c1", "echo")
    const secondCall = call("c2", "echo")
    const base = baseEvents(firstCall)
    const result = makeToolResultMessage({ id: "r1", call: firstCall, content: "ok" })

    expect(() => replayProviderMessages(base)).toThrow(ProjectionError)
    expect(() => replayProviderMessages([...base, event("tool.result", { result }), event("tool.result", { result })])).toThrow(
      ProjectionError,
    )
    expect(() => replayProviderMessages([event("user.message", { message: { id: "u1", role: "user", content: "x" } }), event("tool.result", { result })])).toThrow(
      ProjectionError,
    )
    expect(() =>
      replayProviderMessages([
        ...baseEvents(firstCall, secondCall),
        event("tool.result", { result: makeToolResultMessage({ id: "r2", call: secondCall, content: "second" }) }),
        event("tool.result", { result }),
      ]),
    ).toThrow(ProjectionError)
  })

  test("transcript write failure stops the turn and emits non-recoverable error", async () => {
    const transcript = new MemoryTranscriptSink("user.message")
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "should not run") }] })
    const session = await AgentSession.create({
      id: "s1",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
    })

    await expect(session.submit({ type: "user_message", content: "hello" })).rejects.toThrow(TranscriptWriteError)
    expect(provider.requests).toHaveLength(0)
    await session.close()
    const events = await collectAsync(session.events())
    expect(events.some((item) => item.type === "error" && item.recoverable === false)).toBe(true)
  })
})

function baseEvents(...toolCalls: ReturnType<typeof call>[]): SessionEvent[] {
  const calls = toolCalls.length > 0 ? toolCalls : [call("c1", "echo")]
  return [
    event("user.message", { message: { id: "u1", role: "user", content: "x" } }),
    event("assistant.message", { message: assistant("a1", "tool", calls) }),
  ]
}

function event(type: "user.message", fields: Pick<Extract<SessionEvent, { type: "user.message" }>, "message">): SessionEvent
function event(
  type: "assistant.message",
  fields: Pick<Extract<SessionEvent, { type: "assistant.message" }>, "message">,
): SessionEvent
function event(type: "tool.result", fields: Pick<Extract<SessionEvent, { type: "tool.result" }>, "result">): SessionEvent
function event(type: "user.message" | "assistant.message" | "tool.result", fields: Record<string, unknown>): SessionEvent {
  return {
    seq: 0,
    timestamp: "2026-05-31T00:00:00.000Z",
    sessionId: "s1",
    turnId: "t1",
    stepId: type === "user.message" ? undefined : "step1",
    type,
    ...fields,
  } as SessionEvent
}
