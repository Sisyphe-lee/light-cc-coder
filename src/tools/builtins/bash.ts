import { RuntimeExecutionError, type ExecuteShellResult } from "../../runtime/types"
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

export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description: "Run a shell command in the workspace. Commands are permissioned, timed out, and output-capped.",
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
    if (!ctx.runtime) {
      throw new RuntimeExecutionError("runtime_error", "bash requires a runtime", input.command)
    }
    const result = await ctx.runtime.executeShell({
      command: input.command,
      cwd: ctx.runtime.getCwd(),
      timeoutMs: input.timeoutMs,
      signal: ctx.signal,
    })
    await ctx.emit?.({
      type: "bash.observation",
      turnId: ctx.turnId,
      stepId: ctx.stepId,
      toolCallId: ctx.toolCallId ?? "",
      command: result.command,
      cwd: result.cwd,
      finalCwd: result.finalCwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    })
    const content = formatBashResult(result)
    return {
      content,
      isError: result.timedOut || result.exitCode !== 0,
      preserveErrorContent: true,
    }
  },
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
