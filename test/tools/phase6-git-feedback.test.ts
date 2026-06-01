import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createTempWorkspace } from "../helpers"

const execFileAsync = promisify(execFile)

describe("Phase 6 git_feedback builtin", () => {
  test("reports non-git workspaces clearly in read-only mode", async () => {
    const root = await createTempWorkspace()
    const runtime = await createRuntime(root, "read-only")

    const results = await runtime.runBatch([call("c1", "git_feedback", {})], ctx())

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolName: "git_feedback", isError: false })
    expect(results[0]?.content).toContain("Repository: no")
    expect(results[0]?.content).toContain("workspace is not inside a git repository")
  })

  test("runs in workspace-write without approval and redacts sensitive path patch content", async () => {
    const root = await createTempWorkspace()
    await initRepo(root)
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "app.ts"), "export const value = 1\n", "utf8")
    await writeFile(join(root, ".env"), "TOKEN=OLD_SECRET\n", "utf8")
    await git(root, ["add", "src/app.ts", ".env"])
    await git(root, ["commit", "-m", "init"])

    await writeFile(join(root, "src", "app.ts"), "export const value = 2\n", "utf8")
    await writeFile(join(root, ".env"), "TOKEN=NEW_SECRET\n", "utf8")
    await writeFile(join(root, "staged.txt"), "staged\n", "utf8")
    await git(root, ["add", "staged.txt"])
    await writeFile(join(root, "untracked.txt"), "untracked\n", "utf8")

    let approvals = 0
    const runtime = await createRuntime(root, "workspace-write")
    const results = await runtime.runBatch(
      [call("c1", "git_feedback", {})],
      ctx({
        approvals: {
          async request() {
            approvals += 1
            return "deny"
          },
        },
      }),
    )

    const content = results[0]?.content ?? ""
    expect(results[0]).toMatchObject({ isError: false })
    expect(approvals).toBe(0)
    expect(content).toContain("Repository: yes")
    expect(content).toContain("HEAD:")
    expect(content).toContain("src/app.ts")
    expect(content).toContain("staged.txt")
    expect(content).toContain("untracked.txt")
    expect(content).toContain("[redacted: sensitive path patch omitted]")
    expect(content).toContain(".env")
    expect(content).not.toContain("NEW_SECRET")
    expect(content).toContain("+export const value = 2")
  })

  test("caps file lists and diff preview", async () => {
    const root = await createTempWorkspace()
    await initRepo(root)
    await writeFile(join(root, "big.txt"), "old\n", "utf8")
    await git(root, ["add", "big.txt"])
    await git(root, ["commit", "-m", "init"])
    await writeFile(join(root, "big.txt"), `${Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join("\n")}\n`, "utf8")
    for (let index = 0; index < 90; index++) {
      await writeFile(join(root, `untracked-${String(index).padStart(2, "0")}.txt`), "x\n", "utf8")
    }
    const runtime = await createRuntime(root, "read-only")

    const results = await runtime.runBatch([call("c1", "git_feedback", {})], ctx())

    const content = results[0]?.content ?? ""
    expect(content).toContain("[truncated: 10 additional files omitted]")
    expect(content).toContain("[truncated: diff preview capped at 24576 bytes]")
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(80_000)
  })

  test("redacts staged rename from sensitive path to non-sensitive path", async () => {
    const root = await createTempWorkspace()
    await initRepo(root)
    await writeFile(join(root, ".env"), "TOKEN=RENAMED_SECRET\n", "utf8")
    await git(root, ["add", ".env"])
    await git(root, ["commit", "-m", "init"])
    await git(root, ["mv", ".env", "public.txt"])
    const runtime = await createRuntime(root, "read-only")

    const results = await runtime.runBatch([call("c1", "git_feedback", {})], ctx())

    const content = results[0]?.content ?? ""
    expect(results[0]).toMatchObject({ isError: false })
    expect(content).toContain("public.txt")
    expect(content).toContain("[redacted: sensitive path patch omitted]")
    expect(content).not.toContain("RENAMED_SECRET")
  })
})

async function createRuntime(root: string, permissionMode: "read-only" | "workspace-write"): Promise<RealToolRuntime> {
  const workspace = await WorkspaceFs.create(root)
  return new RealToolRuntime({
    registry: createBuiltinToolRegistry(),
    workspace,
    permissionMode,
  })
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepId: "step1",
    signal: new AbortController().signal,
    ...extra,
  }
}

async function initRepo(root: string): Promise<void> {
  await git(root, ["init"])
  await git(root, ["config", "user.name", "Light CC Test"])
  await git(root, ["config", "user.email", "light-cc-test@example.invalid"])
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root })
}
