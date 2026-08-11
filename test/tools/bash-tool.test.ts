import { describe, expect, test } from "bun:test"
import type { ExecuteShellInput, ExecuteShellResult, Runtime } from "../../src/runtime/types"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createTempWorkspace } from "../helpers"

describe("bash tool", () => {
  test("stops retrying after sandbox capability failures in the same runtime", async () => {
    const root = await createTempWorkspace()
    const shellRuntime = new SandboxFailingRuntime(root)
    const runtime = new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace: await WorkspaceFs.create(root),
      runtime: shellRuntime,
      permissionMode: "danger-full-access",
    })

    const first = await runtime.runBatch([call("c1", "bash", { command: "python -c 'print(1)'" })], ctx())
    const second = await runtime.runBatch([call("c2", "bash", { command: "git diff" })], ctx())

    expect(first[0]).toMatchObject({ isError: true })
    expect(first[0]?.content).toContain("apply-seccomp")
    expect(second[0]).toMatchObject({ isError: true })
    expect(second[0]?.content).toContain("Bash unavailable")
    expect(second[0]?.content.length).toBeLessThan(120)
    expect(second[0]?.content).not.toContain("apply-seccomp")
    expect(shellRuntime.calls).toBe(1)
  })
})

class SandboxFailingRuntime implements Runtime {
  calls = 0

  constructor(private readonly root: string) {}

  getCwd(): string {
    return this.root
  }

  async executeShell(input: ExecuteShellInput): Promise<ExecuteShellResult> {
    this.calls += 1
    const stderr =
      "apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied"
    return {
      command: input.command,
      cwd: input.cwd,
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 5,
      stdout: "",
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutBytes: 0,
      stderrBytes: stderr.length,
    }
  }
}

function ctx(): ToolContext {
  return { sessionId: "s1", turnId: "t1", stepId: "step1", signal: new AbortController().signal }
}
