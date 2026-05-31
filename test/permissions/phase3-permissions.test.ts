import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import type { PermissionMode } from "../../src/permissions/types"
import { call, createTempWorkspace } from "../helpers"

describe("Phase 3 permission policy", () => {
  test("read-only allows reads but denies writers and bash", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "hello\n", "utf8")
    const runtime = await createRuntime(root, "read-only")

    const results = await runtime.runBatch(
      [
        call("c1", "read", { path: "a.txt" }),
        call("c2", "write", { path: "b.txt", content: "x" }),
        call("c3", "apply_patch", { patch: "*** Begin Patch\n*** Add File: c.txt\n+x\n*** End Patch" }),
        call("c4", "bash", { command: "echo nope" }),
      ],
      ctx(),
    )

    expect(results.map((result) => result.isError)).toEqual([false, true, true, true])
    expect(results[1]?.content).toContain("permission_denied")
    expect(results[2]?.content).toContain("permission_denied")
    expect(results[3]?.content).toContain("Bash is denied in read-only mode")
  })

  test("workspace-write allows file writes and asks for ordinary bash", async () => {
    const root = await createTempWorkspace()
    const runtime = await createRuntime(root, "workspace-write")

    const results = await runtime.runBatch(
      [
        call("c1", "write", { path: "ok.txt", content: "ok\n" }),
        call("c2", "bash", { command: "echo needs approval" }),
      ],
      ctx(),
    )

    expect(await readFile(join(root, "ok.txt"), "utf8")).toBe("ok\n")
    expect(results[0]?.isError).toBe(false)
    expect(results[1]).toMatchObject({ isError: true })
    expect(results[1]?.content).toContain("Approval required")
  })

  test("workspace-write allows tiny git inspection commands without approval", async () => {
    const root = await createTempWorkspace()
    const runtime = await createRuntime(root, "workspace-write")

    const results = await runtime.runBatch([call("c1", "bash", { command: "git status --short" })], ctx())

    expect(results).toHaveLength(1)
    expect(results[0]?.content).toContain("Command: git status --short")
    expect(results[0]?.content).not.toContain("permission_denied")
  })

  test("danger-full-access runs non-denied bash but hard-denies dangerous commands", async () => {
    const root = await createTempWorkspace()
    const runtime = await createRuntime(root, "danger-full-access")

    const ok = await runtime.runBatch([call("c1", "bash", { command: "echo allowed" })], ctx())
    const denied = await runtime.runBatch([call("c2", "bash", { command: "git push origin main" })], ctx())

    expect(ok[0]).toMatchObject({ isError: false })
    expect(ok[0]?.content).toContain("allowed")
    expect(denied[0]).toMatchObject({ isError: true })
    expect(denied[0]?.content).toContain("permission_denied")
    expect(denied[0]?.content).toContain("Mutating git command is denied")
  })

  test("approval allow and deny control bash execution", async () => {
    const root = await createTempWorkspace()
    const runtime = await createRuntime(root, "workspace-write")

    const allowed = await runtime.runBatch(
      [call("c1", "bash", { command: "echo approved" })],
      ctx(undefined, "allow"),
    )
    const denied = await runtime.runBatch(
      [call("c2", "bash", { command: "touch denied.txt" })],
      ctx(undefined, "deny"),
    )

    expect(allowed[0]).toMatchObject({ isError: false })
    expect(allowed[0]?.content).toContain("approved")
    expect(denied[0]).toMatchObject({ isError: true })
    expect(denied[0]?.content).toContain("User denied approval")
  })

  test("file and apply_patch sandbox denials are model-visible and non-partial", async () => {
    const root = await createTempWorkspace()
    const outside = await createTempWorkspace("light-cc-outside-")
    await writeFile(join(root, "keep.txt"), "keep\n", "utf8")
    const runtime = await createRuntime(root, "workspace-write")

    const outsideWrite = await runtime.runBatch(
      [call("c1", "write", { path: join(outside, "no.txt"), content: "no" })],
      ctx(),
    )
    const partialPatch = await runtime.runBatch(
      [
        call("c2", "apply_patch", {
          patch: `*** Begin Patch\n*** Update File: keep.txt\n@@\n-keep\n+changed\n*** Update File: ${join(outside, "bad.txt")}\n@@\n-x\n+y\n*** End Patch`,
        }),
      ],
      ctx(),
    )

    expect(outsideWrite[0]).toMatchObject({ isError: true })
    expect(outsideWrite[0]?.content).toContain("path_denied")
    expect(partialPatch[0]).toMatchObject({ isError: true })
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep\n")
  })
})

async function createRuntime(root: string, permissionMode: PermissionMode): Promise<RealToolRuntime> {
  const workspace = await WorkspaceFs.create(root)
  return new RealToolRuntime({
    registry: createBuiltinToolRegistry(),
    workspace,
    runtime: await LocalRuntime.create({ workspaceRoot: workspace.root }),
    permissionMode,
  })
}

function ctx(signal?: AbortSignal, approval?: "allow" | "deny"): ToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepId: "step1",
    signal: signal ?? new AbortController().signal,
    approvals: approval
      ? {
          async request() {
            return approval
          },
        }
      : undefined,
  }
}
