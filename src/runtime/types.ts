export type ExecuteShellInput = {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

export type ExecuteShellResult = {
  command: string
  cwd: string
  finalCwd?: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutBytes: number
  stderrBytes: number
}

export type RuntimeErrorKind = "sandbox_denied" | "sandbox_unavailable" | "runtime_error" | "aborted"

export class RuntimeExecutionError extends Error {
  constructor(
    readonly kind: RuntimeErrorKind,
    message: string,
    readonly subject?: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "RuntimeExecutionError"
  }
}

export interface Runtime {
  getCwd(): string
  executeShell(input: ExecuteShellInput): Promise<ExecuteShellResult>
  close?(): Promise<void>
}
