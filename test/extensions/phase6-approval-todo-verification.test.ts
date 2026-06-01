import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "../../src/core/events"
import { AgentSession } from "../../src/core/AgentSession"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import type { ApprovalRequest } from "../../src/permissions/types"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 6 approval display metadata", () => {
  test("approval requests include display metadata for bash", async () => {
    const root = await createTempWorkspace()
    const runtime = new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace: await WorkspaceFs.create(root),
      permissionMode: "workspace-write",
    })
    let request: ApprovalRequest | undefined

    const results = await runtime.runBatch(
      [call("c1", "bash", { command: "echo should-not-run", description: "verification smoke" })],
      ctx({
        approvals: {
          async request(input) {
            request = input
            return "deny"
          },
        },
      }),
    )

    expect(results[0]).toMatchObject({ isError: true })
    expect(request).toMatchObject({
      toolName: "bash",
      cwd: root,
      permissionMode: "workspace-write",
      subject: "echo should-not-run",
      policyReason: "Bash requires approval in workspace-write mode",
      toolReason: "verification smoke",
    })
    expect(request?.toolDescription).toContain("Run a shell command")
    expect(request?.inputSummary).toContain("echo should-not-run")
    expect(request?.accessSummary).toContain("searches:")
    expect(request?.riskSummary).toContain("Shell command")
  })

  test("approval requests include display metadata for opaque MCP tools", async () => {
    const root = await createTempWorkspace()
    const registry = new ToolRegistry()
    registry.register(dummyTool("mcp__server__danger", false))
    const runtime = new RealToolRuntime({
      registry,
      workspace: await WorkspaceFs.create(root),
      permissionMode: "workspace-write",
    })
    let request: ApprovalRequest | undefined

    const results = await runtime.runBatch(
      [call("c1", "mcp__server__danger", { reason: "remote side effect" })],
      ctx({
        approvals: {
          async request(input) {
            request = input
            return "deny"
          },
        },
      }),
    )

    expect(results[0]).toMatchObject({ isError: true })
    expect(request).toMatchObject({
      toolName: "mcp__server__danger",
      permissionMode: "workspace-write",
      policyReason: "Opaque MCP tool requires approval in workspace-write mode",
      toolReason: "remote side effect",
    })
    expect(request?.riskSummary).toContain("Opaque MCP tool")
  })
})

describe("Phase 6 todo discipline", () => {
  test("todo replace with multiple in_progress items returns one paired error and leaves state unchanged", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const todoState = new TodoState()
    todoState.replace([{ id: "keep", content: "existing", status: "pending" }])
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "bad todo", [
            call("c1", "todo", {
              action: "replace",
              items: [
                { id: "a", content: "first", status: "in_progress" },
                { id: "b", content: "second", status: "in_progress" },
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

    await session.submit({ type: "user_message", content: "bad todo" })
    await session.close()

    const results = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(results).toHaveLength(1)
    expect(results[0].result).toMatchObject({ toolCallId: "c1", toolName: "todo", isError: true })
    expect(results[0].result.content).toContain("at most one in_progress")
    expect(transcript.events.some((event) => event.type === "todo.updated")).toBe(false)
    expect(todoState.list()).toEqual([{ id: "keep", content: "existing", status: "pending" }])
  })
})

describe("Phase 6 verification ergonomics", () => {
  test("bash description is diagnosed and likely verification emits replay-invisible observation after tool result", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "verify", [
            call("c1", "bash", { command: "echo verification-ok", description: "verification smoke" }),
          ]),
        },
        { message: assistant("a2", "done") },
      ],
    })
    const workspace = await WorkspaceFs.create(root)
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry(),
        workspace,
        runtime: await LocalRuntime.create({ workspaceRoot: workspace.root }),
        permissionMode: "danger-full-access",
      }),
      transcript,
    })

    await session.submit({ type: "user_message", content: "run verification" })
    await session.close()

    const bashObservation = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "bash.observation" }> => event.type === "bash.observation",
    )
    const verification = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "verification.observed" }> =>
        event.type === "verification.observed",
    )
    const toolResultIndex = transcript.events.findIndex((event) => event.type === "tool.result")
    const verificationIndex = transcript.events.findIndex((event) => event.type === "verification.observed")

    expect(bashObservation?.description).toBe("verification smoke")
    expect(verification).toMatchObject({
      command: "echo verification-ok",
      description: "verification smoke",
      exitCode: 0,
      timedOut: false,
      status: "passed",
    })
    expect(verification?.output.stdoutBytes).toBeGreaterThan(0)
    expect(toolResultIndex).toBeGreaterThanOrEqual(0)
    expect(verificationIndex).toBeGreaterThan(toolResultIndex)
    expect(provider.requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("verification-ok"))).toBe(
      true,
    )
    expect(replayProviderMessages(transcript.events).some((message) => message.content.includes("verification.observed"))).toBe(
      false,
    )
  })

  test("verification diagnostic write failure is fatal only after the full tool result batch is paired", async () => {
    const root = await createTempWorkspace()
    const transcript = new FailingTranscript("verification.observed")
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "verify twice", [
            call("c1", "bash", { command: "echo first", description: "verification first" }),
            call("c2", "bash", { command: "echo second" }),
          ]),
        },
      ],
    })
    const workspace = await WorkspaceFs.create(root)
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry(),
        workspace,
        runtime: await LocalRuntime.create({ workspaceRoot: workspace.root }),
        permissionMode: "danger-full-access",
      }),
      transcript,
    })

    await expect(session.submit({ type: "user_message", content: "run verification" })).rejects.toThrow(
      "Transcript write failed while writing verification.observed",
    )
    await session.close().catch(() => undefined)

    const results = transcript.events.filter((event) => event.type === "tool.result")
    expect(results).toHaveLength(2)
    expect(() => replayProviderMessages(transcript.events)).not.toThrow()
  })

  test("bash observation write failure is fatal only after the full tool result batch is paired", async () => {
    const root = await createTempWorkspace()
    const transcript = new FailingTranscript("bash.observation")
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "run two commands", [
            call("c1", "bash", { command: "echo first" }),
            call("c2", "bash", { command: "echo second" }),
          ]),
        },
      ],
    })
    const workspace = await WorkspaceFs.create(root)
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry(),
        workspace,
        runtime: await LocalRuntime.create({ workspaceRoot: workspace.root }),
        permissionMode: "danger-full-access",
      }),
      transcript,
    })

    await expect(session.submit({ type: "user_message", content: "run commands" })).rejects.toThrow(
      "Transcript write failed while writing bash.observation",
    )
    await session.close().catch(() => undefined)

    const results = transcript.events.filter((event) => event.type === "tool.result")
    expect(results.map((event) => (event.type === "tool.result" ? event.result.toolCallId : ""))).toEqual(["c1", "c2"])
    expect(() => replayProviderMessages(transcript.events)).not.toThrow()
  })
})

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

class FailingTranscript extends RecordingTranscript {
  constructor(private readonly failOn: string) {
    super()
  }

  override async write(event: SessionEvent): Promise<void> {
    if (event.type === this.failOn) throw new Error(`fail ${this.failOn}`)
    await super.write(event)
  }
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepId: "step1",
    signal: new AbortController().signal,
    ...extra,
  }
}

function dummyTool(name: string, readOnly: boolean): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    readOnly,
    inputSchema: { type: "object", additionalProperties: true },
    parse(input) {
      return input
    },
    async execute() {
      return { content: "executed" }
    },
  }
}
