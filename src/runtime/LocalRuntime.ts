import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { Readable } from "node:stream"
import { RuntimeExecutionError, type ExecuteShellInput, type ExecuteShellResult, type Runtime } from "./types"

export type LocalRuntimeOptions = {
  workspaceRoot: string
  initialCwd?: string
  maxStdoutBytes?: number
  maxStderrBytes?: number
  killGraceMs?: number
}

const defaultStreamLimit = 32 * 1024

export class LocalRuntime implements Runtime {
  readonly workspaceRoot: string
  private cwd: string
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number
  private readonly killGraceMs: number

  private constructor(options: {
    workspaceRoot: string
    cwd: string
    maxStdoutBytes: number
    maxStderrBytes: number
    killGraceMs: number
  }) {
    this.workspaceRoot = options.workspaceRoot
    this.cwd = options.cwd
    this.maxStdoutBytes = options.maxStdoutBytes
    this.maxStderrBytes = options.maxStderrBytes
    this.killGraceMs = options.killGraceMs
  }

  static async create(options: LocalRuntimeOptions): Promise<LocalRuntime> {
    const workspaceRoot = await realpath(resolve(options.workspaceRoot))
    const initial = await realpath(resolve(options.initialCwd ?? workspaceRoot))
    assertContained(workspaceRoot, initial, options.initialCwd ?? workspaceRoot)
    return new LocalRuntime({
      workspaceRoot,
      cwd: initial,
      maxStdoutBytes: options.maxStdoutBytes ?? defaultStreamLimit,
      maxStderrBytes: options.maxStderrBytes ?? defaultStreamLimit,
      killGraceMs: options.killGraceMs ?? 150,
    })
  }

  getCwd(): string {
    return this.cwd
  }

  async executeShell(input: ExecuteShellInput): Promise<ExecuteShellResult> {
    const start = performance.now()
    const cwd = await this.resolveCwd(input.cwd)
    const stdout = new HeadTailBuffer(this.maxStdoutBytes)
    const stderr = new HeadTailBuffer(this.maxStderrBytes)
    const token = `LIGHT_CC_CODER_CWD_${randomUUID().replaceAll("-", "")}`
    const script = [
      "exec 3>&2",
      `trap 'status=$?; printf "\\n__${token}__%s\\n" "$(pwd -P)" >&3' EXIT`,
      'eval "$1"',
    ].join("; ")

    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn("bash", ["-lc", script, "light-cc-coder", input.command], {
        cwd,
        detached: true,
        env: buildRuntimeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      throw new RuntimeExecutionError("runtime_error", "Failed to start shell", input.command, error)
    }

    child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk))
    child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk))

    let timeout: ReturnType<typeof setTimeout> | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let aborted = false
    let settled = false

    const cleanupTimers = () => {
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
    }

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // Process may already be gone.
        }
      }
    }

    const scheduleKill = (reason: "timeout" | "abort") => {
      if (settled) return
      if (reason === "timeout") timedOut = true
      if (reason === "abort") aborted = true
      killGroup("SIGTERM")
      forceKill = setTimeout(() => killGroup("SIGKILL"), this.killGraceMs)
    }

    const onAbort = () => scheduleKill("abort")
    input.signal?.addEventListener("abort", onAbort, { once: true })
    timeout = setTimeout(() => scheduleKill("timeout"), input.timeoutMs)

    return await new Promise<ExecuteShellResult>((resolveResult) => {
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null

      child.on("error", (error) => {
        if (settled) return
        settled = true
        cleanupTimers()
        input.signal?.removeEventListener("abort", onAbort)
        resolveResult({
          command: input.command,
          cwd,
          exitCode: null,
          signal: null,
          timedOut,
          durationMs: Math.round(performance.now() - start),
          stdout: stdout.text("stdout"),
          stderr: `Failed to run shell: ${error.message}`,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: false,
          stdoutBytes: stdout.totalBytes,
          stderrBytes: Buffer.byteLength(error.message),
        })
      })

      child.on("exit", (code, signal) => {
        exitCode = code
        exitSignal = signal
        killGroup("SIGTERM")
        setTimeout(finish, 10)
      })

      const finish = () => {
        if (settled) return
        settled = true
        cleanupTimers()
        input.signal?.removeEventListener("abort", onAbort)
        child.stdout.destroy()
        child.stderr.destroy()
        const stderrText = stderr.text("stderr")
        const parsed = stripFinalCwd(stderrText, token)
        const finalCwd = parsed.finalCwd
        if (finalCwd && isContained(this.workspaceRoot, finalCwd)) {
          this.cwd = finalCwd
        }
        resolveResult({
          command: input.command,
          cwd,
          finalCwd,
          exitCode,
          signal: aborted ? "SIGTERM" : exitSignal,
          timedOut,
          durationMs: Math.round(performance.now() - start),
          stdout: stdout.text("stdout"),
          stderr: parsed.stderr,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          stdoutBytes: stdout.totalBytes,
          stderrBytes: stderr.totalBytes,
        })
      }
    })
  }

  private async resolveCwd(cwd: string): Promise<string> {
    const absolute = isAbsolute(cwd) ? resolve(cwd) : resolve(this.workspaceRoot, cwd)
    let resolved: string
    try {
      resolved = await realpath(absolute)
    } catch (error) {
      throw new RuntimeExecutionError("sandbox_denied", "Shell cwd does not exist", cwd, error)
    }
    assertContained(this.workspaceRoot, resolved, cwd)
    return resolved
  }

  async close(): Promise<void> {
    // LocalRuntime currently owns no long-lived process between commands.
  }
}

function assertContained(root: string, pathToCheck: string, subject: string): void {
  if (isContained(root, pathToCheck)) return
  throw new RuntimeExecutionError("sandbox_denied", "Shell cwd is outside the workspace", subject)
}

function isContained(root: string, pathToCheck: string): boolean {
  const rel = relative(root, pathToCheck)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function buildRuntimeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "TMPDIR", "TERM"]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.GIT_EDITOR = "true"
  env.NO_COLOR = "1"
  env.LIGHT_CC_CODER = "1"
  return env
}

function stripFinalCwd(stderr: string, token: string): { stderr: string; finalCwd?: string } {
  const marker = `__${token}__`
  const lines = stderr.split(/\r?\n/)
  let finalCwd: string | undefined
  const kept: string[] = []
  for (const line of lines) {
    if (line.startsWith(marker)) {
      finalCwd = line.slice(marker.length)
      continue
    }
    kept.push(line)
  }
  return { stderr: kept.join("\n").replace(/\n$/, ""), finalCwd }
}

class HeadTailBuffer {
  readonly maxBytes: number
  totalBytes = 0
  truncated = false
  private chunks: Buffer[] = []
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += buffer.byteLength
    if (!this.truncated) {
      this.chunks.push(buffer)
      const current = Buffer.concat(this.chunks)
      if (current.byteLength <= this.maxBytes) return
      this.truncated = true
      const headLimit = Math.floor(this.maxBytes / 2)
      const tailLimit = this.maxBytes - headLimit
      this.head = current.subarray(0, headLimit)
      this.tail = current.subarray(Math.max(0, current.byteLength - tailLimit))
      this.chunks = []
      return
    }

    const tailLimit = this.maxBytes - Math.floor(this.maxBytes / 2)
    const nextTail = Buffer.concat([this.tail, buffer])
    this.tail = nextTail.subarray(Math.max(0, nextTail.byteLength - tailLimit))
  }

  text(streamName: string): string {
    if (!this.truncated) return Buffer.concat(this.chunks).toString("utf8")
    return `${this.head.toString("utf8")}\n[truncated: kept head and tail of ${streamName}, original bytes=${this.totalBytes}]\n${this.tail.toString("utf8")}`
  }
}
