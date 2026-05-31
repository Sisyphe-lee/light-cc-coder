import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { readJsonlTranscript, replayProviderMessages } from "../../src/engine/transcript"
import type { PermissionMode } from "../../src/permissions/types"
import { FakeProvider, type FakeProviderStep } from "../../src/providers/FakeProvider"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 3 integration", () => {
  test("approval request/allow executes bash and records transcript replay safely", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const session = await createSession(
      root,
      [
        { message: assistant("a1", "run", [call("c1", "bash", { command: "echo approved" })]) },
        { message: assistant("a2", "done") },
      ],
      "workspace-write",
      transcript,
    )

    const events = await runWithApproval(session, "allow")
    await session.close()

    const approval = events.find((event) => event.type === "approval.requested")
    expect(approval).toMatchObject({
      type: "approval.requested",
      toolCallId: "c1",
      toolName: "bash",
      subject: "echo approved",
    })
    const toolResult = session.getMessages().find((message) => message.role === "tool")
    expect(toolResult).toMatchObject({ role: "tool", isError: false })
    expect(toolResult?.role === "tool" ? toolResult.content : "").toContain("approved")

    const transcriptEvents = await readJsonlTranscript(transcript)
    expect(transcriptEvents.some((event) => event.type === "approval.requested")).toBe(true)
    expect(transcriptEvents.some((event) => event.type === "approval.responded")).toBe(true)
    expect(transcriptEvents.some((event) => event.type === "permission.decision")).toBe(true)
    expect(transcriptEvents.some((event) => event.type === "bash.observation")).toBe(true)
    expect(replayProviderMessages(transcriptEvents).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
  })

  test("approval and diagnostic transcript events are ignored by replay", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "run", [call("c1", "bash", { command: "echo replay-safe" })]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createSessionWithProvider(root, provider, "workspace-write", transcript)

    await runWithApproval(session, "allow")
    await session.close()

    const transcriptEvents = await readJsonlTranscript(transcript)
    expect(transcriptEvents.some((event) => event.type === "approval.requested")).toBe(true)
    expect(transcriptEvents.some((event) => event.type === "approval.responded")).toBe(true)
    expect(transcriptEvents.some((event) => event.type === "permission.decision")).toBe(true)
    expect(transcriptEvents.some((event) => event.type === "bash.observation")).toBe(true)

    const replayed = replayProviderMessages(transcriptEvents)
    expect(replayed.slice(0, -1)).toEqual(provider.requests[1]?.messages.slice(1))
    expect(JSON.stringify(replayed)).not.toContain("approval.requested")
    expect(JSON.stringify(replayed)).not.toContain("permission.decision")
    expect(JSON.stringify(replayed)).not.toContain("bash.observation")
  })

  test("approval deny does not execute bash and still pairs tool result", async () => {
    const root = await createTempWorkspace()
    const session = await createSession(root, [
      { message: assistant("a1", "run", [call("c1", "bash", { command: "touch denied.txt" })]) },
      { message: assistant("a2", "done") },
    ])

    await runWithApproval(session, "deny")
    await session.close()

    const toolResult = session.getMessages().find((message) => message.role === "tool")
    expect(toolResult).toMatchObject({ role: "tool", toolCallId: "c1", isError: true })
    expect(toolResult?.role === "tool" ? toolResult.content : "").toContain("User denied approval")
    await expect(readFile(join(root, "denied.txt"), "utf8")).rejects.toThrow()
  })

  test("denied approval records exactly one tool result and no bash observation", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "run", [call("c1", "bash", { command: "touch denied-once.txt" })]) },
        { message: assistant("a2", "saw denial") },
      ],
    })
    const session = await createSessionWithProvider(root, provider, "workspace-write", transcript)

    await runWithApproval(session, "deny")
    await session.close()

    const transcriptEvents = await readJsonlTranscript(transcript)
    const toolResults = transcriptEvents.filter((event) => event.type === "tool.result")
    expect(toolResults).toHaveLength(1)
    expect(transcriptEvents.filter((event) => event.type === "bash.observation")).toHaveLength(0)
    expect(toolResults[0]).toMatchObject({
      type: "tool.result",
      result: { toolCallId: "c1", toolName: "bash", isError: true },
    })
    expect(toolResults[0]?.type === "tool.result" ? toolResults[0].result.content : "").toContain(
      "User denied approval",
    )
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(1)
    await expect(readFile(join(root, "denied-once.txt"), "utf8")).rejects.toThrow()
  })

  test("timeout bash result preserves pairing and reaches the next provider request", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "run", [call("c1", "bash", { command: "sleep 1", timeoutMs: 50 })]) },
        { message: assistant("a2", "saw timeout") },
      ],
    })
    const session = await createSessionWithProvider(root, provider, "danger-full-access", transcript)

    await session.submit({ type: "user_message", content: "run timeout" })
    await session.close()

    const transcriptEvents = await readJsonlTranscript(transcript)
    const toolResults = transcriptEvents.filter((event) => event.type === "tool.result")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({
      type: "tool.result",
      result: { toolCallId: "c1", toolName: "bash", isError: true },
    })
    const resultContent = toolResults[0]?.type === "tool.result" ? toolResults[0].result.content : ""
    expect(resultContent).toContain("Timed out: true")
    expect(resultContent).toContain("Exit code: null")
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"])
    const replayedTool = replayProviderMessages(transcriptEvents).find((message) => message.role === "tool")
    expect(replayedTool?.role === "tool" ? replayedTool.content : "").toContain("Timed out: true")
  })

  test("replay preserves truncated bash output markers", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const provider = new FakeProvider({
      steps: [
        {
          message: assistant("a1", "run", [
            call("c1", "bash", { command: "yes light-cc-coder-output | head -c 70000" }),
          ]),
        },
        { message: assistant("a2", "saw output") },
      ],
    })
    const session = await createSessionWithProvider(root, provider, "danger-full-access", transcript)

    await session.submit({ type: "user_message", content: "run long output" })
    await session.close()

    const transcriptEvents = await readJsonlTranscript(transcript)
    const observation = transcriptEvents.find((event) => event.type === "bash.observation")
    expect(observation).toMatchObject({ type: "bash.observation", stdoutTruncated: true })
    const toolResult = transcriptEvents.find((event) => event.type === "tool.result")
    const transcriptContent = toolResult?.type === "tool.result" ? toolResult.result.content : ""
    expect(transcriptContent).toContain("[truncated: kept head and tail of stdout, original bytes=")

    const replayedTool = replayProviderMessages(transcriptEvents).find((message) => message.role === "tool")
    const replayedContent = replayedTool?.role === "tool" ? replayedTool.content : ""
    expect(replayedContent).toContain("[truncated: kept head and tail of stdout, original bytes=")
    expect(replayedContent).toBe(transcriptContent)
  })

  test("abort cancels pending approval and preserves pairing", async () => {
    const root = await createTempWorkspace()
    const session = await createSession(root, [
      { message: assistant("a1", "run", [call("c1", "bash", { command: "sleep 5" })]) },
    ])
    const events: SessionEvent[] = []
    const consumer = (async () => {
      for await (const event of session.events()) {
        events.push(event)
        if (event.type === "approval.requested") session.abort("stop")
        if (event.type === "turn.ended") break
      }
    })()

    await session.submit({ type: "user_message", content: "run" })
    await consumer
    await session.close()

    const toolResult = session.getMessages().find((message) => message.role === "tool")
    expect(toolResult).toMatchObject({ role: "tool", toolCallId: "c1", isError: true })
    expect(toolResult?.role === "tool" ? toolResult.content : "").toContain("aborted")
  })

  test("fake provider edits a file, then runs a targeted verification command", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "value.txt"), "old\n", "utf8")
    const session = await createSession(root, [
      {
        message: assistant("a1", "edit", [
          call("c1", "edit", { path: "value.txt", oldText: "old", newText: "new" }),
        ]),
      },
      {
        message: assistant("a2", "verify", [
          call("c2", "bash", { command: 'test "$(cat value.txt)" = "new"' }),
        ]),
      },
      { message: assistant("a3", "verified") },
    ])

    await runWithApproval(session, "allow")
    await session.close()

    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("new\n")
    const bashResult = session.getMessages().find(
      (message) => message.role === "tool" && message.toolName === "bash",
    )
    expect(bashResult).toMatchObject({ role: "tool", toolCallId: "c2", isError: false })
    expect(bashResult?.role === "tool" ? bashResult.content : "").toContain("Exit code: 0")
  })

  test("dangerous and read-only bash denials feed back to the next model step", async () => {
    const root = await createTempWorkspace()
    const dangerous = await createSession(
      root,
      [
        { message: assistant("a1", "danger", [call("c1", "bash", { command: "git push origin main" })]) },
        { message: assistant("a2", "saw denial") },
      ],
      "danger-full-access",
    )
    await dangerous.submit({ type: "user_message", content: "run danger" })
    await dangerous.close()

    const readOnly = await createSession(
      root,
      [
        { message: assistant("a3", "bash", [call("c2", "bash", { command: "echo denied" })]) },
        { message: assistant("a4", "saw denial") },
      ],
      "read-only",
    )
    await readOnly.submit({ type: "user_message", content: "run bash" })
    await readOnly.close()

    expect(dangerous.getMessages().some((message) => message.role === "tool" && message.content.includes("Mutating git command"))).toBe(true)
    expect(readOnly.getMessages().some((message) => message.role === "tool" && message.content.includes("read-only mode"))).toBe(true)
  })

  test("read-only bash denial is included in the next provider request", async () => {
    const root = await createTempWorkspace()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "try bash", [call("c1", "bash", { command: "echo denied" })]) },
        { message: assistant("a2", "saw read-only denial") },
      ],
    })
    const session = await createSessionWithProvider(root, provider, "read-only")

    await session.submit({ type: "user_message", content: "run bash" })
    await session.close()

    expect(provider.requests).toHaveLength(2)
    const nextMessages = provider.requests[1]?.messages ?? []
    expect(nextMessages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"])
    const toolMessage = nextMessages.find((message) => message.role === "tool")
    expect(toolMessage?.role === "tool" ? toolMessage.tool_call_id : "").toBe("c1")
    expect(toolMessage?.role === "tool" ? toolMessage.content : "").toContain("Bash is denied in read-only mode")
  })
})

async function createSession(
  root: string,
  steps: FakeProviderStep[],
  permissionMode: PermissionMode = "workspace-write",
  transcript?: string,
): Promise<AgentSession> {
  return createSessionWithProvider(root, new FakeProvider({ steps }), permissionMode, transcript)
}

async function createSessionWithProvider(
  root: string,
  provider: FakeProvider,
  permissionMode: PermissionMode = "workspace-write",
  transcript?: string,
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

async function runWithApproval(session: AgentSession, decision: "allow" | "deny"): Promise<SessionEvent[]> {
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
