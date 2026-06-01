import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, createTempWorkspace } from "../helpers"

describe("Phase 2 provider request context", () => {
  test("AGENTS.md is injected as project meta user message, not system prompt text", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "Use bun for tests.\nNever touch src in this test.\n", "utf8")
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })

    await runSingleTurn(root, provider)

    const request = provider.requests[0]
    expect(request?.messages[0]).toMatchObject({ role: "system" })
    expect(request?.messages[0]?.content).toContain("Workspace root")
    expect(request?.messages[0]?.content).not.toContain("Use bun for tests.")
    expect(request?.messages[0]?.content).not.toContain("Never touch src in this test.")

    expect(request?.messages[1]).toMatchObject({ role: "user" })
    expect(request?.messages[1]?.content).toContain("Project instructions from AGENTS.md:")
    expect(request?.messages[1]?.content).toContain("Use bun for tests.")
    expect(request?.messages[2]).toMatchObject({ role: "user", content: "hello" })
  })

  test("missing AGENTS.md does not inject project meta before the real user prompt", async () => {
    const root = await createTempWorkspace()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })

    await runSingleTurn(root, provider)

    const request = provider.requests[0]
    expect(request?.messages[0]).toMatchObject({ role: "system" })
    expect(request?.messages[1]).toMatchObject({ role: "user", content: "hello" })
    expect(request?.messages.some((message) => message.content.includes("Project instructions from AGENTS.md"))).toBe(false)
  })

  test("tool schemas stay in the provider request field with stable order", async () => {
    const root = await createTempWorkspace()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })

    await runSingleTurn(root, provider)

    const tools = provider.requests[0]?.tools as Array<{ type: string; function: { name: string } }> | undefined
    expect(Array.isArray(tools)).toBe(true)
    expect(tools?.map((tool) => tool.function.name)).toEqual([
      "read",
      "grep",
      "glob",
      "edit",
      "write",
      "apply_patch",
      "bash",
      "git_feedback",
      "todo",
    ])
    expect(provider.requests[0]?.messages.map((message) => message.content).join("\n")).not.toContain("\"name\":\"read\"")
  })
})

async function runSingleTurn(root: string, provider: FakeProvider): Promise<void> {
  const workspace = await WorkspaceFs.create(root)
  const session = await AgentSession.create({
    cwd: root,
    provider,
    toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
  })

  await session.submit({ type: "user_message", content: "hello" })
  await session.close()
}
