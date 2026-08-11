import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ContextAssembler,
  GLOBAL_SYSTEM_PROMPT,
  renderProjectInstructions,
} from "../../src/engine/ContextAssembler"
import type { ContextSourceKind, ContextSourceSnapshot } from "../../src/engine/contextTypes"
import { loadRootAgentsMd } from "../../src/context/agentsMd"
import { createTempWorkspace, user } from "../helpers"

const sourceOrder: ContextSourceKind[] = [
  "global_system_prompt",
  "user_prompt_slot",
  "runtime_facts",
  "project_instructions",
  "memory_slot",
  "todo_slot",
  "git_slot",
  "skills_slot",
  "mcp_slot",
  "compact_slot",
  "history_projection",
  "tool_schemas",
]

describe("ContextAssembler", () => {
  test("initializes deterministic source slots in the required order", async () => {
    const root = await createTempWorkspace()
    const assembler = createAssembler(root)
    const snapshot = await assembler.initialize()

    expect(snapshot.sources.map((source) => source.kind)).toEqual(sourceOrder)
    expect(snapshot.sources.map((source) => source.order)).toEqual(sourceOrder.map((_, index) => index + 1))
    expect(source(snapshot.sources, "project_instructions").status).toBe("missing")
    expect(source(snapshot.sources, "memory_slot").status).toBe("empty")
    expect(source(snapshot.sources, "todo_slot").status).toBe("empty")
    expect(source(snapshot.sources, "git_slot").status).toBe("empty")
    expect(source(snapshot.sources, "skills_slot").status).toBe("empty")
    expect(source(snapshot.sources, "mcp_slot").status).toBe("empty")
    expect(source(snapshot.sources, "compact_slot").status).toBe("empty")
  })

  test("global system prompt is stable and excludes session/project facts", async () => {
    const firstRoot = await createTempWorkspace()
    const secondRoot = await createTempWorkspace()
    await writeFile(join(secondRoot, "AGENTS.md"), "Use bun.", "utf8")

    const first = await createAssembler(firstRoot).initialize()
    const second = await createAssembler(secondRoot).initialize()

    expect(source(first.sources, "global_system_prompt").hash).toBe(source(second.sources, "global_system_prompt").hash)
    expect(GLOBAL_SYSTEM_PROMPT).not.toContain(firstRoot)
    expect(GLOBAL_SYSTEM_PROMPT).not.toContain("2026-05-31")
    expect(GLOBAL_SYSTEM_PROMPT).not.toContain("Use bun.")
  })

  test("missing AGENTS.md records a missing source and injects no project meta message", async () => {
    const root = await createTempWorkspace()
    const assembler = createAssembler(root)
    await assembler.initialize()

    const assembled = assembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_1",
      messages: [user("u1", "hello")],
    })

    expect(assembled.messages).toHaveLength(3)
    expect(assembled.messages[0]).toMatchObject({ role: "system" })
    expect(assembled.messages[1]).toMatchObject({ role: "user", content: "hello" })
    expect(assembled.messages[2]?.content).toContain("Active trajectory rules")
    expect(source(assembled.snapshot.sources, "project_instructions").status).toBe("missing")
  })

  test("root AGENTS.md is injected as project meta context before history", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "Use bun.\n", "utf8")
    const assembler = createAssembler(root)
    await assembler.initialize()

    const assembled = assembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_1",
      messages: [user("u1", "hello")],
    })

    expect(assembled.messages).toHaveLength(4)
    expect(assembled.messages[0]).toMatchObject({ role: "system" })
    expect(assembled.messages[0]?.content).not.toContain("Use bun.")
    expect(assembled.messages[1]).toMatchObject({ role: "user" })
    expect(assembled.messages[1]?.content).toContain("<system-reminder>")
    expect(assembled.messages[1]?.content).toContain("Use bun.")
    expect(assembled.messages[2]).toMatchObject({ role: "user", content: "hello" })
    expect(assembled.messages[3]?.content).toContain("Active trajectory rules")
    expect(source(assembled.snapshot.sources, "project_instructions").status).toBe("included")
  })

  test("AGENTS.md is read once per session and diagnosed by hash", async () => {
    const root = await createTempWorkspace()
    const agentsPath = join(root, "AGENTS.md")
    await writeFile(agentsPath, "Original rule.", "utf8")
    const assembler = createAssembler(root)
    const sessionSnapshot = await assembler.initialize()
    const initialHash = source(sessionSnapshot.sources, "project_instructions").hash

    await writeFile(agentsPath, "Changed rule.", "utf8")
    const assembled = assembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_1",
      messages: [user("u1", "hello")],
    })

    expect(assembled.messages[1]?.content).toContain("Original rule.")
    expect(assembled.messages[1]?.content).not.toContain("Changed rule.")
    expect(source(assembled.snapshot.sources, "project_instructions").hash).toBe(initialHash)
  })

  test("oversized AGENTS.md is capped with model-visible truncation diagnostics", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "a".repeat(33 * 1024), "utf8")
    const agentsMd = await loadRootAgentsMd(root)
    expect(agentsMd?.truncated).toBe(true)
    expect(renderProjectInstructions(agentsMd!)).toContain("[truncated: AGENTS.md capped at 32768 bytes]")

    const assembler = createAssembler(root)
    await assembler.initialize()
    const assembled = assembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_1",
      messages: [user("u1", "hello")],
    })

    expect(source(assembled.snapshot.sources, "project_instructions").status).toBe("truncated")
    expect(assembled.messages[1]?.content).toContain("[truncated: AGENTS.md capped at 32768 bytes]")
  })

  test("tool schema and stable prefix hashes stay stable across repeated assemblies", async () => {
    const root = await createTempWorkspace()
    const schemas = [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ]
    const assembler = createAssembler(root, () => schemas)
    const sessionSnapshot = await assembler.initialize()
    const first = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages: [user("u1", "hello")] })
    const second = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages: [user("u1", "hello")] })
    const appended = assembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_3",
      messages: [user("u1", "hello"), user("u2", "again")],
    })

    expect(first.tools).toEqual(schemas)
    expect(first.snapshot.stablePrefixHash).toBe(sessionSnapshot.stablePrefixHash)
    expect(first.snapshot.stablePrefixHash).toBe(second.snapshot.stablePrefixHash)
    expect(first.snapshot.toolSchemaHash).toBe(second.snapshot.toolSchemaHash)
    expect(first.snapshot.toolSchemaChanged).toBe(false)
    expect(source(first.snapshot.sources, "tool_schemas").hash).toBe(source(second.snapshot.sources, "tool_schemas").hash)
    expect(appended.snapshot.stablePrefixHash).toBe(first.snapshot.stablePrefixHash)
    expect(appended.snapshot.toolSchemaHash).toBe(first.snapshot.toolSchemaHash)
    expect(appended.snapshot.historyHash).not.toBe(first.snapshot.historyHash)
    expect(appended.snapshot.requestHash).not.toBe(first.snapshot.requestHash)
  })

  test("runtime facts include permission and sandbox limits as a stable session snapshot", async () => {
    const root = await createTempWorkspace()
    let sandboxStatus: "not_initialized" | "fallback" = "not_initialized"
    const assembler = new ContextAssembler({
      sessionId: "session_1",
      cwd: root,
      now: () => "2026-05-31T00:00:00.000Z",
      getRuntimeContext: () => ({
        permissionMode: "workspace-write",
        osSandbox: {
          mode: "auto",
          status: sandboxStatus,
          fallbackReason: sandboxStatus === "fallback" ? "package missing" : undefined,
          allowDomains: ["example.com"],
          allowWrites: ["/tmp/lightcc-extra"],
        },
      }),
    })
    await assembler.initialize()

    const first = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages: [user("u1", "hello")] })
    sandboxStatus = "fallback"
    const second = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages: [user("u1", "hello")] })

    expect(first.messages[0]?.content).toContain("Permission mode: workspace-write")
    expect(first.messages[0]?.content).toContain("Requires approval: bash")
    expect(first.messages[0]?.content).toContain("OS sandbox status: not_initialized")
    expect(second.messages[0]?.content).toContain("OS sandbox status: not_initialized")
    expect(second.messages[0]?.content).not.toContain("OS sandbox status: fallback")
    expect(second.messages[0]?.content).not.toContain("OS sandbox fallback reason: package missing")
    expect(second.snapshot.stablePrefixHash).toBe(first.snapshot.stablePrefixHash)
    expect(source(second.snapshot.sources, "runtime_facts").hash).toBe(source(first.snapshot.sources, "runtime_facts").hash)
  })
})

function createAssembler(root: string, getToolSchemas?: () => unknown[]) {
  return new ContextAssembler({
    sessionId: "session_1",
    cwd: root,
    now: () => "2026-05-31T00:00:00.000Z",
    getToolSchemas,
  })
}

function source(sources: ContextSourceSnapshot[], kind: ContextSourceKind): ContextSourceSnapshot {
  const found = sources.find((item) => item.kind === kind)
  if (!found) throw new Error(`Missing source ${kind}`)
  return found
}
