import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { TranscriptWriteError } from "../../src/core/errors"
import type { ProviderRequest } from "../../src/providers/types"
import { FakeProvider, type FakeProviderStep } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, collectAsync, createTempWorkspace, MemoryTranscriptSink } from "../helpers"

describe("Phase 1 extra integration", () => {
  test("FakeProvider + real ToolRuntime supports glob then read then edit across model steps", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "other.ts"), "export const other = true\n", "utf8")
    await writeFile(join(root, "src", "target.ts"), "export const value = 'old'\n", "utf8")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "find files", [call("c1", "glob", { pattern: "src/*.ts" })]) },
        { message: assistant("a2", "read target", [call("c2", "read", { path: "src/target.ts" })]) },
        {
          message: assistant("a3", "edit target", [
            call("c3", "edit", { path: "src/target.ts", oldText: "'old'", newText: "'new'" }),
          ]),
        },
        { message: assistant("a4", "done") },
      ],
    })
    const session = await createRealSession(root, [], provider)

    await session.submit({ type: "user_message", content: "update the target file" })
    await session.close()

    expect(await readFile(join(root, "src", "target.ts"), "utf8")).toBe("export const value = 'new'\n")
    expect(provider.requests).toHaveLength(4)
    expect(toolContent(provider.requests[1], "c1")).toContain("src/target.ts")
    expect(toolContent(provider.requests[2], "c2")).toContain("1 | export const value = 'old'")
    expect(toolContent(provider.requests[3], "c3")).toContain("Edited src/target.ts")
    expect(session.getMessages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ])
  })

  test("grep max cap is visible to the next model step before final answer", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "notes.txt"), "needle one\nneedle two\nneedle three\n", "utf8")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "search", [call("c1", "grep", { pattern: "needle", maxResults: 2 })]) },
        { message: assistant("a2", "saw capped grep results") },
      ],
    })
    const session = await createRealSession(root, [], provider)

    await session.submit({ type: "user_message", content: "find needles" })
    await session.close()

    const grepResult = toolContent(provider.requests[1], "c1")
    expect(grepResult).toContain("notes.txt:1:1:needle one")
    expect(grepResult).toContain("notes.txt:2:1:needle two")
    expect(grepResult).not.toContain("needle three")
    expect(grepResult).toContain("[truncated: more than 2 matches]")
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", content: "saw capped grep results" })
  })

  test("write refuses existing file without overwrite and the model continues", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "existing.txt"), "original\n", "utf8")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "write", [call("c1", "write", { path: "existing.txt", content: "bad\n" })]) },
        { message: assistant("a2", "continued after refusal") },
      ],
    })
    const session = await createRealSession(root, [], provider)

    await session.submit({ type: "user_message", content: "try to write existing.txt" })
    await session.close()

    const writeResult = session.getMessages().find((message) => message.role === "tool")
    expect(writeResult).toMatchObject({ role: "tool", isError: true })
    expect(writeResult?.role === "tool" ? writeResult.content : "").toContain("patch_conflict")
    expect(toolContent(provider.requests[1], "c1")).toContain("File already exists; set overwrite=true")
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("original\n")
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", content: "continued after refusal" })
  })

  test("apply_patch multi-file validation failure leaves every planned file unchanged", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "one\ntwo\n", "utf8")
    await writeFile(join(root, "b.txt"), "alpha\nbeta\n", "utf8")
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " one",
      "-two",
      "+changed",
      "*** Add File: created.txt",
      "+created",
      "*** Update File: b.txt",
      "@@",
      "-missing",
      "+bad",
      "*** End Patch",
    ].join("\n")
    const session = await createRealSession(root, [
      { message: assistant("a1", "patch", [call("c1", "apply_patch", { patch })]) },
      { message: assistant("a2", "continued after patch failure") },
    ])

    await session.submit({ type: "user_message", content: "apply multi-file patch" })
    await session.close()

    const patchResult = session.getMessages().find((message) => message.role === "tool")
    expect(patchResult).toMatchObject({ role: "tool", isError: true })
    expect(patchResult?.role === "tool" ? patchResult.content : "").toContain("patch_conflict")
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n")
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("alpha\nbeta\n")
    await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toThrow()
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", content: "continued after patch failure" })
  })

  test("transcript failure on real tool.result rolls back unpaired in-memory session state", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "hello\n", "utf8")
    const transcript = new MemoryTranscriptSink("tool.result")
    const session = await createRealSession(
      root,
      [{ message: assistant("a1", "read", [call("c1", "read", { path: "a.txt" })]) }],
      undefined,
      transcript,
    )

    await expect(session.submit({ type: "user_message", content: "read a.txt" })).rejects.toThrow(TranscriptWriteError)
    expect(session.getMessages().map((message) => message.role)).toEqual(["user"])
    expect(() => session.projectProviderMessages()).not.toThrow()
    expect(session.projectProviderMessages()).toEqual([{ role: "user", content: "read a.txt" }])

    await session.close()
    const events = await collectAsync(session.events())
    expect(events.some((event) => event.type === "assistant.message")).toBe(true)
    expect(events.some((event) => event.type === "tool.result")).toBe(false)
    expect(events.some((event) => event.type === "error" && event.recoverable === false)).toBe(true)
  })
})

async function createRealSession(
  root: string,
  steps: FakeProviderStep[],
  provider = new FakeProvider({ steps }),
  transcript?: AgentSessionCreateTranscript,
): Promise<AgentSession> {
  const workspace = await WorkspaceFs.create(root)
  return AgentSession.create({
    cwd: root,
    provider,
    toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
    transcript,
  })
}

type AgentSessionCreateTranscript = Parameters<typeof AgentSession.create>[0]["transcript"]

function toolContent(request: ProviderRequest | undefined, toolCallId: string): string {
  const message = request?.messages.find((item) => item.role === "tool" && item.tool_call_id === toolCallId)
  expect(message).toBeDefined()
  return message?.role === "tool" ? message.content : ""
}
