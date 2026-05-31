import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { countOccurrences, createUnifiedDiff, expectObject, expectString } from "./util"

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
      throw new ToolExecutionError("not_unique", "oldText was not found", file.relativePath)
    }
    if (occurrences > 1) {
      throw new ToolExecutionError("not_unique", `oldText appears ${occurrences} times`, file.relativePath)
    }
    const next = file.content.replace(input.oldText, input.newText)
    await ctx.workspace.writeTextFile(input.path, next)
    return { content: `Edited ${file.relativePath}\n${createUnifiedDiff(file.relativePath, file.content, next)}` }
  },
}
