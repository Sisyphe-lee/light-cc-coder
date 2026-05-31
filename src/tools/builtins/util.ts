import { ToolExecutionError } from "../result"

export function expectObject(input: unknown, toolName: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolExecutionError("invalid_input", `${toolName} input must be an object`)
  }
  return input as Record<string, unknown>
}

export function expectString(object: Record<string, unknown>, key: string): string {
  const value = object[key]
  if (typeof value !== "string") {
    throw new ToolExecutionError("invalid_input", `${key} must be a string`)
  }
  return value
}

export function optionalString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new ToolExecutionError("invalid_input", `${key} must be a string`)
  }
  return value
}

export function optionalBoolean(object: Record<string, unknown>, key: string): boolean | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") {
    throw new ToolExecutionError("invalid_input", `${key} must be a boolean`)
  }
  return value
}

export function optionalInteger(
  object: Record<string, unknown>,
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): number {
  const value = object[key]
  if (value === undefined) return defaultValue
  if (!Number.isInteger(value)) {
    throw new ToolExecutionError("invalid_input", `${key} must be an integer`)
  }
  const number = value as number
  if (options.min !== undefined && number < options.min) {
    throw new ToolExecutionError("invalid_input", `${key} must be >= ${options.min}`)
  }
  if (options.max !== undefined && number > options.max) {
    throw new ToolExecutionError("invalid_input", `${key} must be <= ${options.max}`)
  }
  return number
}

export function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = 0
  while (true) {
    const next = text.indexOf(needle, index)
    if (next === -1) return count
    count += 1
    index = next + needle.length
  }
}

export function createUnifiedDiff(path: string, before: string, after: string, maxLines = 120): string {
  if (before === after) return `No changes in ${path}`
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const lines = [`--- a/${path}`, `+++ b/${path}`, "@@"]
  for (const line of beforeLines) lines.push(`-${line}`)
  for (const line of afterLines) lines.push(`+${line}`)
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join("\n")}\n[truncated: diff capped at ${maxLines} lines]`
  }
  return lines.join("\n")
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return [""]
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}
