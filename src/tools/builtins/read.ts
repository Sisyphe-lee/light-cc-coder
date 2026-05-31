import { ToolExecutionError, truncateText } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, expectString, optionalInteger } from "./util"

type ReadInput = {
  path: string
  offset: number
  limit: number
}

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description: "Read a UTF-8 text file from the workspace with 1-based line numbers.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to read." },
      offset: { type: "number", description: "1-based starting line.", default: 1 },
      limit: { type: "number", description: "Maximum number of lines to return.", default: 200 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "read")
    return {
      path: expectString(object, "path"),
      offset: optionalInteger(object, "offset", 1, { min: 1 }),
      limit: optionalInteger(object, "limit", 200, { min: 1, max: 1000 }),
    }
  },
  accesses(input) {
    return { reads: [input.path] }
  },
  async execute(input, ctx) {
    const file = await ctx.workspace.readTextFile(input.path)
    const lines = file.content.split(/\r?\n/)
    const start = input.offset
    const end = Math.min(lines.length, start + input.limit - 1)
    if (start > lines.length) {
      throw new ToolExecutionError("invalid_input", `offset ${start} is past end of file`, file.relativePath)
    }
    const width = String(end).length
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(width, " ")} | ${line}`)
      .join("\n")
    const marker = end < lines.length ? `\n[more: next offset ${end + 1}]` : ""
    return { content: truncateText(`File: ${file.relativePath}\n${body}${marker}`, 32 * 1024) }
  },
}
