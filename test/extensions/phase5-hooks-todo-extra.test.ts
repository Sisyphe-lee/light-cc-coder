import { describe, expect, test } from "bun:test"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import type { SessionHooks } from "../../src/extensions/hooks"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime, type RealToolRuntimeOptions } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { replayTodoState } from "../../src/tools/builtins/todo"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace, deferred } from "../helpers"

describe("Phase 5 hook lifecycle hardening", () => {
  test("user_prompt_submit appendContext enters the provider request bounded and diagnosed", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const extra = `visible context\n${"x".repeat(400)}\nsecret-tail-should-not-appear`
    const session = await createSession({
      root,
      provider,
      transcript,
      hooks: {
        maxExtraContextBytes: 180,
        user_prompt_submit: [() => ({ appendContext: extra })],
      },
    })

    await session.submit({ type: "user_message", content: "explain the next step" })
    await session.close()

    const requestText = provider.requests[0]?.messages.map((message) => message.content).join("\n") ?? ""
    expect(requestText).toContain("explain the next step")
    expect(requestText).toContain("Additional context from user_prompt_submit hook")
    expect(requestText).toContain("visible context")
    expect(requestText).toContain("[truncated: capped at 180 bytes]")
    expect(requestText).not.toContain("secret-tail-should-not-appear")
    expect(transcript.events.some((event) => event.type === "hook.ended" && event.status === "completed")).toBe(true)
    const hookEnd = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "hook.ended" }> =>
        event.type === "hook.ended" && event.hook === "user_prompt_submit" && event.status === "completed",
    )
    expect(hookEnd?.message).toContain("appendContext bytes=")
    expect(hookEnd?.message).toContain("truncated=true")
    expect(transcript.events.some((event) => event.type === "context.step")).toBe(true)
    expect(replayProviderMessages(transcript.events).some((message) => message.content.includes("hook.ended"))).toBe(false)
  })

  test("abort reaches a running user_prompt_submit hook signal", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [] })
    const entered = deferred<void>()
    const aborted = deferred<void>()
    let sawAbort = false
    const session = await createSession({
      root,
      provider,
      transcript,
      hooks: {
        user_prompt_submit: [
          (input) => {
            entered.resolve()
            input.signal.addEventListener(
              "abort",
              () => {
                sawAbort = true
                aborted.resolve()
              },
              { once: true },
            )
            return aborted.promise
          },
        ],
      },
    })

    const submit = session.submit({ type: "user_message", content: "abort during hook" })
    await entered.promise
    await session.submit({ type: "abort", reason: "stop hook" })
    await submit
    await session.close()

    expect(sawAbort).toBe(true)
    expect(provider.requests).toHaveLength(0)
    expect(transcript.events.some((event) => event.type === "turn.ended" && event.reason === "aborted")).toBe(true)
  })

  test("user_prompt_submit failures and timeouts are diagnostic-only", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await createSession({
      root,
      provider,
      transcript,
      hooks: {
        timeoutMs: 5,
        maxDiagnosticBytes: 96,
        user_prompt_submit: [
          () => {
            throw new Error(`hook failure ${"x".repeat(200)}`)
          },
          () => new Promise<never>(() => {}),
        ],
      },
    })

    await session.submit({ type: "user_message", content: "plain prompt" })
    await session.close()

    const requestText = provider.requests[0]?.messages.map((message) => message.content).join("\n") ?? ""
    const hookEnds = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "hook.ended" }> => event.type === "hook.ended",
    )
    const failed = hookEnds.find((event) => event.status === "failed")
    expect(provider.requests).toHaveLength(1)
    expect(requestText).toContain("plain prompt")
    expect(requestText).not.toContain("hook failure")
    expect(hookEnds.some((event) => event.status === "timeout")).toBe(true)
    expect(failed?.message).toContain("hook failure")
    expect(Buffer.byteLength(failed?.message ?? "", "utf8")).toBeLessThanOrEqual(96)
    expect(transcript.events.some((event) => event.type === "error")).toBe(false)
    expect(replayProviderMessages(transcript.events).some((message) => message.content.includes("Hook timed out"))).toBe(
      false,
    )
  })

  test("transcript failure during hook diagnostics remains fatal", async () => {
    const root = await createTempWorkspace()
    const transcript = new FailingTranscript("hook.ended")
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "unused") }] })
    const session = await createSession({
      root,
      provider,
      transcript,
      hooks: {
        user_prompt_submit: [() => ({ appendContext: "diagnostic write should fail" })],
      },
    })

    await expect(session.submit({ type: "user_message", content: "trigger hook diagnostic" })).rejects.toThrow(
      "Transcript write failed while writing hook.ended",
    )
    await session.close().catch(() => undefined)
    expect(provider.requests).toHaveLength(0)
  })

  test("pre_tool hooks do not run before permission denial and cannot allow a denied tool", async () => {
    const root = await createTempWorkspace()
    const registry = new ToolRegistry()
    let executed = false
    let preHookCalls = 0
    registry.register(
      dummyTool("mutate", false, async () => {
        executed = true
        return { content: "mutated" }
      }),
    )
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mutate", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createSession({
      root,
      provider,
      transcript,
      registry,
      permissionMode: "read-only",
      hooks: {
        pre_tool: [
          () => {
            preHookCalls += 1
            return { type: "continue" }
          },
        ],
      },
    })

    await session.submit({ type: "user_message", content: "try mutation" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(preHookCalls).toBe(0)
    expect(executed).toBe(false)
    expect(transcript.events.some((event) => event.type === "hook.started" && event.hook === "pre_tool")).toBe(false)
    expect(result).toMatchObject({ toolCallId: "c1", toolName: "mutate", isError: true })
    expect(result.content).toContain("permission_denied")
  })

  test("post_tool hook failure does not alter a successful tool result", async () => {
    const root = await createTempWorkspace()
    const registry = new ToolRegistry()
    registry.register(dummyTool("safe_read", true, async () => ({ content: "tool-ok" })))
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "safe_read", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createSession({
      root,
      provider,
      transcript,
      registry,
      hooks: {
        post_tool: [
          () => {
            throw new Error("post hook exploded")
          },
        ],
      },
    })

    await session.submit({ type: "user_message", content: "run safe tool" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result).toMatchObject({ toolCallId: "c1", toolName: "safe_read", isError: false, content: "tool-ok" })
    expect(
      transcript.events.some(
        (event) => event.type === "hook.ended" && event.hook === "post_tool" && event.status === "failed",
      ),
    ).toBe(true)
    expect(replayProviderMessages(transcript.events).some((message) => message.content.includes("post hook exploded"))).toBe(
      false,
    )
  })

  test("stop hook runs after turn end and remains diagnostic-only", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const seenReasons: string[] = []
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await createSession({
      root,
      provider,
      transcript,
      hooks: {
        stop: [
          (input) => {
            seenReasons.push(input.reason)
            throw new Error("stop hook exploded")
          },
        ],
      },
    })

    await session.submit({ type: "user_message", content: "finish" })
    await session.close()

    const turnEndIndex = transcript.events.findIndex((event) => event.type === "turn.ended")
    const stopStartIndex = transcript.events.findIndex((event) => event.type === "hook.started" && event.hook === "stop")
    const stopEndIndex = transcript.events.findIndex((event) => event.type === "hook.ended" && event.hook === "stop")
    expect(seenReasons).toEqual(["completed"])
    expect(turnEndIndex).toBeGreaterThanOrEqual(0)
    expect(stopStartIndex).toBeGreaterThan(turnEndIndex)
    expect(stopEndIndex).toBeGreaterThan(stopStartIndex)
    expect(transcript.events[stopEndIndex]).toMatchObject({ type: "hook.ended", hook: "stop", status: "failed" })
    expect(transcript.events.some((event) => event.type === "error")).toBe(false)
    expect(replayProviderMessages(transcript.events).some((message) => message.content.includes("stop hook exploded"))).toBe(
      false,
    )
  })
})

describe("Phase 5 todo lifecycle hardening", () => {
  test("todo list and clear work in read-only mode and only mutating actions emit updates", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const todoState = new TodoState()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "replace", [
            call("c1", "todo", {
              action: "replace",
              items: [
                { id: "t1", content: "write hook tests", status: "in_progress" },
                { id: "t2", content: "check compact replay", status: "pending" },
              ],
            }),
          ]),
        },
        { message: assistant("a2", "list", [call("c2", "todo", { action: "list" })]) },
        { message: assistant("a3", "clear", [call("c3", "todo", { action: "clear" })]) },
        { message: assistant("a4", "done") },
      ],
    })
    const session = await createSession({
      root,
      provider,
      transcript,
      todoState,
      permissionMode: "read-only",
      maxSteps: 5,
    })

    await session.submit({ type: "user_message", content: "manage todos" })
    await session.close()

    const results = toolResults(transcript.events)
    const updates = transcript.events.filter((event) => event.type === "todo.updated")
    expect(results).toHaveLength(3)
    expect(results.every((result) => result.isError === false)).toBe(true)
    expect(results[1].content).toContain("in_progress\tt1\twrite hook tests")
    expect(results[1].content).toContain("pending\tt2\tcheck compact replay")
    expect(results[2].content).toBe("Todo list cleared.")
    expect(updates).toHaveLength(2)
    expect(replayTodoState(transcript.events).list()).toEqual([])
    expect(provider.requests[1]?.messages.map((message) => message.content).join("\n")).toContain("Session todo context")
    expect(provider.requests[3]?.messages.map((message) => message.content).join("\n")).not.toContain(
      "Session todo context",
    )
  })

  test("todo invalid input returns one paired error result and leaves state unchanged", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const todoState = new TodoState()
    todoState.replace([{ id: "keep", content: "existing item", status: "pending" }])
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "bad todo", [
            call("c1", "todo", {
              action: "replace",
              items: [
                { id: "dup", content: "first", status: "pending" },
                { id: "dup", content: "second", status: "pending" },
              ],
            }),
          ]),
        },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createSession({ root, provider, transcript, todoState, permissionMode: "read-only" })

    await session.submit({ type: "user_message", content: "bad todo input" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result).toMatchObject({ toolCallId: "c1", toolName: "todo", isError: true })
    expect(result.content).toContain("invalid_input")
    expect(result.content).toContain("duplicate todo id: dup")
    expect(transcript.events.some((event) => event.type === "todo.updated")).toBe(false)
    expect(todoState.list()).toEqual([{ id: "keep", content: "existing item", status: "pending" }])
    expect(replayProviderMessages(transcript.events).filter((message) => message.role === "tool")).toHaveLength(1)
  })

  test("AgentSession uses the builtin todo state by default for todo_slot", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "todo", [
            call("c1", "todo", {
              action: "replace",
              items: [{ id: "t1", content: "default wiring", status: "pending" }],
            }),
          ]),
        },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry(),
        workspace: await WorkspaceFs.create(root),
        permissionMode: "read-only",
      }),
      transcript,
    })

    await session.submit({ type: "user_message", content: "use default todo" })
    await session.close()

    expect(provider.requests[1]?.messages.map((message) => message.content).join("\n")).toContain("Session todo context")
    expect(provider.requests[1]?.messages.map((message) => message.content).join("\n")).toContain("default wiring")
  })

  test("compact after a todo tool turn keeps replay pairing-safe", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const todoState = new TodoState()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "todo", [
            call("c1", "todo", {
              action: "replace",
              items: [{ id: "t1", content: "preserve pairing", status: "in_progress" }],
            }),
          ]),
        },
        { message: assistant("a2", "done") },
        { message: assistant("compact_a", "summary mentions completed todo setup") },
      ],
    })
    const session = await createSession({
      root,
      provider,
      transcript,
      todoState,
      compactTailMessages: 2,
    })

    await session.submit({ type: "user_message", content: "track todo then compact" })
    await session.submit({ type: "compact.request", id: "compact_test", instruction: "keep todo state" })
    await session.close()

    const compactEnded = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "compact.ended"; status: "succeeded" }> =>
        event.type === "compact.ended" && event.status === "succeeded",
    )
    const replayed = replayProviderMessages(transcript.events)
    const assistantIndex = replayed.findIndex(
      (message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "c1",
    )
    expect(compactEnded).toBeDefined()
    expect(compactEnded?.tailStartMessageId).toBe("a1")
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(replayed[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "c1" })
    expect(replayTodoState(transcript.events).list()).toEqual([
      { id: "t1", content: "preserve pairing", status: "in_progress" },
    ])
  })
})

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

class FailingTranscript implements TranscriptSink {
  constructor(private readonly failOn: SessionEvent["type"]) {}

  async write(event: SessionEvent): Promise<void> {
    if (event.type === this.failOn) throw new Error(`fail ${this.failOn}`)
  }
}

async function createSession(input: {
  root: string
  provider: FakeProvider
  transcript: TranscriptSink
  registry?: ToolRegistry
  todoState?: TodoState
  permissionMode?: RealToolRuntimeOptions["permissionMode"]
  hooks?: SessionHooks
  maxSteps?: number
  compactTailMessages?: number
}): Promise<AgentSession> {
  const todoState = input.todoState ?? new TodoState()
  const registry = input.registry ?? createBuiltinToolRegistry({ todoState })
  return AgentSession.create({
    cwd: input.root,
    provider: input.provider,
    toolRuntime: new RealToolRuntime({
      registry,
      workspace: await WorkspaceFs.create(input.root),
      permissionMode: input.permissionMode ?? "workspace-write",
    }),
    transcript: input.transcript,
    hooks: input.hooks,
    todoState,
    maxSteps: input.maxSteps,
    compactTailMessages: input.compactTailMessages,
  })
}

function dummyTool(name: string, readOnly: boolean, execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", additionalProperties: true },
    readOnly,
    parse(input: unknown): unknown {
      return input
    },
    execute,
  }
}

function toolResults(events: SessionEvent[]) {
  return events
    .filter((event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result")
    .map((event) => event.result)
}

function onlyToolResult(events: SessionEvent[]) {
  const results = toolResults(events)
  expect(results).toHaveLength(1)
  return results[0]
}
