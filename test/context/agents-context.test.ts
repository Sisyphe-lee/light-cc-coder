import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { buildContextPrefix } from "../../src/engine/contextBuilder"
import { loadRootAgentsMd } from "../../src/context/agentsMd"
import { renderProjectInstructions } from "../../src/engine/ContextAssembler"
import { readJsonlTranscript, replayProviderMessages } from "../../src/engine/transcript"
import type { ContextSourceKind, ContextSourceSnapshot } from "../../src/engine/contextTypes"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, createTempWorkspace, MemoryTranscriptSink } from "../helpers"

describe("AGENTS.md context", () => {
  test("loads missing and truncated root AGENTS.md without recursion", async () => {
    const root = await createTempWorkspace()
    await expect(loadRootAgentsMd(root)).resolves.toBeUndefined()
    await writeFile(join(root, "AGENTS.md"), "a".repeat(20), "utf8")

    const loaded = await loadRootAgentsMd(root, 8)
    expect(loaded?.content).toBe("aaaaaaaa")
    expect(renderProjectInstructions(loaded!)).toContain("[truncated:")
    expect(loaded?.truncated).toBe(true)
    expect(loaded?.bytes).toBe(8)
    expect(loaded?.originalBytes).toBe(20)
    expect(loaded?.hash).toBeDefined()
  })

  test("context builder compatibility wrapper separates project instructions from system prompt", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "Use bun.", "utf8")
    const agentsMd = await loadRootAgentsMd(root)
    const prefix = buildContextPrefix({ cwd: root, agentsMd })

    expect(prefix).toHaveLength(2)
    expect(prefix[0]).toMatchObject({ role: "system" })
    expect(prefix[0]?.content).toContain("Workspace root")
    expect(prefix[0]?.content).not.toContain("Use bun.")
    expect(prefix[1]).toMatchObject({ role: "user" })
    expect(prefix[1]?.content).toContain("Use bun.")
  })

  test("AgentSession provider request includes project meta context, diagnostics, and tool schemas", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "Project rule.", "utf8")
    const workspace = await WorkspaceFs.create(root)
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const transcript = new MemoryTranscriptSink()
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
      transcript,
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    expect(provider.requests[0]?.messages[0]).toMatchObject({ role: "system" })
    expect(provider.requests[0]?.messages[0]?.content).not.toContain("Project rule.")
    expect(provider.requests[0]?.messages[1]).toMatchObject({ role: "user" })
    expect(provider.requests[0]?.messages[1]?.content).toContain("Project rule.")
    expect(provider.requests[0]?.messages.at(-1)).toMatchObject({ role: "user", content: "hello" })
    expect(Array.isArray(provider.requests[0]?.tools)).toBe(true)
    expect((provider.requests[0]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toContain("read")
    expect(transcript.events.some((event) => hasType(event, "context.session"))).toBe(true)
    expect(transcript.events.some((event) => hasType(event, "context.step"))).toBe(true)
  })

  test("transcript context diagnostics keep AGENTS.md changes unambiguous without affecting replay", async () => {
    const root = await createTempWorkspace()
    const agentsPath = join(root, "AGENTS.md")
    await writeFile(agentsPath, "Original rule.", "utf8")
    const transcriptPath = join(root, "session.jsonl")
    const workspace = await WorkspaceFs.create(root)
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
      transcript: transcriptPath,
    })

    await writeFile(agentsPath, "Changed rule.", "utf8")
    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    const events = await readJsonlTranscript(transcriptPath)
    const contextSession = events.find((event) => event.type === "context.session")
    const contextStep = events.find((event) => event.type === "context.step")
    expect(contextSession?.type).toBe("context.session")
    expect(contextStep?.type).toBe("context.step")
    if (contextSession?.type !== "context.session" || contextStep?.type !== "context.step") {
      throw new Error("Expected context diagnostics")
    }

    expect(source(contextSession.snapshot.sources, "project_instructions").hash).toBe(
      source(contextStep.snapshot.sources, "project_instructions").hash,
    )
    expect(provider.requests[0]?.messages[1]?.content).toContain("Original rule.")
    expect(provider.requests[0]?.messages[1]?.content).not.toContain("Changed rule.")
    expect(replayProviderMessages(events)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
    ])
  })
})

function hasType(event: unknown, type: string): boolean {
  return typeof event === "object" && event !== null && "type" in event && event.type === type
}

function source(sources: ContextSourceSnapshot[], kind: ContextSourceKind): ContextSourceSnapshot {
  const found = sources.find((item) => item.kind === kind)
  if (!found) throw new Error(`Missing source ${kind}`)
  return found
}
