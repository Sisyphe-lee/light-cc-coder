import { describe, expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { makeToolResultMessage } from "../../src/core/messages"
import { messagesFromEvents, readJsonlTranscript, replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { SessionStore, type SessionMetadata } from "../../src/cli/sessionStore"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 7 resume/replay core invariants", () => {
  test("SessionStore resume rejects missing, duplicate, reordered, and orphan tool results", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const toolCall = call("c1", "echo")
    const secondCall = call("c2", "echo")
    const result = makeToolResultMessage({ id: "r1", call: toolCall, content: "ok" })
    const secondResult = makeToolResultMessage({ id: "r2", call: secondCall, content: "second" })

    const cases: Array<{ id: string; fragment: string; events: SessionEvent[] }> = [
      {
        id: "missing",
        fragment: "Missing tool result",
        events: visibleEvents("missing", root, [
          draft("turn.started", { turnId: "turn_1" }),
          draft("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "hello" } }),
          draft("step.started", { turnId: "turn_1", stepId: "step_1" }),
          draft("assistant.message", { turnId: "turn_1", stepId: "step_1", message: assistant("a1", "tool", [toolCall]) }),
          draft("step.ended", { turnId: "turn_1", stepId: "step_1", reason: "tool_results" }),
        ]),
      },
      {
        id: "duplicate",
        fragment: "Duplicate tool result",
        events: visibleEvents("duplicate", root, [
          draft("turn.started", { turnId: "turn_1" }),
          draft("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "hello" } }),
          draft("step.started", { turnId: "turn_1", stepId: "step_1" }),
          draft("assistant.message", { turnId: "turn_1", stepId: "step_1", message: assistant("a1", "tool", [toolCall]) }),
          draft("tool.result", { turnId: "turn_1", stepId: "step_1", result }),
          draft("tool.result", { turnId: "turn_1", stepId: "step_1", result }),
        ]),
      },
      {
        id: "reordered",
        fragment: "Reordered tool result",
        events: visibleEvents("reordered", root, [
          draft("turn.started", { turnId: "turn_1" }),
          draft("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "hello" } }),
          draft("step.started", { turnId: "turn_1", stepId: "step_1" }),
          draft("assistant.message", {
            turnId: "turn_1",
            stepId: "step_1",
            message: assistant("a1", "tool", [toolCall, secondCall]),
          }),
          draft("tool.result", { turnId: "turn_1", stepId: "step_1", result: secondResult }),
          draft("tool.result", { turnId: "turn_1", stepId: "step_1", result }),
        ]),
      },
      {
        id: "orphan",
        fragment: "Orphan tool result",
        events: visibleEvents("orphan", root, [
          draft("turn.started", { turnId: "turn_1" }),
          draft("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "hello" } }),
          draft("tool.result", { turnId: "turn_1", stepId: "step_1", result }),
        ]),
      },
    ]

    const store = new SessionStore(dataRoot)
    for (const item of cases) {
      await writeStoredSession(dataRoot, item.id, root, item.events)
      await expect(store.resolveResume({ id: item.id }, root)).rejects.toThrow(item.fragment)
    }
  })

  test("resume projection uses canonical compact events and preserves a paired active tail", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const sessionId = "compacted_tail"
    const toolCall = call("c1", "echo", { value: 1 })
    const toolResult = makeToolResultMessage({ id: "r1", call: toolCall, content: "tool-ok" })
    const events = visibleEvents(sessionId, root, [
      draft("turn.started", { turnId: "turn_1" }),
      draft("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "old prompt" } }),
      draft("assistant.message", {
        turnId: "turn_1",
        stepId: "step_1",
        message: assistant("a1", "old answer"),
      }),
      draft("turn.ended", { turnId: "turn_1", reason: "completed" }),
      draft("turn.started", { turnId: "turn_2" }),
      draft("user.message", { turnId: "turn_2", message: { id: "u2", role: "user", content: "kept prompt" } }),
      draft("assistant.message", {
        turnId: "turn_2",
        stepId: "step_2",
        message: assistant("a2", "need tool", [toolCall]),
      }),
      draft("tool.result", { turnId: "turn_2", stepId: "step_2", result: toolResult }),
      draft("turn.ended", { turnId: "turn_2", reason: "completed" }),
      draft("compact.started", {
        compactId: "compact_1",
        trigger: "manual",
        preCompactMessageCount: 5,
        estimatedTokens: 100,
      }),
      draft("compact.ended", {
        compactId: "compact_1",
        trigger: "manual",
        status: "succeeded",
        summaryMessage: { id: "compact_1_summary", role: "user", content: "Summary of old work." },
        summaryHash: "summary-hash",
        tailStartMessageId: "u2",
        summarizedMessageCount: 2,
        keptMessageCount: 3,
        preCompactEstimatedTokens: 100,
        postCompactEstimatedTokens: 30,
        omittedOldestGroups: 0,
      }),
      draft("turn.started", { turnId: "turn_3" }),
      draft("user.message", { turnId: "turn_3", message: { id: "u3", role: "user", content: "after compact" } }),
      draft("assistant.message", {
        turnId: "turn_3",
        stepId: "step_3",
        message: assistant("a3", "after answer"),
      }),
      draft("turn.ended", { turnId: "turn_3", reason: "completed" }),
    ])

    await writeStoredSession(dataRoot, sessionId, root, events)

    const resume = await new SessionStore(dataRoot).resolveResume({ id: sessionId }, root)
    const canonical = messagesFromEvents(events)

    expect(resume.messages).toEqual(canonical)
    expect(resume.messages.map((message) => message.id)).toEqual([
      "compact_1_summary",
      "u2",
      "a2",
      "r1",
      "u3",
      "a3",
    ])
    expect(replayProviderMessages(events).map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ])
  })

  test("a resumed next turn is assembled by ContextAssembler and executes tools through ToolRuntime", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscriptSink()
    const initialMessages = messagesFromEvents(
      visibleEvents("resume_flow", root, [
        draft("turn.started", { turnId: "turn_1" }),
        draft("user.message", { turnId: "turn_1", message: { id: "u1", role: "user", content: "prior user" } }),
        draft("assistant.message", {
          turnId: "turn_1",
          stepId: "step_1",
          message: assistant("a1", "prior answer"),
        }),
        draft("turn.ended", { turnId: "turn_1", reason: "completed" }),
      ]),
    )
    const nextCall = call("c_next", "echo", { value: 1 })
    const toolRuns: Array<{ sessionId: string; turnId: string; stepId: string }> = []
    const contextStepSeenBeforeProvider: boolean[] = []

    const provider = new FakeProvider({
      steps: [
        { message: assistant("a2", "need tool", [nextCall]) },
        { message: assistant("a3", "done") },
      ],
      onRequest: (_request, index) => {
        contextStepSeenBeforeProvider[index] = transcript.events.some((event) => event.type === "context.step")
      },
    })
    const session = await AgentSession.create({
      id: "resume_flow",
      cwd: root,
      provider,
      toolRuntime: new FakeToolRuntime({
        tools: {
          echo: {
            handler: (_input, _call, ctx) => {
              toolRuns.push({ sessionId: ctx.sessionId, turnId: ctx.turnId, stepId: ctx.stepId })
              return "tool-ok"
            },
          },
        },
      }),
      transcript,
      initialMessages,
      idSeed: 100,
    })

    await session.submit({ type: "user_message", content: "next prompt" })
    await session.close()

    expect(contextStepSeenBeforeProvider).toEqual([true, true])
    expect(provider.requests).toHaveLength(2)
    expect(historyMessages(provider.requests[0].messages)).toEqual([
      { role: "user", content: "prior user" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "next prompt" },
    ])
    expect(toolRuns).toHaveLength(1)
    expect(toolRuns[0].sessionId).toBe("resume_flow")
    expect(transcript.events.some((event) => event.type === "tool.call" && event.call.id === "c_next")).toBe(true)
    expect(transcript.events.some((event) => event.type === "tool.result" && event.result.toolCallId === "c_next")).toBe(true)
  })

  test("metadata/index write failure is visible but not replay-visible", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    await mkdir(join(dataRoot, "session_index.jsonl"), { recursive: true })

    const result = await runCli(["-p", "hello", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("warning: failed to update session metadata")
    const [sessionId] = await readdir(join(dataRoot, "sessions"))
    const events = await readJsonlTranscript(join(dataRoot, "sessions", sessionId, "transcript.jsonl"))

    expect(events.some((event) => event.type === "error" && event.error.includes("metadata"))).toBe(false)
    expect(replayProviderMessages(events)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
    ])
  })
})

class RecordingTranscriptSink implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

async function writeStoredSession(dataRoot: string, id: string, cwd: string, events: SessionEvent[]): Promise<void> {
  const sessionDir = join(dataRoot, "sessions", id)
  await mkdir(sessionDir, { recursive: true })
  const transcriptPath = join(sessionDir, "transcript.jsonl")
  await writeFile(transcriptPath, events.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8")
  const metadata: SessionMetadata = {
    id,
    cwd,
    model: "fake",
    provider: "fake",
    permissionMode: "workspace-write",
    transcriptPath,
    startedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  }
  await writeFile(join(sessionDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8")
}

function visibleEvents(sessionId: string, cwd: string, drafts: Array<Record<string, unknown>>): SessionEvent[] {
  return [draft("session.started", { cwd }), ...drafts].map((item, seq) => event(seq, sessionId, item))
}

function event(seq: number, sessionId: string, draftEvent: Record<string, unknown>): SessionEvent {
  return {
    seq,
    timestamp: "2026-06-01T00:00:00.000Z",
    sessionId,
    ...draftEvent,
  } as SessionEvent
}

function draft(type: SessionEvent["type"], fields: Record<string, unknown>): Record<string, unknown> {
  return { type, ...fields }
}

function historyMessages(messages: Array<{ role: string; content?: string }>): Array<{ role: string; content: string }> {
  const wanted = new Set(["prior user", "prior answer", "next prompt"])
  return messages
    .filter((message): message is { role: string; content: string } => typeof message.content === "string" && wanted.has(message.content))
    .map((message) => ({ role: message.role, content: message.content }))
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function cleanEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: `/home/cyli/.bun/bin:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    NO_PROXY: "127.0.0.1,localhost",
    LIGHT_CC_OS_SANDBOX: "off",
    ...extra,
  }
  for (const key of [
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_API_KEY",
    "LIGHT_CC_BASE_URL",
    "LIGHT_CC_MODEL",
    "LIGHT_CC_API_KEY_ENV",
    "LIGHT_CC_TRANSCRIPT",
    "LIGHT_CC_MAX_STEPS",
    "LIGHT_CC_MAX_CONTEXT_TOKENS",
    "LIGHT_CC_COMPACT_THRESHOLD",
    "LIGHT_CC_MCP_CONFIG",
    "LIGHT_CC_SKILLS",
  ]) {
    env[key] = undefined
  }
  return env
}
