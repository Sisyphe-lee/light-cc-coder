import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { EventRenderer } from "../../src/cli/eventRenderer"
import { replayProviderMessages } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import {
  createLocalRuntimeWithOptionalSandbox,
  drainSandboxRuntimeDiagnostics,
  type SandboxRuntimeModule,
  type SandboxRuntimeLoader,
} from "../../src/runtime/sandbox/createRuntime"
import { inspectSandboxRuntimeAvailability } from "../../src/runtime/sandbox/availability"
import { RuntimeExecutionError, type Runtime } from "../../src/runtime/types"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace, MemoryTranscriptSink } from "../helpers"

describe("Phase 9 optional OS sandbox runtime", () => {
  test("off does not load sandbox-runtime and still uses LocalRuntime", async () => {
    const root = await createTempWorkspace()
    let loaded = false
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "off" },
      loader: () => {
        loaded = true
        return { ok: false, reason: "should not load" }
      },
    })

    const result = await runtime.executeShell({ command: "echo local-ok", cwd: runtime.getCwd(), timeoutMs: 1000 })

    expect(loaded).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("local-ok")
  })

  test("auto falls back when sandbox-runtime is unavailable and emits replay-invisible status", async () => {
    const root = await createTempWorkspace()
    const transcript = new MemoryTranscriptSink()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "auto" },
      loader: unavailableLoader("package missing"),
    })
    const session = await createBashSession({ root, runtime, transcript, command: "echo fallback-ok" })

    await session.submit({ type: "user_message", content: "run" })
    await session.close()

    const events = transcript.events as SessionEvent[]
    const status = events.find((event) => event.type === "sandbox.status")
    expect(status).toMatchObject({ type: "sandbox.status", active: false, requestedMode: "auto" })
    expect(JSON.stringify(replayProviderMessages(events))).not.toContain("sandbox.status")
    expect(onlyToolResult(events).result.content).toContain("fallback-ok")
  })

  test("event renderer warns once when auto fallback leaves a write-capable session unsandboxed", async () => {
    const root = await createTempWorkspace()
    const transcript = new MemoryTranscriptSink()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "auto" },
      loader: unavailableLoader("package missing"),
    })
    const session = await createBashSession({ root, runtime, transcript, command: "echo fallback-warning" })
    const stdout = new CaptureStream()
    const stderr = new CaptureStream()
    const renderer = new EventRenderer({
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      permissionMode: "workspace-write",
    })
    const consume = renderer.consume(session)

    await session.submit({ type: "user_message", content: "run" })
    await session.close()
    await consume

    expect(stderr.text.match(/OS sandbox auto fallback/g)).toHaveLength(1)
    expect(stderr.text).toContain("Use --os-sandbox required")
  })

  test("auto is the default sandbox mode", async () => {
    const root = await createTempWorkspace()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      loader: unavailableLoader("package missing"),
    })

    const result = await runtime.executeShell({ command: "echo default-auto", cwd: runtime.getCwd(), timeoutMs: 1000 })

    expect(result.stdout).toContain("default-auto")
    const status = drainSandboxRuntimeDiagnostics(runtime)[0]
    expect(status).toMatchObject({ type: "sandbox.status", active: false, requestedMode: "auto" })
  })

  test("auto does not load or initialize sandbox-runtime until bash execution", async () => {
    const root = await createTempWorkspace()
    let loaded = false
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      loader: () => {
        loaded = true
        return availableSandboxRuntime().loader()
      },
    })

    expect(loaded).toBe(false)
    expect(drainSandboxRuntimeDiagnostics(runtime)).toEqual([])
    await runtime.close?.()
    expect(loaded).toBe(false)
  })

  test("required unavailable returns one paired sandbox_unavailable result and does not spawn", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "should-not-run")
    const transcript = new MemoryTranscriptSink()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required" },
      loader: unavailableLoader("package missing"),
    })
    const session = await createBashSession({ root, runtime, transcript, command: `touch ${JSON.stringify(marker)}` })

    await session.submit({ type: "user_message", content: "run" })
    await session.close()

    const events = transcript.events as SessionEvent[]
    const toolResults = events.filter((event) => event.type === "tool.result")
    expect(toolResults).toHaveLength(1)
    expect(onlyToolResult(events).result.content).toContain("sandbox_unavailable")
    expect(events.find((event) => event.type === "sandbox.status")).toMatchObject({
      type: "sandbox.status",
      active: false,
      requestedMode: "required",
      fallbackReason: "package missing",
    })
    expect(JSON.stringify(replayProviderMessages(events))).not.toContain("sandbox.status")
    expect(events.some((event) => event.type === "bash.observation")).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(replayProviderMessages(events).filter((message) => message.role === "tool")).toHaveLength(1)
  })

  test("wrap failure returns paired sandbox_unavailable and still emits sandbox status", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "wrap-failure-should-not-run")
    const transcript = new MemoryTranscriptSink()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required" },
      loader: () => ({
        ok: true,
        module: {
          SandboxManager: {
            initialize() {},
            isSupportedPlatform: () => true,
            checkDependencies: () => ({ errors: [], warnings: [] }),
            wrapWithSandbox() {
              throw new Error("wrapper exploded")
            },
          },
        },
      }),
    })
    const session = await createBashSession({ root, runtime, transcript, command: `touch ${JSON.stringify(marker)}` })

    await session.submit({ type: "user_message", content: "run" })
    await session.close()

    const events = transcript.events as SessionEvent[]
    expect(onlyToolResult(events).result.content).toContain("sandbox_unavailable")
    expect(events.find((event) => event.type === "sandbox.status")).toMatchObject({
      type: "sandbox.status",
      active: true,
      requestedMode: "required",
    })
    expect(events.some((event) => event.type === "bash.observation")).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  test("active adapter uses SandboxManager.wrapWithSandbox and keeps cwd tracking outside LocalRuntime", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "sub"))
    const fake = availableSandboxRuntime()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required" },
      loader: fake.loader,
    })

    const result = await runtime.executeShell({ command: "cd sub && pwd -P", cwd: runtime.getCwd(), timeoutMs: 1000 })

    expect(fake.initializeCalls()).toBe(1)
    expect(fake.wrapCalls()).toBe(1)
    expect(result.command).toBe("cd sub && pwd -P")
    expect(result.finalCwd).toBe(join(root, "sub"))
    expect(runtime.getCwd()).toBe(join(root, "sub"))
  })

  test("session close resets an active sandbox runtime", async () => {
    const root = await createTempWorkspace()
    const transcript = new MemoryTranscriptSink()
    const fake = availableSandboxRuntime()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required" },
      loader: fake.loader,
    })
    const session = await createBashSession({ root, runtime, transcript, command: "echo close-ok" })

    await session.submit({ type: "user_message", content: "run" })
    await session.close()

    expect(fake.initializeCalls()).toBe(1)
    expect(fake.resetCalls()).toBe(1)
  })

  test("permission denial and shell hard denylist happen before sandbox wrapping", async () => {
    const root = await createTempWorkspace()
    const fake = availableSandboxRuntime()
    const workspace = await WorkspaceFs.create(root)
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: workspace.root,
      sandbox: { mode: "required" },
      loader: fake.loader,
    })

    const readOnly = new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace,
      runtime,
      permissionMode: "read-only",
    })
    const readOnlyResult = await readOnly.runBatch([call("c1", "bash", { command: "echo denied" })], ctx())

    const danger = new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace,
      runtime,
      permissionMode: "danger-full-access",
    })
    const hardDenied = await danger.runBatch([call("c2", "bash", { command: "git push origin main" })], ctx())

    expect(readOnlyResult[0]?.content).toContain("Bash is denied in read-only mode")
    expect(hardDenied[0]?.content).toContain("Mutating git command is denied")
    expect(fake.wrapCalls()).toBe(0)
  })

  test("sandbox denied during wrapping is not retried without sandbox", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "should-not-fallback")
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "auto" },
      loader: () => ({
        ok: true,
        module: {
          SandboxManager: {
            initialize() {},
            isSupportedPlatform: () => true,
            checkDependencies: () => ({ errors: [], warnings: [] }),
            wrapWithSandbox(command: string) {
              throw new RuntimeExecutionError("sandbox_denied", "Denied by fake sandbox", command)
            },
          },
        },
      }),
    })

    await expect(
      runtime.executeShell({ command: `touch ${JSON.stringify(marker)}`, cwd: runtime.getCwd(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ kind: "sandbox_denied" })
    expect(existsSync(marker)).toBe(false)
  })

  test("auto falls back when dependency checks throw or optional method shapes are invalid", async () => {
    const root = await createTempWorkspace()
    const throwing = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "auto" },
      loader: () => ({
        ok: true,
        module: {
          SandboxManager: {
            initialize() {},
            isSupportedPlatform: () => true,
            checkDependencies() {
              throw new Error("dependency probe failed")
            },
            wrapWithSandbox(command: string) {
              return command
            },
          },
        },
      }),
    })
    const result = await throwing.runtime.executeShell({ command: "echo fallback-after-probe", cwd: root, timeoutMs: 1000 })
    expect(result.stdout).toContain("fallback-after-probe")
    expect(drainSandboxRuntimeDiagnostics(throwing.runtime)[0]).toMatchObject({
      type: "sandbox.status",
      active: false,
      requestedMode: "auto",
      fallbackReason: "dependency probe failed",
    })

    const invalidShape = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "auto" },
      loader: () => ({
        ok: true,
        module: {
          SandboxManager: {
            initialize() {},
            checkDependencies: "bad",
            wrapWithSandbox(command: string) {
              return command
            },
          },
        } as unknown as SandboxRuntimeModule,
      }),
    })
    const fallback = await invalidShape.runtime.executeShell({ command: "echo fallback-after-shape", cwd: root, timeoutMs: 1000 })
    expect(fallback.stdout).toContain("fallback-after-shape")
    expect(drainSandboxRuntimeDiagnostics(invalidShape.runtime)[0]?.fallbackReason).toContain("module shape")
  })

  test("invalid explicit settings fail closed before loading or spawning", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "invalid-settings-should-not-run")
    let loaded = false
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "auto", settingsPath: join(root, "missing-sandbox-settings.json") },
      loader: () => {
        loaded = true
        return availableSandboxRuntime().loader()
      },
    })

    await expect(
      runtime.executeShell({ command: `touch ${JSON.stringify(marker)}`, cwd: runtime.getCwd(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ kind: "sandbox_unavailable" })
    expect(loaded).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  test("explicit settings must be a JSON object even without external schema", async () => {
    const root = await createTempWorkspace()
    const settings = join(root, "sandbox.json")
    const marker = join(root, "primitive-settings-should-not-run")
    await writeFile(settings, "42\n", "utf8")
    let initialized = false
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required", settingsPath: settings },
      loader: () => ({
        ok: true,
        module: {
          SandboxManager: {
            initialize() {
              initialized = true
            },
            wrapWithSandbox(command: string) {
              return command
            },
          },
        },
      }),
    })

    await expect(
      runtime.executeShell({ command: `touch ${JSON.stringify(marker)}`, cwd: runtime.getCwd(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ kind: "sandbox_unavailable" })
    expect(initialized).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  test("non-string wrapped command fails before local spawn", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "non-string-wrapper-should-not-run")
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required" },
      loader: () => ({
        ok: true,
        module: {
          SandboxManager: {
            initialize() {},
            wrapWithSandbox() {
              return { command: `touch ${marker}` } as unknown as string
            },
          },
        },
      }),
    })

    await expect(
      runtime.executeShell({ command: `touch ${JSON.stringify(marker)}`, cwd: runtime.getCwd(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ kind: "sandbox_unavailable" })
    expect(existsSync(marker)).toBe(false)
  })

  test("CLI config defaults sandbox mode to auto and accepts explicit sandbox flags", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const settings = join(root, "sandbox.json")
    const result = await runCli(
      [
        "--dry-run",
        "-p",
        "hello",
        "--fake",
        "--cwd",
        root,
        "--os-sandbox",
        "auto",
        "--sandbox-settings",
        settings,
        "--sandbox-allow-domain",
        "example.com",
        "--sandbox-allow-write",
        join(root, "tmp"),
      ],
      cleanEnv({ LIGHTCC_HOME: dataRoot }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("osSandbox: auto (cli:--os-sandbox)")
    expect(result.stdout).toContain(`sandboxSettings: ${settings} (cli:--sandbox-settings)`)
    expect(result.stdout).toContain("sandboxAllowDomains: example.com (cli:--sandbox-allow-domain)")
    expect(result.stdout).toContain(`sandboxAllowWrites: ${join(root, "tmp")} (cli:--sandbox-allow-write)`)

    const defaultResult = await runCli(["--dry-run", "-p", "hello", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))
    expect(defaultResult.exitCode).toBe(0)
    expect(defaultResult.stdout).toContain("osSandbox: auto (default)")
  })

  test("doctor --sandbox reports focused sandbox readiness and supports JSON", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")

    const result = await runCli(["doctor", "--sandbox", "--json", "--cwd", root, "--os-sandbox", "off"], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as { status: string; checks: Array<{ name: string; message: string }> }
    expect(parsed.status).toBe("ready")
    expect(parsed.checks.some((check) => check.name === "sandbox.mode" && check.message.includes("off"))).toBe(true)
    expect(parsed.checks.some((check) => check.name === "sandbox.effective" && check.message.includes("LocalRuntime"))).toBe(true)
    expect(parsed.checks.some((check) => check.name === "sandbox.bwrap" || check.name === "sandbox.srtCli")).toBe(false)
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
  })

  test("doctor --sandbox fails closed for required mode with invalid explicit settings", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")

    const result = await runCli(
      ["doctor", "--sandbox", "--cwd", root, "--os-sandbox", "required", "--sandbox-settings", join(root, "missing.json")],
      cleanEnv({ LIGHTCC_HOME: dataRoot }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("blocked")
    expect(result.stdout).toContain("sandbox.settings")
    expect(result.stdout).toContain("failed to read sandbox settings")
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
  })

  test("gated real backend E2E blocks HOME write, allows workspace write, and emits active status", async () => {
    const root = await createTempWorkspace()
    const report = await inspectSandboxRuntimeAvailability({ workspaceRoot: root, sandbox: { mode: "required" } })
    if (!report.available) {
      console.warn(`Skipping real sandbox E2E: ${report.fallbackReason ?? "backend unavailable"}`)
      return
    }

    const homeMarker = join(homedir(), `lightcc-sandbox-e2e-${Date.now()}`)
    await rm(homeMarker, { force: true })
    const transcript = new MemoryTranscriptSink()
    const { runtime } = await createLocalRuntimeWithOptionalSandbox({
      workspaceRoot: root,
      sandbox: { mode: "required" },
    })
    const command = [
      "printf workspace-ok > sandbox-e2e-workspace.txt",
      `if printf home-bad > ${shellQuote(homeMarker)}; then echo HOME_WRITE_ALLOWED; else echo HOME_WRITE_DENIED; fi`,
      "cat sandbox-e2e-workspace.txt",
    ].join("; ")
    const session = await createBashSession({ root, runtime, transcript, command })

    try {
      await session.submit({ type: "user_message", content: "run" })
      await session.close()
    } finally {
      await rm(homeMarker, { force: true })
    }

    const events = transcript.events as SessionEvent[]
    expect(events.find((event) => event.type === "sandbox.status")).toMatchObject({
      type: "sandbox.status",
      requestedMode: "required",
      active: true,
    })
    const result = onlyToolResult(events).result.content
    const stdout = stdoutSection(result)
    expect(stdout).toContain("HOME_WRITE_DENIED")
    expect(stdout).not.toContain("HOME_WRITE_ALLOWED")
    expect(await readFile(join(root, "sandbox-e2e-workspace.txt"), "utf8")).toBe("workspace-ok")
    expect(existsSync(homeMarker)).toBe(false)
  })
})

async function createBashSession(input: {
  root: string
  runtime: Runtime
  transcript: MemoryTranscriptSink
  command: string
}): Promise<AgentSession> {
  const workspace = await WorkspaceFs.create(input.root)
  return AgentSession.create({
    cwd: workspace.root,
    provider: new FakeProvider({
      steps: [
        { message: assistant("a1", "run", [call("c1", "bash", { command: input.command })]) },
        { message: assistant("a2", "done") },
      ],
    }),
    toolRuntime: new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace,
      runtime: input.runtime,
      permissionMode: "danger-full-access",
    }),
    transcript: input.transcript,
    maxSteps: 5,
  })
}

function unavailableLoader(reason: string): SandboxRuntimeLoader {
  return () => ({ ok: false, reason })
}

function availableSandboxRuntime(): {
  loader: SandboxRuntimeLoader
  initializeCalls: () => number
  wrapCalls: () => number
  resetCalls: () => number
} {
  let initializes = 0
  let wraps = 0
  let resets = 0
  return {
    loader: () => ({
      ok: true,
      module: {
        SandboxRuntimeConfigSchema: {
          safeParse(value: unknown) {
            return { success: true, data: value }
          },
        },
        SandboxManager: {
          initialize() {
            initializes += 1
          },
          isSupportedPlatform: () => true,
          checkDependencies: () => ({ errors: [], warnings: [] }),
          wrapWithSandbox(command: string) {
            wraps += 1
            return `bash -lc ${shellQuote(command)}`
          },
          cleanupAfterCommand() {},
          reset() {
            resets += 1
          },
        },
      },
    }),
    initializeCalls: () => initializes,
    wrapCalls: () => wraps,
    resetCalls: () => resets,
  }
}

function onlyToolResult(events: SessionEvent[]): Extract<SessionEvent, { type: "tool.result" }> {
  const results = events.filter((event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result")
  expect(results).toHaveLength(1)
  return results[0]
}

function stdoutSection(toolResult: string): string {
  const match = /\nStdout:\n([\s\S]*?)\n\nStderr:\n/.exec(toolResult)
  return match?.[1] ?? toolResult
}

function ctx(): ToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepId: "step1",
    signal: new AbortController().signal,
  }
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function cleanEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    PATH: `/home/cyli/.bun/bin:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    NO_PROXY: "127.0.0.1,localhost",
    OPENAI_BASE_URL: undefined,
    OPENAI_MODEL: undefined,
    OPENAI_API_KEY: undefined,
    LIGHT_CC_BASE_URL: undefined,
    LIGHT_CC_MODEL: undefined,
    LIGHT_CC_API_KEY_ENV: undefined,
    LIGHT_CC_PERMISSION_MODE: undefined,
    LIGHT_CC_OS_SANDBOX: undefined,
    LIGHT_CC_SANDBOX_SETTINGS: undefined,
    LIGHT_CC_SANDBOX_ALLOW_DOMAINS: undefined,
    LIGHT_CC_SANDBOX_ALLOW_WRITES: undefined,
    LIGHT_CC_TRANSCRIPT: undefined,
    LIGHT_CC_MAX_STEPS: undefined,
    LIGHT_CC_MAX_CONTEXT_TOKENS: undefined,
    LIGHT_CC_COMPACT_THRESHOLD: undefined,
    LIGHT_CC_MCP_CONFIG: undefined,
    LIGHT_CC_SKILLS: undefined,
    ...extra,
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

class CaptureStream {
  text = ""
  isTTY = false

  write(chunk: string | Uint8Array): boolean {
    this.text += String(chunk)
    return true
  }
}
