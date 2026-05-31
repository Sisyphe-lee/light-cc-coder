import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { TranscriptWriteError } from "../../src/core/errors"
import type { SessionEvent } from "../../src/core/events"
import { makeToolResultMessage } from "../../src/core/messages"
import { projectMessages, projectMessagesWithDiagnostics } from "../../src/engine/messageProjection"
import { readJsonlTranscript, replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { ToolRegistry } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace, user } from "../helpers"

describe("Phase 4 compact-first context management", () => {
  test("large tool result is persisted as one artifact and one paired preview result", async () => {
    const workspaceRoot = await createTempWorkspace("light-cc-phase4-workspace-")
    const transcriptRoot = await createTempWorkspace("light-cc-phase4-transcript-")
    const transcriptPath = join(transcriptRoot, "session.jsonl")
    const hugeContent = "A".repeat(256)
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "need huge", [call("c1", "huge")]) },
        { message: assistant("a2", "done") },
      ],
    })
    const workspace = await WorkspaceFs.create(workspaceRoot)
    const session = await AgentSession.create({
      id: "s-artifact",
      cwd: workspaceRoot,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: hugeRegistry(hugeContent),
        workspace,
        maxResultBytes: 512,
      }),
      transcript: transcriptPath,
      toolResultArtifactBytes: 64,
      toolResultPreviewBytes: 32,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "run huge" })
    await session.close()

    const events = await readJsonlTranscript(transcriptPath)
    const artifacts = events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.artifact" }> => event.type === "tool.artifact",
    )
    const results = events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(artifacts).toHaveLength(1)
    expect(results.filter((event) => event.result.toolCallId === "c1")).toHaveLength(1)
    expect(results[0].result.content).toContain("large tool result persisted")
    expect(results[0].result.content).not.toContain("A".repeat(128))
    expect(await readFile(artifacts[0].path, "utf8")).toBe(hugeContent)
    expect(artifacts[0].path).toContain(`${transcriptPath}.artifacts`)
    expect(replayProviderMessages(events)).toEqual(projectMessages(session.getMessages()))
  })

  test("history projection snips old large tool results without mutating canonical messages", () => {
    const oldResult = "old-output-".repeat(30)
    const recentResult = "recent-output-".repeat(30)
    const oldTool = makeToolResultMessage({ id: "r1", call: call("c1", "bash"), content: oldResult })
    const recentTool = makeToolResultMessage({ id: "r2", call: call("c2", "bash"), content: recentResult })
    const messages = [
      user("u1", "start"),
      assistant("a1", "old tool", [call("c1", "bash")]),
      oldTool,
      user("u2", "continue"),
      assistant("a2", "recent tool", [call("c2", "bash")]),
      recentTool,
    ]

    const projected = projectMessagesWithDiagnostics(messages, {
      snip: { enabled: true, recentMessageCount: 3, minToolResultBytes: 16 },
    })

    expect(projected.diagnostics.snippedToolResults).toBe(1)
    expect(projected.messages[2]).toMatchObject({
      role: "tool",
      content: "[snipped old tool result: bash, original bytes=330, kept in transcript]",
    })
    expect(projected.messages[5]).toMatchObject({ role: "tool", content: recentResult })
    expect(oldTool.content).toBe(oldResult)
  })

  test("manual compact writes a checkpoint, keeps a pairing-safe tail, and replay uses the checkpoint", async () => {
    const transcript = new RecordingTranscriptSink()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "first") },
        { message: assistant("a2", "need tool", [call("c1", "echo")]) },
        { message: assistant("a3", "tool done") },
        { message: assistant("a4", "third") },
        { message: assistant("compact_a1", "Summary: prior work and constraints.") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-compact",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "tool output" } } }),
      transcript,
      compactTailMessages: 5,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "one" })
    await session.submit({ type: "user_message", content: "two" })
    await session.submit({ type: "user_message", content: "three" })
    await session.submit({ type: "compact.request", id: "compact_manual" })
    await session.close()

    expect(transcript.events.some((event) => event.type === "compact.started")).toBe(true)
    const ended = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "compact.ended"; status: "succeeded" }> =>
        event.type === "compact.ended" && event.status === "succeeded",
    )
    expect(ended?.tailStartMessageId).toBe("a2")
    expect(session.getMessages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ])
    expect(session.getMessages()[0]).toMatchObject({ role: "user" })
    expect(replayProviderMessages(transcript.events)).toEqual(projectMessages(session.getMessages()))
  })

  test("auto compact runs before a provider request crosses the hard threshold", async () => {
    const transcript = new RecordingTranscriptSink()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "large prior answer ".repeat(80)) },
        { message: assistant("compact_auto_a1", "Summary: large prior answer.") },
        { message: assistant("a2", "after compact") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-auto-compact",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      contextBudget: { maxContextTokens: 1_000, hardCompactTokens: 120, blockingTokens: 10_000 },
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "first" })
    await session.submit({ type: "user_message", content: "second" })
    await session.close()

    const compactStarted = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "compact.started" }> => event.type === "compact.started",
    )
    expect(compactStarted?.trigger).toBe("auto")
    expect(session.getMessages()[0]).toMatchObject({ role: "user" })
    expect(provider.requests.at(-1)?.messages.some((message) => message.content.includes("Summary: large prior"))).toBe(true)
  })

  test("provider context overflow compacts and retries only once", async () => {
    const transcript = new RecordingTranscriptSink()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "large prior answer ".repeat(40)) },
        { error: "context length too large" },
        { message: assistant("compact_overflow_a1", "Summary: overflow recovery.") },
        { message: assistant("a2", "retry succeeded") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-overflow",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      contextBudget: { maxContextTokens: 100_000, hardCompactTokens: 90_000, blockingTokens: 95_000 },
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "first" })
    await session.submit({ type: "user_message", content: "second" })
    await session.close()

    const started = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "compact.started" }> => event.type === "compact.started",
    )
    expect(started.map((event) => event.trigger)).toEqual(["overflow_retry"])
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", content: "retry succeeded" })
    expect(provider.requests).toHaveLength(4)
  })

  test("compact prompt too large retry drops oldest complete groups and succeeds", async () => {
    const transcript = new RecordingTranscriptSink()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "first") },
        { message: assistant("a2", "second") },
        { message: assistant("a3", "third") },
        { error: "prompt is too large" },
        { message: assistant("compact_retry_a1", "Summary after dropping oldest group.") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-compact-retry",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "one" })
    await session.submit({ type: "user_message", content: "two" })
    await session.submit({ type: "user_message", content: "three" })
    await session.submit({ type: "compact.request", id: "compact_retry" })
    await session.close()

    const ended = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "compact.ended"; status: "succeeded" }> =>
        event.type === "compact.ended" && event.status === "succeeded",
    )
    expect(ended?.omittedOldestGroups).toBe(1)
    expect(ended?.summarizedMessageCount).toBe(4)
    expect(session.getMessages()[0]?.role).toBe("user")
    expect(session.getMessages()[0]?.content).toContain("oldest complete message groups were omitted")
  })

  test("manual compact failure leaves active history unchanged", async () => {
    const transcript = new RecordingTranscriptSink()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "first") },
        { message: assistant("a2", "second") },
        { error: "summary model unavailable" },
      ],
    })
    const session = await AgentSession.create({
      id: "s-compact-fail",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "one" })
    await session.submit({ type: "user_message", content: "two" })
    const before = session.getMessages()
    await session.submit({ type: "compact.request", id: "compact_fail" })
    await session.close()

    expect(session.getMessages()).toEqual(before)
    const ended = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "compact.ended"; status: "failed" }> =>
        event.type === "compact.ended" && event.status === "failed",
    )
    expect(ended?.error).toContain("summary model unavailable")
  })

  test("transcript failure while ending compact is fatal and does not switch active history", async () => {
    const transcript = new FailingTranscriptSink("compact.ended")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "first") },
        { message: assistant("a2", "second") },
        { message: assistant("compact_write_fail_a1", "Summary that cannot be persisted.") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-compact-write-fail",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "one" })
    await session.submit({ type: "user_message", content: "two" })
    const before = session.getMessages()
    await expect(session.submit({ type: "compact.request", id: "compact_write_fail" })).rejects.toThrow(
      TranscriptWriteError,
    )
    await session.close()

    expect(session.getMessages()).toEqual(before)
  })
})

class RecordingTranscriptSink implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

class FailingTranscriptSink extends RecordingTranscriptSink {
  constructor(private readonly failOn: string) {
    super()
  }

  override async write(event: SessionEvent): Promise<void> {
    if (event.type === this.failOn) {
      throw new Error(`fail ${this.failOn}`)
    }
    await super.write(event)
  }
}

function hugeRegistry(content: string): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: "huge",
    description: "Return a huge payload",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
    parse: () => ({}),
    execute: async () => ({ content }),
  })
  return registry
}
