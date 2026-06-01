import type { PermissionMode } from "../permissions/types"
import type { ToolRuntimeToolInfo } from "../tools/ToolRuntime"
import type { TodoState } from "../tools/builtins/todo"

export type SlashCommandName = "help" | "clear" | "compact" | "memory" | "tools" | "permissions"

export type SlashCommandInvocation = {
  command: SlashCommandName | "unknown"
  rawCommand: string
  args: string
}

export type SlashCommandResult =
  | { type: "output"; command: string; content: string; hostAction?: "clear" }
  | { type: "compact"; command: string; instruction?: string }

const BUILTIN_COMMANDS = new Set(["help", "clear", "compact", "memory", "tools", "permissions"])

export function parseSlashCommand(content: string): SlashCommandInvocation | undefined {
  const trimmed = content.trim()
  if (!trimmed.startsWith("/")) return undefined
  const withoutSlash = trimmed.slice(1)
  const [rawCommand = "", ...rest] = withoutSlash.split(/\s+/)
  if (rawCommand.length === 0) return undefined
  const command = BUILTIN_COMMANDS.has(rawCommand) ? (rawCommand as SlashCommandName) : "unknown"
  return { command, rawCommand, args: rest.join(" ") }
}

export function executeSlashCommand(
  invocation: SlashCommandInvocation,
  input: {
    tools?: ToolRuntimeToolInfo[]
    permissionMode?: PermissionMode
    todoState?: TodoState
  },
): SlashCommandResult {
  if (invocation.command === "unknown") {
    return { type: "output", command: invocation.rawCommand, content: `Unknown slash command: /${invocation.rawCommand}` }
  }
  if (invocation.command === "help") {
    return {
      type: "output",
      command: invocation.command,
      content: [
        "Built-in slash commands:",
        "/help",
        "/clear",
        "/compact [instruction]",
        "/memory",
        "/tools",
        "/permissions",
      ].join("\n"),
    }
  }
  if (invocation.command === "tools") {
    const tools = input.tools ?? []
    const content =
      tools.length === 0
        ? "No tool metadata is available."
        : tools.map((tool) => `${tool.name}\t${tool.readOnly ? "read-only" : "write-capable"}`).join("\n")
    return { type: "output", command: invocation.command, content }
  }
  if (invocation.command === "permissions") {
    return {
      type: "output",
      command: invocation.command,
      content: [
        `Permission mode: ${input.permissionMode ?? "unknown"}`,
        "Policy: deny sensitive paths and hard-denied shell commands; ask when configured by policy.",
      ].join("\n"),
    }
  }
  if (invocation.command === "memory") {
    const todo = input.todoState?.summary() ?? ""
    return {
      type: "output",
      command: invocation.command,
      content: todo ? `Implicit memory is not implemented.\n\n${todo}` : "Implicit memory is not implemented.",
    }
  }
  if (invocation.command === "clear") {
    return {
      type: "output",
      command: invocation.command,
      hostAction: "clear",
      content: "Clear requested. The host should discard this AgentSession and start a new one.",
    }
  }
  return { type: "compact", command: invocation.command, instruction: invocation.args || undefined }
}
