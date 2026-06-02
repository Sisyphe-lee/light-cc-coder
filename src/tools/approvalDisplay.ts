import type { ToolAccesses } from "./registry"
import { truncateText } from "./result"

// Presentation helpers that summarize a tool call for the approval prompt.
// Kept out of ToolRuntime so the runtime stays focused on execution.

export function toolReason(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ["description", "reason"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return truncateText(value.trim(), 240)
  }
  return undefined
}

export function summarizeInput(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input)
  } catch {
    text = String(input)
  }
  return truncateText(text, 500)
}

export function summarizeAccesses(accesses: ToolAccesses | undefined): string {
  if (!accesses) return "No declared workspace accesses."
  const parts = [
    summarizeList("reads", accesses.reads),
    summarizeList("writes", accesses.writes),
    summarizeList("searches", accesses.searches),
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join("; ") : "No declared workspace accesses."
}

function summarizeList(label: string, values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined
  const visible = values.slice(0, 4)
  const suffix = values.length > visible.length ? `, +${values.length - visible.length} more` : ""
  return `${label}: ${visible.map((value) => truncateText(value, 120)).join(", ")}${suffix}`
}

export function summarizeRisk(toolName: string, readOnly: boolean, accesses: ToolAccesses | undefined): string {
  if (toolName === "bash") {
    return "Shell command can execute arbitrary programs in the workspace; review the command, cwd, and stated reason."
  }
  if (toolName.startsWith("mcp__") && !readOnly) {
    return "Opaque MCP tool may perform side effects through its server; review the input and server/tool name."
  }
  if ((accesses?.writes?.length ?? 0) > 0 || !readOnly) {
    return "Tool may modify workspace state; review declared writes and input summary."
  }
  return "Read-only tool; risk is limited to information exposure through tool output."
}
