import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import type { PermissionMode } from "../../src/permissions/types"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, createTempWorkspace } from "../helpers"
import type { TranscriptSink } from "../../src/engine/transcript"

describe("Phase 5 slash commands extra", () => {
  test("unknown slash command is local output and does not append a user.message", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [] })
    const session = await createTestSession({ root, provider, transcript })

    await session.submit({ type: "user_message", content: "/does-not-exist please" })
    await session.close()

    expect(provider.requests).toHaveLength(0)
    expect(eventsOf(transcript.events, "user.message")).toHaveLength(0)
    expect(session.getMessages()).toHaveLength(0)
    expect(eventsOf(transcript.events, "command.invoked")[0]).toMatchObject({
      command: "does-not-exist",
      args: "please",
    })
    expect(outputFor(transcript.events, "does-not-exist")).toBe("Unknown slash command: /does-not-exist")
  })

  test("/tools lists builtin, todo, and MCP-like registered tools without calling the model", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [] })
    const todoState = new TodoState()
    const registry = createBuiltinToolRegistry({ todoState })
    registry.register(dummyTool("mcp__local_server__echo", true))
    const session = await createTestSession({ root, provider, transcript, registry, todoState })

    await session.submit({ type: "user_message", content: "/tools" })
    await session.close()

    const output = outputFor(transcript.events, "tools")
    expect(provider.requests).toHaveLength(0)
    expect(eventsOf(transcript.events, "user.message")).toHaveLength(0)
    expect(output).toMatch(/read +read-only/)
    expect(output).toMatch(/edit +write-capable/)
    expect(output).toMatch(/bash +write-capable/)
    expect(output).toMatch(/todo +read-only/)
    expect(output).toMatch(/mcp__local_server__echo +read-only/)
  })

  test("/permissions reflects the active permission mode without calling the model", async () => {
    const modes: PermissionMode[] = ["read-only", "workspace-write", "danger-full-access"]

    for (const mode of modes) {
      const root = await createTempWorkspace()
      const transcript = new RecordingTranscript()
      const provider = new FakeProvider({ steps: [] })
      const session = await createTestSession({ root, provider, transcript, permissionMode: mode })

      await session.submit({ type: "user_message", content: "/permissions" })
      await session.close()

      expect(provider.requests).toHaveLength(0)
      expect(eventsOf(transcript.events, "user.message")).toHaveLength(0)
      expect(outputFor(transcript.events, "permissions")).toContain(`Permission mode: ${mode}`)
    }
  })

  test("/memory shows todo summary as local output and does not trigger a model turn", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [] })
    const todoState = new TodoState()
    todoState.replace([
      { id: "t1", content: "harden slash command tests", status: "in_progress" },
      { id: "t2", content: "capture skills regression", status: "completed" },
    ])
    const session = await createTestSession({ root, provider, transcript, todoState })

    await session.submit({ type: "user_message", content: "/memory" })
    await session.close()

    const output = outputFor(transcript.events, "memory")
    expect(provider.requests).toHaveLength(0)
    expect(eventsOf(transcript.events, "user.message")).toHaveLength(0)
    expect(output).toContain("Implicit memory is not implemented.")
    expect(output).toContain("# Session Todo")
    expect(output).toContain("- [>] t1: harden slash command tests")
    expect(output).toContain("- [x] t2: capture skills regression")
  })
})

describe("Phase 5 skills extra", () => {
  test("skills are injected only when explicitly enabled, in enabled order, with stable snapshots", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const alphaDir = await writeSkill(
      root,
      "alpha",
      skillMarkdown("Alpha", "Alpha description.", "Alpha original instruction."),
    )
    const betaDir = await writeSkill(root, "beta", skillMarkdown("Beta", "Beta description.", "Beta original instruction."))
    const dormantDir = await writeSkill(
      root,
      "dormant",
      skillMarkdown("Dormant", "Dormant description.", "Dormant instruction must not load."),
    )
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "first") }, { message: assistant("a2", "second") }],
    })
    const session = await createTestSession({
      root,
      provider,
      transcript,
      skillDirs: [alphaDir, betaDir, dormantDir],
      enabledSkills: ["beta", "Alpha"],
    })
    const activatedBeforeTurns = eventsOf(transcript.events, "skill.activated")
    const sessionSkillsSource = sourceFor(eventsOf(transcript.events, "context.session")[0].snapshot, "skills_slot")

    await writeFile(join(alphaDir, "SKILL.md"), skillMarkdown("Alpha", "Changed.", "Changed alpha instruction."), "utf8")
    await writeFile(join(betaDir, "SKILL.md"), skillMarkdown("Beta", "Changed.", "Changed beta instruction."), "utf8")

    await session.submit({ type: "user_message", content: "first turn" })
    await session.submit({ type: "user_message", content: "second turn" })
    await session.close()

    expect(activatedBeforeTurns.map((event) => event.name)).toEqual(["Beta", "Alpha"])
    expect(activatedBeforeTurns.map((event) => event.hash)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ])
    expect(provider.requests).toHaveLength(2)

    for (const request of provider.requests) {
      const text = request.messages.map((message) => message.content).join("\n")
      expect(text).toContain("Active skill instructions")
      expect(text.indexOf("## Beta")).toBeGreaterThanOrEqual(0)
      expect(text.indexOf("## Beta")).toBeLessThan(text.indexOf("## Alpha"))
      expect(text).toContain("Beta original instruction.")
      expect(text).toContain("Alpha original instruction.")
      expect(text).not.toContain("Dormant instruction must not load.")
      expect(text).not.toContain("Changed alpha instruction.")
      expect(text).not.toContain("Changed beta instruction.")
    }

    const stepSnapshots = eventsOf(transcript.events, "context.step").map((event) => event.snapshot)
    const stepSkillsSources = stepSnapshots.map((snapshot) => sourceFor(snapshot, "skills_slot"))
    expect(stepSkillsSources.map((source) => source.status)).toEqual(["included", "included"])
    expect(stepSkillsSources.map((source) => source.hash)).toEqual([sessionSkillsSource.hash, sessionSkillsSource.hash])
    expect(new Set(stepSnapshots.map((snapshot) => snapshot.stablePrefixHash)).size).toBe(1)
  })

  test("oversized explicit skill is truncated and reports truncation diagnostics", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const hugeTail = "UNREACHABLE_TAIL_SHOULD_BE_TRUNCATED"
    const hugeContent = `# Huge\n${"oversized skill line\n".repeat(3000)}${hugeTail}\n`
    const hugeDir = await writeSkill(root, "huge", hugeContent)
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await createTestSession({
      root,
      provider,
      transcript,
      skillDirs: [hugeDir],
      enabledSkills: ["Huge"],
    })

    await session.submit({ type: "user_message", content: "use huge skill" })
    await session.close()

    const activated = eventsOf(transcript.events, "skill.activated")[0]
    const stepSource = sourceFor(eventsOf(transcript.events, "context.step")[0].snapshot, "skills_slot")
    const requestText = provider.requests[0]?.messages.map((message) => message.content).join("\n") ?? ""

    expect(activated).toMatchObject({ name: "Huge", truncated: true })
    expect(activated.bytes).toBeLessThan(Buffer.byteLength(hugeContent, "utf8"))
    expect(stepSource.status).toBe("truncated")
    expect(stepSource.note).toBe("1 active skill")
    expect(requestText).toContain("[truncated: capped at 32768 bytes]")
    expect(requestText).toContain("[truncated: SKILL.md capped at")
    expect(requestText).not.toContain(hugeTail)
  })
})

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

async function createTestSession(input: {
  root: string
  provider: FakeProvider
  transcript: TranscriptSink
  registry?: ToolRegistry
  todoState?: TodoState
  permissionMode?: PermissionMode
  skillDirs?: string[]
  enabledSkills?: string[]
}): Promise<AgentSession> {
  const todoState = input.todoState ?? new TodoState()
  const registry = input.registry ?? createBuiltinToolRegistry({ todoState })
  return AgentSession.create({
    cwd: input.root,
    provider: input.provider,
    toolRuntime: new RealToolRuntime({
      registry,
      workspace: await WorkspaceFs.create(input.root),
      permissionMode: input.permissionMode,
    }),
    transcript: input.transcript,
    todoState,
    skillDirs: input.skillDirs,
    enabledSkills: input.enabledSkills,
  })
}

function outputFor(events: SessionEvent[], command: string): string {
  return (
    events.find(
      (event): event is Extract<SessionEvent, { type: "command.output" }> =>
        event.type === "command.output" && event.command === command,
    )?.content ?? ""
  )
}

function eventsOf<T extends SessionEvent["type"]>(
  events: SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

function sourceFor(snapshot: { sources: SessionEventSource[] }, kind: SessionEventSource["kind"]): SessionEventSource {
  const source = snapshot.sources.find((item) => item.kind === kind)
  if (!source) throw new Error(`Missing context source: ${kind}`)
  return source
}

type SessionEventSource = Extract<SessionEvent, { type: "context.step" }>["snapshot"]["sources"][number]

async function writeSkill(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, "skills", name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), content, "utf8")
  return dir
}

function skillMarkdown(name: string, description: string, instruction: string): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", `# ${name}`, instruction, ""].join("\n")
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
      return { content: "ok" }
    },
  }
}
