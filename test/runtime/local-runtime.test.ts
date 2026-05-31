import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { RuntimeExecutionError } from "../../src/runtime/types"
import { createTempWorkspace } from "../helpers"

describe("LocalRuntime", () => {
  test("captures stdout, stderr, exit code, and non-zero failures", async () => {
    const root = await createTempWorkspace()
    const runtime = await LocalRuntime.create({ workspaceRoot: root })

    const ok = await runtime.executeShell({ command: "echo hello", cwd: runtime.getCwd(), timeoutMs: 1000 })
    const err = await runtime.executeShell({
      command: "echo bad >&2; exit 7",
      cwd: runtime.getCwd(),
      timeoutMs: 1000,
    })

    expect(ok).toMatchObject({ exitCode: 0, timedOut: false })
    expect(ok.stdout).toContain("hello")
    expect(err.exitCode).toBe(7)
    expect(err.stderr).toContain("bad")
  })

  test("times out and kills child process groups", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "child-lived")
    const runtime = await LocalRuntime.create({ workspaceRoot: root, killGraceMs: 50 })

    const result = await runtime.executeShell({
      command: `bash -c 'sleep 1; touch ${JSON.stringify(marker)}' & wait`,
      cwd: runtime.getCwd(),
      timeoutMs: 80,
    })
    await sleep(1200)

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  test("abort kills the shell process group without reporting a timeout", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "abort-child-lived")
    const runtime = await LocalRuntime.create({ workspaceRoot: root, killGraceMs: 50 })
    const controller = new AbortController()

    const running = runtime.executeShell({
      command: `bash -c 'sleep 1; touch ${JSON.stringify(marker)}' & wait`,
      cwd: runtime.getCwd(),
      timeoutMs: 5000,
      signal: controller.signal,
    })
    await sleep(80)
    controller.abort("test abort")
    const result = await running
    await sleep(1200)

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.signal).toBe("SIGTERM")
    expect(existsSync(marker)).toBe(false)
  })

  test("pre-aborted shell signal does not run the command", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "pre-abort-ran")
    const runtime = await LocalRuntime.create({ workspaceRoot: root, killGraceMs: 50 })
    const controller = new AbortController()
    controller.abort("already aborted")

    const result = await runtime.executeShell({
      command: `touch ${JSON.stringify(marker)}`,
      cwd: runtime.getCwd(),
      timeoutMs: 1000,
      signal: controller.signal,
    })

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.signal).toBe("SIGTERM")
    expect(existsSync(marker)).toBe(false)
  })

  test("background child holding stdout does not hang completion", async () => {
    const root = await createTempWorkspace()
    const runtime = await LocalRuntime.create({ workspaceRoot: root })
    const started = Date.now()

    const result = await runtime.executeShell({
      command: "sleep 5 & echo done",
      cwd: runtime.getCwd(),
      timeoutMs: 2000,
    })

    expect(Date.now() - started).toBeLessThan(1000)
    expect(result.stdout).toContain("done")
    expect(result.exitCode).toBe(0)
  })

  test("background child is cleaned up even when parent exits immediately", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "detached-child-lived")
    const runtime = await LocalRuntime.create({ workspaceRoot: root, killGraceMs: 50 })

    const result = await runtime.executeShell({
      command: `bash -c 'sleep 1; touch ${JSON.stringify(marker)}' & echo parent-done`,
      cwd: runtime.getCwd(),
      timeoutMs: 2000,
    })
    await sleep(1200)

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain("parent-done")
    expect(existsSync(marker)).toBe(false)
  })

  test("truncates stdout and stderr with head and tail markers", async () => {
    const root = await createTempWorkspace()
    const runtime = await LocalRuntime.create({ workspaceRoot: root, maxStdoutBytes: 128, maxStderrBytes: 128 })

    const result = await runtime.executeShell({
      command: "yes out | head -c 4000; yes err | head -c 4000 >&2",
      cwd: runtime.getCwd(),
      timeoutMs: 1000,
    })

    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout).toContain("[truncated: kept head and tail of stdout")
    expect(result.stderr).toContain("[truncated: kept head and tail of stderr")
    expect(result.stdoutBytes).toBeGreaterThan(128)
    expect(result.stderrBytes).toBeGreaterThan(128)
  })

  test("stdout and stderr byte counts report original bytes when truncated", async () => {
    const root = await createTempWorkspace()
    const runtime = await LocalRuntime.create({ workspaceRoot: root, maxStdoutBytes: 32, maxStderrBytes: 32 })

    const result = await runtime.executeShell({
      command: "printf 'abcdefghij%.0s' {1..10}; printf 'klmnopqrst%.0s' {1..7} >&2",
      cwd: runtime.getCwd(),
      timeoutMs: 1000,
    })

    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdoutBytes).toBe(100)
    expect(result.stderrBytes).toBe(70)
    expect(result.stdout).toContain("original bytes=100")
    expect(result.stderr).toContain("original bytes=70")
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(32)
    expect(Buffer.byteLength(result.stderr)).toBeGreaterThan(32)
  })

  test("timeout result includes structured metadata and captured partial output", async () => {
    const root = await createTempWorkspace()
    const runtime = await LocalRuntime.create({ workspaceRoot: root, killGraceMs: 50 })
    const cwd = runtime.getCwd()

    const result = await runtime.executeShell({
      command: "printf before; sleep 5",
      cwd,
      timeoutMs: 80,
    })

    expect(result.command).toBe("printf before; sleep 5")
    expect(result.cwd).toBe(cwd)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(result.signal).toBe("SIGTERM")
    expect(result.stdout).toBe("before")
    expect(result.stderr).not.toContain("LIGHT_CC_CODER_CWD")
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(false)
    expect(result.stdoutBytes).toBe(6)
  })

  test("tracks cwd only when final cwd stays inside workspace", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "sub"))
    const runtime = await LocalRuntime.create({ workspaceRoot: root })

    const inside = await runtime.executeShell({ command: "cd sub && pwd", cwd: runtime.getCwd(), timeoutMs: 1000 })
    const afterInside = runtime.getCwd()
    const outside = await runtime.executeShell({ command: "cd /tmp && pwd", cwd: runtime.getCwd(), timeoutMs: 1000 })

    expect(inside.finalCwd).toBe(join(root, "sub"))
    expect(afterInside).toBe(join(root, "sub"))
    expect(outside.finalCwd).toBe("/tmp")
    expect(runtime.getCwd()).toBe(afterInside)
  })

  test("outside final cwd does not affect the starting cwd of the next command", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "sub"))
    const runtime = await LocalRuntime.create({ workspaceRoot: root })

    const inside = await runtime.executeShell({ command: "cd sub", cwd: runtime.getCwd(), timeoutMs: 1000 })
    const outside = await runtime.executeShell({ command: "cd /tmp", cwd: runtime.getCwd(), timeoutMs: 1000 })
    const after = await runtime.executeShell({ command: "pwd -P", cwd: runtime.getCwd(), timeoutMs: 1000 })

    expect(inside.finalCwd).toBe(join(root, "sub"))
    expect(outside.finalCwd).toBe("/tmp")
    expect(runtime.getCwd()).toBe(join(root, "sub"))
    expect(after.cwd).toBe(join(root, "sub"))
    expect(after.stdout.trim()).toBe(join(root, "sub"))
  })

  test("denies cwd outside workspace before spawn", async () => {
    const root = await createTempWorkspace()
    const outside = await createTempWorkspace("light-cc-outside-")
    const marker = join(outside, "spawned")
    const runtime = await LocalRuntime.create({ workspaceRoot: root })

    await expect(
      runtime.executeShell({ command: `echo no > ${JSON.stringify(marker)}`, cwd: outside, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(RuntimeExecutionError)
    expect(existsSync(marker)).toBe(false)
  })

  test("uses bounded runtime env without model-provided env", async () => {
    const root = await createTempWorkspace()
    const runtime = await LocalRuntime.create({ workspaceRoot: root })
    await writeFile(join(root, "env-name"), "SHOULD_NOT_EXIST", "utf8")

    const result = await runtime.executeShell({
      command: 'echo "$LIGHT_CC_CODER:$NO_COLOR:${SHOULD_NOT_EXIST-unset}"',
      cwd: runtime.getCwd(),
      timeoutMs: 1000,
    })

    expect(result.stdout.trim()).toBe("1:1:unset")
    expect(await readFile(join(root, "env-name"), "utf8")).toBe("SHOULD_NOT_EXIST")
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
