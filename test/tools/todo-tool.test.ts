import { describe, expect, test } from "bun:test"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createTempWorkspace } from "../helpers"

describe("todo tool discipline", () => {
  test("replace requires a reason and at least two items", async () => {
    const root = await createTempWorkspace()
    const runtime = new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace: await WorkspaceFs.create(root),
      permissionMode: "read-only",
    })

    const missingReason = await runtime.runBatch(
      [
        call("c1", "todo", {
          action: "replace",
          items: [
            { id: "a", content: "first", status: "in_progress" },
            { id: "b", content: "second", status: "pending" },
          ],
        }),
      ],
      ctx(),
    )
    const singleItem = await runtime.runBatch(
      [
        call("c2", "todo", {
          action: "replace",
          reason: "track one localized fix",
          items: [{ id: "a", content: "single localized fix", status: "in_progress" }],
        }),
      ],
      ctx(),
    )
    const ok = await runtime.runBatch(
      [
        call("c3", "todo", {
          action: "replace",
          reason: "track two independent tasks",
          items: [
            { id: "a", content: "first", status: "in_progress" },
            { id: "b", content: "second", status: "pending" },
          ],
        }),
      ],
      ctx(),
    )

    expect(missingReason[0]).toMatchObject({ isError: true })
    expect(missingReason[0]?.content).toContain("todo replace requires reason")
    expect(singleItem[0]).toMatchObject({ isError: true })
    expect(singleItem[0]?.content).toContain("todo replace requires at least two items")
    expect(ok[0]).toMatchObject({ isError: false })
  })
})

function ctx(): ToolContext {
  return { sessionId: "s1", turnId: "t1", stepId: "step1", signal: new AbortController().signal }
}
