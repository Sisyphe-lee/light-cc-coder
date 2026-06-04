import { describe, expect, test } from "bun:test"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 6 approval metadata trigger behavior", () => {
  test("approval.requested transcript event carries display metadata for bash", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "run", [
            call("c1", "bash", {
              command: "printf should-not-run",
              description: "verify approval display metadata",
            }),
          ]),
        },
        { message: assistant("a2", "saw denial") },
      ],
    })
    const session = await createSession(root, provider, "workspace-write", transcript)

    const streamedEvents = await submitAndRespondToApprovals(session, "deny")
    await session.close()

    const approval = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "approval.requested" }> =>
        event.type === "approval.requested",
    )
    expect(approval).toMatchObject({
      type: "approval.requested",
      turnId: expect.any(String),
      stepId: expect.any(String),
      approvalId: expect.any(String),
      toolCallId: "c1",
      toolName: "bash",
      subject: "printf should-not-run",
      reason: "Bash requires approval in workspace-write mode",
      cwd: root,
      permissionMode: "workspace-write",
      policyReason: "Bash requires approval in workspace-write mode",
      toolReason: "verify approval display metadata",
    })
    expect(approval?.toolDescription).toContain("Run at most one targeted shell command")
    expect(approval?.inputSummary).toContain("printf should-not-run")
    expect(approval?.inputSummary).toContain("verify approval display metadata")
    expect(approval?.accessSummary).toContain("searches: printf should-not-run")
    expect(approval?.riskSummary).toContain("Shell command")
    expect(streamedEvents.some((event) => event.type === "approval.requested")).toBe(true)
    expect(transcript.events.filter((event) => event.type === "tool.result")).toHaveLength(1)
    expect(transcript.events.some((event) => event.type === "bash.observation")).toBe(false)
  })

  test("display risk summary does not turn allowlisted git inspection into approval", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "inspect", [
            call("c1", "bash", {
              command: "git status --short",
              description: "inspect git state",
            }),
          ]),
        },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createSession(root, provider, "workspace-write", transcript)

    await submitAndRespondToApprovals(session, "deny")
    await session.close()

    const permission = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "permission.decision" }> =>
        event.type === "permission.decision",
    )
    expect(permission).toMatchObject({
      type: "permission.decision",
      toolCallId: "c1",
      toolName: "bash",
      mode: "workspace-write",
      decision: "allow",
      reason: "Git inspection command is allowlisted",
    })
    expect(transcript.events.some((event) => event.type === "approval.requested")).toBe(false)
    expect(transcript.events.some((event) => event.type === "bash.observation")).toBe(true)
  })
})

describe("Phase 6 verification diagnostic triggers", () => {
  test("bash.description is recorded and description-only verification emits bounded replay-invisible diagnostic", async () => {
    const stdoutSentinel = "stdout-only-sentinel-phase6"
    const command = `node -e "console.log(Buffer.from('c3Rkb3V0LW9ubHktc2VudGluZWwtcGhhc2U2','base64').toString())"`
    const { transcript, provider } = await runBashTurn({
      command,
      description: "run verification after edits",
    })

    const observation = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "bash.observation" }> =>
        event.type === "bash.observation",
    )
    const verification = onlyVerification(transcript.events)
    const replayed = replayProviderMessages(transcript.events)
    const replayedTool = replayed.find((message) => message.role === "tool")

    expect(observation).toMatchObject({
      type: "bash.observation",
      command,
      description: "run verification after edits",
    })
    expect(verification).toMatchObject({
      type: "verification.observed",
      command,
      description: "run verification after edits",
      exitCode: 0,
      timedOut: false,
      status: "passed",
    })
    expect(verification.output.stdoutBytes).toBeGreaterThanOrEqual(stdoutSentinel.length)
    expect((verification as unknown as Record<string, unknown>).stdout).toBeUndefined()
    expect((verification as unknown as Record<string, unknown>).stderr).toBeUndefined()
    expect((verification.output as Record<string, unknown>).stdout).toBeUndefined()
    expect((verification.output as Record<string, unknown>).stderr).toBeUndefined()
    expect(JSON.stringify(verification)).not.toContain(stdoutSentinel)
    expect(JSON.stringify(replayed)).not.toContain("verification.observed")
    expect(replayedTool?.role === "tool" ? replayedTool.content : "").toContain(stdoutSentinel)
    expect(provider.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true)
  })

  test("command-looking verification emits without description but ordinary bash does not", async () => {
    const commandTriggered = await runBashTurn({
      command: "typecheck() { return 0; }; typecheck",
    })
    expect(commandTriggered.transcript.events.filter((event) => event.type === "verification.observed")).toHaveLength(1)
    expect(onlyVerification(commandTriggered.transcript.events)).toMatchObject({
      command: "typecheck() { return 0; }; typecheck",
      description: undefined,
      status: "passed",
    })

    const ordinary = await runBashTurn({
      command: "printf plain-output",
      description: "print marker",
    })
    expect(ordinary.transcript.events.some((event) => event.type === "bash.observation")).toBe(true)
    expect(ordinary.transcript.events.filter((event) => event.type === "verification.observed")).toHaveLength(0)
    expect(JSON.stringify(replayProviderMessages(ordinary.transcript.events))).not.toContain("verification.observed")
  })
})

describe("Phase 6 todo discipline trigger behavior", () => {
  test("multiple in_progress replace yields one paired error, no todo.updated, and no state mutation", async () => {
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
              reason: "exercise multiple in-progress validation",
              items: [
                { id: "first", content: "first task", status: "in_progress" },
                { id: "second", content: "second task", status: "in_progress" },
              ],
            }),
          ]),
        },
        { message: assistant("a2", "saw todo error") },
      ],
    })
    const workspace = await WorkspaceFs.create(root)
    const session = await AgentSession.create({
      cwd: workspace.root,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState }),
        workspace,
        permissionMode: "read-only",
      }),
      transcript,
      todoState,
    })

    await session.submit({ type: "user_message", content: "replace todo badly" })
    await session.close()

    const toolResults = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({
      type: "tool.result",
      result: {
        toolCallId: "c1",
        toolName: "todo",
        isError: true,
      },
    })
    expect(toolResults[0].result.content).toContain("todo replace allows at most one in_progress item")
    expect(transcript.events.some((event) => event.type === "todo.updated")).toBe(false)
    expect(todoState.list()).toEqual([{ id: "keep", content: "existing item", status: "pending" }])

    const assistantIndex = transcript.events.findIndex((event) => event.type === "assistant.message")
    const resultIndex = transcript.events.findIndex((event) => event.type === "tool.result")
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(assistantIndex)
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(1)
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("at most one in_progress")
  })
})

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

async function createSession(
  root: string,
  provider: FakeProvider,
  permissionMode: "read-only" | "workspace-write" | "danger-full-access",
  transcript: RecordingTranscript,
): Promise<AgentSession> {
  const workspace = await WorkspaceFs.create(root)
  return AgentSession.create({
    cwd: workspace.root,
    provider,
    toolRuntime: new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace,
      runtime: await LocalRuntime.create({ workspaceRoot: workspace.root }),
      permissionMode,
    }),
    transcript,
    maxSteps: 5,
  })
}

async function runBashTurn(input: {
  command: string
  description?: string
}): Promise<{ transcript: RecordingTranscript; provider: FakeProvider }> {
  const root = await createTempWorkspace()
  const transcript = new RecordingTranscript()
  const provider = new FakeProvider({
    steps: [
      {
        message: assistant("a1", "run bash", [
          call("c1", "bash", {
            command: input.command,
            ...(input.description ? { description: input.description } : {}),
          }),
        ]),
      },
      { message: assistant("a2", "done") },
    ],
  })
  const session = await createSession(root, provider, "danger-full-access", transcript)

  await session.submit({ type: "user_message", content: "run bash" })
  await session.close()

  return { transcript, provider }
}

async function submitAndRespondToApprovals(
  session: AgentSession,
  decision: "allow" | "deny",
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  const consumer = (async () => {
    for await (const event of session.events()) {
      events.push(event)
      if (event.type === "approval.requested") {
        await session.submit({ type: "approval.respond", approvalId: event.approvalId, decision })
      }
      if (event.type === "turn.ended") break
    }
  })()
  await session.submit({ type: "user_message", content: "go" })
  await consumer
  return events
}

function onlyVerification(events: SessionEvent[]): Extract<SessionEvent, { type: "verification.observed" }> {
  const verifications = events.filter(
    (event): event is Extract<SessionEvent, { type: "verification.observed" }> =>
      event.type === "verification.observed",
  )
  expect(verifications).toHaveLength(1)
  return verifications[0]
}
