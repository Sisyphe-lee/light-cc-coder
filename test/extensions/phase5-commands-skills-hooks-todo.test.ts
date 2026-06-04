import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import type { ToolCall } from "../../src/core/messages"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { replayTodoState } from "../../src/tools/builtins/todo"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 5 slash commands", () => {
  test("local commands produce output without appending user messages", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const session = await AgentSession.create({
      cwd: root,
      provider: new FakeProvider({ steps: [] }),
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState: new TodoState() }),
        workspace: await WorkspaceFs.create(root),
      }),
      transcript,
    })

    await session.submit({ type: "user_message", content: "/help" })
    await session.submit({ type: "user_message", content: "/clear" })
    await session.close()

    expect(transcript.events.filter((event) => event.type === "user.message")).toHaveLength(0)
    expect(outputFor(transcript.events, "help")).toContain("/compact")
    const clear = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "command.output" }> =>
        event.type === "command.output" && event.command === "clear",
    )
    expect(clear?.hostAction).toBe("clear")
  })

  test("/compact maps to existing compact events without creating a slash user message", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "done") }, { message: assistant("compact_a", "summary") }],
    })
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState: new TodoState() }),
        workspace: await WorkspaceFs.create(root),
      }),
      transcript,
      compactTailMessages: 1,
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.submit({ type: "user_message", content: "/compact keep decisions" })
    await session.close()

    expect(transcript.events.some((event) => event.type === "compact.started")).toBe(true)
    expect(transcript.events.some((event) => event.type === "compact.ended" && event.status === "succeeded")).toBe(true)
    expect(
      transcript.events.some((event) => event.type === "user.message" && event.message.content.startsWith("/compact")),
    ).toBe(false)
  })
})

describe("Phase 5 skills", () => {
  test("explicitly enabled SKILL.md is snapshotted into skills_slot", async () => {
    const root = await createTempWorkspace()
    const skillDir = join(root, "skills", "reviewer")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Reviewer\nUse focused review notes.\n", "utf8")
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState: new TodoState() }),
        workspace: await WorkspaceFs.create(root),
      }),
      skillDirs: [skillDir],
      enabledSkills: [basename(skillDir)],
    })

    await writeFile(join(skillDir, "SKILL.md"), "# Reviewer\nChanged after activation.\n", "utf8")
    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    const joined = provider.requests[0]?.messages.map((message) => message.content).join("\n") ?? ""
    expect(joined).toContain("Active skill instructions")
    expect(joined).toContain("Use focused review notes.")
    expect(joined).not.toContain("Changed after activation.")
  })

  test("skill directories are not activated by keyword without explicit enablement", async () => {
    const root = await createTempWorkspace()
    const skillDir = join(root, "skills", "reviewer")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Reviewer\nUse focused review notes.\n", "utf8")
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState: new TodoState() }),
        workspace: await WorkspaceFs.create(root),
      }),
      skillDirs: [skillDir],
    })

    await session.submit({ type: "user_message", content: "Use reviewer skill" })
    await session.close()

    const joined = provider.requests[0]?.messages.map((message) => message.content).join("\n") ?? ""
    expect(joined).not.toContain("Active skill instructions")
  })
})

describe("Phase 5 hooks", () => {
  test("user_prompt_submit block appends no user message", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const session = await AgentSession.create({
      cwd: root,
      provider: new FakeProvider({ steps: [] }),
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState: new TodoState() }),
        workspace: await WorkspaceFs.create(root),
      }),
      transcript,
      hooks: {
        user_prompt_submit: [() => ({ type: "block", reason: "blocked prompt" })],
      },
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    expect(transcript.events.filter((event) => event.type === "user.message")).toHaveLength(0)
    expect(transcript.events.some((event) => event.type === "hook.ended" && event.status === "blocked")).toBe(true)
  })

  test("pre-tool block returns a paired error result and does not execute the tool", async () => {
    const root = await createTempWorkspace()
    const registry = new ToolRegistry()
    let executed = false
    registry.register(dummyTool("danger", false, async () => {
      executed = true
      return { content: "executed" }
    }))
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "danger", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({ registry, workspace: await WorkspaceFs.create(root) }),
      transcript,
      hooks: {
        pre_tool: [() => ({ type: "block", reason: "policy says no" })],
      },
    })

    await session.submit({ type: "user_message", content: "run" })
    await session.close()

    const results = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(executed).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0].result).toMatchObject({ toolCallId: "c1", toolName: "danger", isError: true })
    expect(results[0].result.content).toContain("hook_blocked")
    expect(replayProviderMessages(transcript.events).filter((message) => message.role === "tool")).toHaveLength(1)
  })
})

describe("Phase 5 todo tool", () => {
  test("todo is allowed in read-only mode, updates todo_slot, and replays state from diagnostics", async () => {
    const root = await createTempWorkspace()
    const todoState = new TodoState()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "todo", [
            call("c1", "todo", {
              action: "replace",
              reason: "track two independent follow-up tasks",
              items: [
                { id: "t1", content: "write tests", status: "in_progress" },
                { id: "t2", content: "verify replay", status: "pending" },
              ],
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
        registry: createBuiltinToolRegistry({ todoState }),
        workspace: await WorkspaceFs.create(root),
        permissionMode: "read-only",
      }),
      transcript,
      todoState,
    })

    await session.submit({ type: "user_message", content: "track todo" })
    await session.close()

    const result = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(result?.result.isError).toBe(false)
    expect(provider.requests[1]?.messages.map((message) => message.content).join("\n")).toContain("Session todo context")
    expect(provider.requests[1]?.messages.map((message) => message.content).join("\n")).toContain("write tests")
    expect(replayTodoState(transcript.events).list()).toEqual([
      { id: "t1", content: "write tests", status: "in_progress" },
      { id: "t2", content: "verify replay", status: "pending" },
    ])
  })
})

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

function outputFor(events: SessionEvent[], command: string): string {
  return (
    events.find(
      (event): event is Extract<SessionEvent, { type: "command.output" }> =>
        event.type === "command.output" && event.command === command,
    )?.content ?? ""
  )
}

function dummyTool(
  name: string,
  readOnly: boolean,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    readOnly,
    inputSchema: { type: "object", additionalProperties: true },
    parse(input) {
      return input
    },
    execute,
  }
}
