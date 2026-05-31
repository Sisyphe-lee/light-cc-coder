import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { readJsonlTranscript, replayProviderMessages } from "../../src/engine/transcript"
import { FakeProvider, type FakeProviderStep } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 1 integration", () => {
  test("FakeProvider + real ToolRuntime supports read then final answer", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "hello\n", "utf8")
    const session = await createRealSession(root, [
      { message: assistant("a1", "need read", [call("c1", "read", { path: "a.txt" })]) },
      { message: assistant("a2", "done") },
    ])

    await session.submit({ type: "user_message", content: "read a.txt" })
    await session.close()

    const toolResult = session.getMessages().find((message) => message.role === "tool")
    expect(toolResult?.role === "tool" ? toolResult.content : "").toContain("1 | hello")
  })

  test("read/edit workflow writes before the next model step", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "old\n", "utf8")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "edit", [call("c1", "edit", { path: "a.txt", oldText: "old", newText: "new" })]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createRealSession(root, [], provider)

    await session.submit({ type: "user_message", content: "edit a.txt" })
    await session.close()

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("new\n")
    expect(provider.requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("Edited a.txt"))).toBe(true)
  })

  test("malformed apply_patch returns an error result and the model can continue", async () => {
    const root = await createTempWorkspace()
    const session = await createRealSession(root, [
      { message: assistant("a1", "patch", [call("c1", "apply_patch", { patch: "*** nope" })]) },
      { message: assistant("a2", "continued") },
    ])

    await session.submit({ type: "user_message", content: "patch" })
    await session.close()

    const messages = session.getMessages()
    const toolResult = messages.find((message) => message.role === "tool")
    expect(toolResult).toMatchObject({ role: "tool", isError: true })
    expect(toolResult?.role === "tool" ? toolResult.content : "").toContain("malformed_patch")
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "continued" })
  })

  test("transcript replay remains valid with real file tool results", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "hello\n", "utf8")
    const transcriptPath = join(root, "session.jsonl")
    const session = await createRealSession(
      root,
      [
        { message: assistant("a1", "read", [call("c1", "read", { path: "a.txt" })]) },
        { message: assistant("a2", "done") },
      ],
      undefined,
      transcriptPath,
    )

    await session.submit({ type: "user_message", content: "read" })
    await session.close()

    const replayed = replayProviderMessages(await readJsonlTranscript(transcriptPath))
    expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
  })
})

async function createRealSession(
  root: string,
  steps: FakeProviderStep[],
  provider = new FakeProvider({ steps }),
  transcript?: string,
): Promise<AgentSession> {
  const workspace = await WorkspaceFs.create(root)
  return AgentSession.create({
    cwd: root,
    provider,
    toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
    transcript,
  })
}
