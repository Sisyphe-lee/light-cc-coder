import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ContextAssembler } from "../../src/engine/ContextAssembler"
import type { ContextSourceKind, ContextSourceSnapshot } from "../../src/engine/contextTypes"
import type { InternalMessage } from "../../src/core/messages"
import { makeToolResultMessage } from "../../src/core/messages"
import { assistant, call, createTempWorkspace, user } from "../helpers"

const expectedSourceOrder: ContextSourceKind[] = [
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

describe("ContextAssembler extra coverage", () => {
  test("keeps source ordering and stable hashes deterministic across equivalent schema object key order", async () => {
    const firstRoot = await createTempWorkspace()
    const secondRoot = await createTempWorkspace()
    await writeFile(join(firstRoot, "AGENTS.md"), "Use bun.\n", "utf8")
    await writeFile(join(secondRoot, "AGENTS.md"), "Use bun.\n", "utf8")

    const first = await createAssembler(firstRoot, () => [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, limit: { type: "number" } },
            required: ["path"],
          },
        },
      },
    ]).initialize()
    const second = await createAssembler(secondRoot, () => [
      {
        function: {
          parameters: {
            required: ["path"],
            properties: { limit: { type: "number" }, path: { type: "string" } },
            type: "object",
          },
          description: "Read a file",
          name: "read",
        },
        type: "function",
      },
    ]).initialize()

    expect(first.sources.map((item) => item.kind)).toEqual(expectedSourceOrder)
    expect(second.sources.map((item) => item.kind)).toEqual(expectedSourceOrder)
    expect(source(first.sources, "tool_schemas").hash).toBe(source(second.sources, "tool_schemas").hash)
    expect(first.toolSchemaHash).toBe(second.toolSchemaHash)
    expect(source(first.sources, "project_instructions").hash).toBe(source(second.sources, "project_instructions").hash)
  })

  test("captures runtime facts as a session snapshot and does not refresh them per step", async () => {
    const root = await createTempWorkspace()
    let nowCalls = 0
    const assembler = new ContextAssembler({
      sessionId: "session_1",
      cwd: root,
      now: () => {
        nowCalls += 1
        return `2026-05-31T00:00:0${nowCalls}.000Z`
      },
    })

    const session = await assembler.initialize()
    const first = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages: [user("u1", "hello")] })
    const second = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages: [user("u1", "again")] })

    expect(nowCalls).toBe(1)
    expect(session.createdAt).toBe("2026-05-31T00:00:01.000Z")
    expect(first.snapshot.createdAt).toBe(session.createdAt)
    expect(second.snapshot.createdAt).toBe(session.createdAt)
    expect(first.messages[0]?.content).toContain(`Workspace root (snapshot): ${root}`)
    expect(first.messages[0]?.content).toContain("Session started at (snapshot): 2026-05-31T00:00:01.000Z")
    expect(first.snapshot.stablePrefixHash).toBe(second.snapshot.stablePrefixHash)
  })

  test("diagnoses non-file and empty AGENTS.md without injecting project meta messages", async () => {
    const nonFileRoot = await createTempWorkspace()
    await mkdir(join(nonFileRoot, "AGENTS.md"))
    const nonFileAssembler = createAssembler(nonFileRoot)
    await nonFileAssembler.initialize()
    const nonFile = nonFileAssembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_1",
      messages: [user("u1", "hello")],
    })

    expect(source(nonFile.snapshot.sources, "project_instructions").status).toBe("missing")
    expect(nonFile.snapshot.prefixMessageCount).toBe(1)
    expect(nonFile.messages).toHaveLength(2)
    expect(nonFile.messages[1]).toMatchObject({ role: "user", content: "hello" })

    const emptyRoot = await createTempWorkspace()
    await writeFile(join(emptyRoot, "AGENTS.md"), "", "utf8")
    const emptyAssembler = createAssembler(emptyRoot)
    await emptyAssembler.initialize()
    const empty = emptyAssembler.assembleStep({
      turnId: "turn_1",
      stepId: "step_1",
      messages: [user("u1", "hello")],
    })

    const emptySource = source(empty.snapshot.sources, "project_instructions")
    expect(emptySource.status).toBe("empty")
    expect(emptySource.hash).toBeDefined()
    expect(empty.snapshot.prefixMessageCount).toBe(1)
    expect(empty.messages).toHaveLength(2)
    expect(empty.messages[1]).toMatchObject({ role: "user", content: "hello" })
  })

  test("keeps truncated AGENTS.md deterministic and model-visible after the file changes", async () => {
    const root = await createTempWorkspace()
    const agentsPath = join(root, "AGENTS.md")
    await writeFile(agentsPath, `${"a".repeat(32 * 1024)}tail`, "utf8")
    const assembler = createAssembler(root)
    const session = await assembler.initialize()

    await writeFile(agentsPath, "short replacement", "utf8")
    const first = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages: [user("u1", "hello")] })
    const second = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages: [user("u1", "hello")] })

    expect(source(session.sources, "project_instructions").status).toBe("truncated")
    expect(source(first.snapshot.sources, "project_instructions").status).toBe("truncated")
    expect(source(first.snapshot.sources, "project_instructions").hash).toBe(
      source(session.sources, "project_instructions").hash,
    )
    expect(first.messages[1]?.content).toContain("[truncated: AGENTS.md capped at 32768 bytes]")
    expect(first.messages[1]?.content).not.toContain("short replacement")
    expect(first.snapshot.stablePrefixHash).toBe(second.snapshot.stablePrefixHash)
  })

  test("reports tool schema mutation diagnostics without changing the stable prefix", async () => {
    const root = await createTempWorkspace()
    let schemas: unknown[] = [toolSchema("read", "Read a file")]
    const assembler = createAssembler(root, () => schemas)
    const session = await assembler.initialize()
    const before = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages: [user("u1", "hello")] })

    schemas = [toolSchema("read", "Read a file"), toolSchema("write", "Write a file")]
    const after = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages: [user("u1", "hello")] })

    expect(before.snapshot.toolSchemaChanged).toBe(false)
    expect(after.snapshot.toolSchemaChanged).toBe(true)
    expect(after.snapshot.stablePrefixHash).toBe(session.stablePrefixHash)
    expect(after.snapshot.stablePrefixHash).toBe(before.snapshot.stablePrefixHash)
    expect(after.snapshot.toolSchemaHash).not.toBe(before.snapshot.toolSchemaHash)
    expect(source(after.snapshot.sources, "tool_schemas").note).toBe("2 tools")
    expect(after.snapshot.requestHash).not.toBe(before.snapshot.requestHash)
  })

  test("appends changing todo context after history to preserve cached prefix and history", async () => {
    const root = await createTempWorkspace()
    let todoContext = "- pending\tt1\tinspect cache behavior"
    const assembler = new ContextAssembler({
      sessionId: "session_1",
      cwd: root,
      now: () => "2026-05-31T00:00:00.000Z",
      getTodoContext: () => todoContext,
    })
    await assembler.initialize()
    const messages = [user("u1", "hello")]

    const first = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages })
    todoContext = "- in_progress\tt1\tinspect cache behavior"
    const second = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages })

    expect(first.snapshot.stablePrefixHash).toBe(second.snapshot.stablePrefixHash)
    expect(first.snapshot.historyHash).toBe(second.snapshot.historyHash)
    expect(first.snapshot.prefixMessageCount).toBe(1)
    expect(first.messages[0]).toEqual(second.messages[0])
    expect(first.messages[1]).toEqual({ role: "user", content: "hello" })
    expect(second.messages[1]).toEqual({ role: "user", content: "hello" })
    expect(first.messages[2]?.content).toContain("Session todo context")
    expect(second.messages[2]?.content).toContain("Session todo context")
    expect(first.messages[2]?.content).toContain("pending")
    expect(second.messages[2]?.content).toContain("in_progress")
  })

  test("assembleStep does not reread AGENTS.md after initialization", async () => {
    const root = await createTempWorkspace()
    const agentsPath = join(root, "AGENTS.md")
    await writeFile(agentsPath, "Original project rule.", "utf8")
    const assembler = createAssembler(root)
    await assembler.initialize()

    await writeFile(agentsPath, "Changed project rule.", "utf8")
    const first = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages: [user("u1", "hello")] })
    await writeFile(agentsPath, "", "utf8")
    const second = assembler.assembleStep({ turnId: "turn_1", stepId: "step_2", messages: [user("u1", "hello")] })

    expect(first.messages[1]?.content).toContain("Original project rule.")
    expect(first.messages[1]?.content).not.toContain("Changed project rule.")
    expect(second.messages[1]?.content).toContain("Original project rule.")
    expect(source(second.snapshot.sources, "project_instructions").status).toBe("included")
    expect(source(second.snapshot.sources, "project_instructions").hash).toBe(
      source(first.snapshot.sources, "project_instructions").hash,
    )
  })

  test("assembleStep projects history without mutating internal messages", async () => {
    const root = await createTempWorkspace()
    const firstCall = call("call_1", "read", { path: "src/index.ts" })
    const messages: InternalMessage[] = [
      user("u1", "inspect"),
      assistant("a1", "reading", [firstCall]),
      makeToolResultMessage({ id: "tr1", call: firstCall, content: "file contents" }),
      user("u2", "continue"),
    ]
    const before = structuredClone(messages)
    deepFreeze(messages)

    const assembler = createAssembler(root)
    await assembler.initialize()
    const assembled = assembler.assembleStep({ turnId: "turn_1", stepId: "step_1", messages })

    expect(messages).toEqual(before)
    expect(assembled.snapshot.historyMessageCount).toBe(4)
    expect(assembled.snapshot.providerMessageCount).toBe(5)
    expect(assembled.messages.slice(1)).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "reading",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "src/index.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      { role: "user", content: "continue" },
    ])
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

function toolSchema(name: string, description: string) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  }
}

function source(sources: ContextSourceSnapshot[], kind: ContextSourceKind): ContextSourceSnapshot {
  const found = sources.find((item) => item.kind === kind)
  if (!found) throw new Error(`Missing source ${kind}`)
  return found
}

function deepFreeze(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
