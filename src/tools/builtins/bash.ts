import { RuntimeExecutionError, type ExecuteShellResult, type Runtime } from "../../runtime/types"
import type { SessionEventDraft } from "../../core/events"
import { drainSandboxRuntimeDiagnostics } from "../../runtime/sandbox/createRuntime"
import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, expectString, optionalInteger, optionalString } from "./util"

type BashInput = {
  command: string
  timeoutMs: number
  description?: string
}

const defaultTimeoutMs = 120_000
const maxTimeoutMs = 600_000
const sandboxCapabilityFailures = new WeakMap<Runtime, string>()
const sandboxCapabilityFailurePattern = /apply-seccomp|setgroups|nested userns|CAP_SYS_ADMIN/i

export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description:
    "Run at most one targeted shell command for clearly relevant verification, preferably after an edit. Use workspace-relative commands from the current workspace. If sandbox/userns capability errors appear, bash is unavailable for the rest of the task; do not retry equivalent commands.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeoutMs: {
        type: "number",
        description: "Timeout in milliseconds. Defaults to 120000 and is capped at 600000.",
        default: defaultTimeoutMs,
      },
      description: { type: "string", description: "Short reason for running the command." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "bash")
    const command = expectString(object, "command")
    if (command.trim().length === 0) {
      throw new ToolExecutionError("invalid_input", "command must not be empty")
    }
    return {
      command,
      timeoutMs: optionalInteger(object, "timeoutMs", defaultTimeoutMs, { min: 1, max: maxTimeoutMs }),
      description: optionalString(object, "description"),
    }
  },
  accesses(input) {
    return { searches: [input.command] }
  },
  async execute(input, ctx) {
    const runtime = ctx.runtime
    if (!runtime) {
      throw new RuntimeExecutionError("runtime_error", "bash requires a runtime", input.command)
    }
    const previousSandboxFailure = sandboxCapabilityFailures.get(runtime)
    if (previousSandboxFailure) {
      return {
        content: "Bash unavailable after sandbox/userns failure. Do not call bash again; use read, grep, edit, or final.",
        isError: true,
        preserveErrorContent: true,
      }
    }
    const result = await runtime.executeShell({
      command: input.command,
      cwd: runtime.getCwd(),
      timeoutMs: input.timeoutMs,
      signal: ctx.signal,
    })
    const sandboxFailure = detectSandboxCapabilityFailure(result)
    if (sandboxFailure) sandboxCapabilityFailures.set(runtime, sandboxFailure)
    const postResultDiagnostics: SessionEventDraft[] = [
      ...drainSandboxRuntimeDiagnostics(runtime).map((diagnostic) => ({
        ...diagnostic,
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        toolCallId: ctx.toolCallId ?? "",
      })),
      {
        type: "bash.observation",
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        toolCallId: ctx.toolCallId ?? "",
        command: result.command,
        cwd: result.cwd,
        description: input.description,
        finalCwd: result.finalCwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      },
    ]
    if (isLikelyVerification(input.command, input.description)) {
      postResultDiagnostics.push({
        type: "verification.observed",
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        toolCallId: ctx.toolCallId ?? "",
        command: result.command,
        cwd: result.cwd,
        description: input.description,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        status: verificationStatus(result),
        output: {
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        },
      })
    }
    const content = formatBashResult(result)
    return {
      content,
      isError: result.timedOut || result.exitCode !== 0,
      preserveErrorContent: true,
      postResultDiagnostics,
    }
  },
}

function detectSandboxCapabilityFailure(result: ExecuteShellResult): string | undefined {
  const text = `${result.stdout}\n${result.stderr}`
  if (!sandboxCapabilityFailurePattern.test(text)) return undefined
  const line = text
    .split(/\r?\n/)
    .find((candidate) => sandboxCapabilityFailurePattern.test(candidate))
    ?.trim()
  return line ? line.slice(0, 240) : "sandbox/userns capability error"
}

function formatBashResult(result: ExecuteShellResult): string {
  return [
    `Command: ${result.command}`,
    `Cwd: ${result.cwd}`,
    result.finalCwd ? `Final cwd: ${result.finalCwd}` : undefined,
    `Exit code: ${result.exitCode === null ? "null" : result.exitCode}`,
    `Timed out: ${result.timedOut ? "true" : "false"}`,
    "",
    "Stdout:",
    result.stdout.length > 0 ? result.stdout : "(empty)",
    "",
    "Stderr:",
    result.stderr.length > 0 ? result.stderr : "(empty)",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function isLikelyVerification(command: string, description: string | undefined): boolean {
  const text = `${description ?? ""}\n${command}`.toLowerCase()
  return /\b(test|tests|typecheck|lint|verify|verification|check|ci|bun run test|bun run typecheck|npm test|pnpm test|yarn test|pytest|cargo test|go test|tsc|eslint)\b/.test(
    text,
  )
}

function verificationStatus(result: ExecuteShellResult): "passed" | "failed" | "timed_out" | "unknown" {
  if (result.timedOut) return "timed_out"
  if (result.exitCode === 0) return "passed"
  if (typeof result.exitCode === "number") return "failed"
  return "unknown"
}
