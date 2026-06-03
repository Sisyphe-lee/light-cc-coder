import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { invalidateReadCacheForPath } from "./readCache"
import { countOccurrences, createUnifiedDiff, expectObject, expectString, splitLines } from "./util"

type EditInput = {
  path: string
  oldText: string
  newText: string
}

export const editTool: ToolDefinition<EditInput> = {
  name: "edit",
  description: "Replace one exact text occurrence in a workspace file. The oldText must match exactly once.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "edit")
    const oldText = expectString(object, "oldText")
    if (oldText.length === 0) throw new ToolExecutionError("invalid_input", "oldText must not be empty")
    return {
      path: expectString(object, "path"),
      oldText,
      newText: expectString(object, "newText"),
    }
  },
  accesses(input) {
    return { reads: [input.path], writes: [input.path] }
  },
  async execute(input, ctx) {
    const file = await ctx.workspace.readTextFile(input.path)
    const occurrences = countOccurrences(file.content, input.oldText)
    if (occurrences === 0) {
      throw new ToolExecutionError("not_unique", renderMissingOldText(file.relativePath, file.content, input.oldText), file.relativePath)
    }
    if (occurrences > 1) {
      throw new ToolExecutionError(
        "not_unique",
        renderDuplicateOldText(file.relativePath, file.content, input.oldText, occurrences),
        file.relativePath,
      )
    }
    const next = file.content.replace(input.oldText, input.newText)
    await ctx.workspace.writeTextFile(input.path, next)
    invalidateReadCacheForPath(ctx, file.relativePath)
    return { content: `Edited ${file.relativePath}\n${createUnifiedDiff(file.relativePath, file.content, next)}` }
  },
}

function renderMissingOldText(path: string, content: string, oldText: string): string {
  const lines = [
    `oldText was not found in ${path}.`,
    `Searched for ${Buffer.byteLength(oldText, "utf8")} bytes across ${splitLines(oldText).length} line(s).`,
  ]
  const candidates = findFragmentCandidates(content, oldText)
  if (candidates.length > 0) {
    lines.push("", "Nearby candidate lines matching fragments from oldText:")
    for (const candidate of candidates) lines.push(`- ${candidate}`)
  } else {
    lines.push("", "No close fragment candidates were found in the target file.")
  }
  lines.push("", "Next step: read the target range again and retry with exact whitespace, indentation, and surrounding context.")
  return lines.join("\n")
}

function renderDuplicateOldText(path: string, content: string, oldText: string, occurrences: number): string {
  const lines = [
    `oldText appears ${occurrences} times in ${path}; edit requires exactly one match.`,
    "Add more surrounding lines to oldText so only the intended occurrence matches.",
    "",
    "Matching occurrence contexts:",
  ]
  const contexts = occurrenceContexts(content, oldText, 5)
  for (const context of contexts) lines.push(context)
  if (occurrences > contexts.length) lines.push(`... ${occurrences - contexts.length} more occurrence(s) omitted ...`)
  return lines.join("\n")
}

function findFragmentCandidates(content: string, oldText: string): string[] {
  const fragments = candidateFragments(oldText)
  const fileLines = splitLines(content)
  const output: string[] = []
  const seen = new Set<number>()
  for (const fragment of fragments) {
    for (let index = 0; index < fileLines.length && output.length < 6; index++) {
      if (seen.has(index)) continue
      if (!fileLines[index].includes(fragment)) continue
      seen.add(index)
      output.push(`line ${index + 1}: ${snippet(fileLines[index])}`)
    }
    if (output.length >= 6) break
  }
  return output
}

function candidateFragments(oldText: string): string[] {
  const lines = splitLines(oldText)
    .map((line) => line.trim())
    .filter((line) => line.length >= 3)
  const words = oldText.match(/[A-Za-z0-9_$.-]{4,}/g) ?? []
  return Array.from(new Set([...lines, ...words])).sort((left, right) => right.length - left.length).slice(0, 8)
}

function occurrenceContexts(content: string, needle: string, limit: number): string[] {
  const output: string[] = []
  let searchIndex = 0
  while (output.length < limit) {
    const index = content.indexOf(needle, searchIndex)
    if (index === -1) break
    output.push(renderContextAt(content, index, needle.length))
    searchIndex = index + needle.length
  }
  return output
}

function renderContextAt(content: string, index: number, length: number): string {
  const startLine = lineNumberAt(content, index)
  const endLine = lineNumberAt(content, index + length)
  const fileLines = splitLines(content)
  const start = Math.max(1, startLine - 2)
  const end = Math.min(fileLines.length, endLine + 2)
  const lines = [`--- occurrence at lines ${startLine}-${endLine} ---`]
  for (let line = start; line <= end; line++) {
    lines.push(`${String(line).padStart(4, " ")} | ${snippet(fileLines[line - 1])}`)
  }
  return lines.join("\n")
}

function lineNumberAt(content: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < Math.min(index, content.length); cursor++) {
    if (content.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function snippet(value: string): string {
  const normalized = value.length === 0 ? "(blank)" : value.replace(/\t/g, "\\t")
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}
