import { ToolExecutionError, truncateText } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, expectString, optionalInteger } from "./util"
import { repeatedReadStub } from "./readCache"

type ReadInput =
  | {
      path: string
      offset: number
      limit: number
      line?: undefined
      context?: undefined
    }
  | {
      path: string
      line: number
      context: number
      offset?: undefined
      limit?: undefined
    }

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description: "Read a UTF-8 text file from the workspace with 1-based line numbers. Use line+context for a centered window.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to read." },
      offset: { type: "number", description: "1-based starting line.", default: 1 },
      limit: { type: "number", description: "Maximum number of lines to return.", default: 200 },
      line: { type: "number", description: "Optional 1-based target line for a centered read window." },
      context: { type: "number", description: "Lines before and after line when line is provided.", default: 40 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "read")
    const path = expectString(object, "path")
    if (object.line !== undefined) {
      if (object.offset !== undefined || object.limit !== undefined) {
        throw new ToolExecutionError("invalid_input", "line/context cannot be combined with offset/limit")
      }
      return {
        path,
        line: optionalInteger(object, "line", 1, { min: 1 }),
        context: optionalInteger(object, "context", 40, { min: 0, max: 500 }),
      }
    }
    if (object.context !== undefined) {
      throw new ToolExecutionError("invalid_input", "context requires line")
    }
    return {
      path,
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
    const start = input.line === undefined ? input.offset : Math.max(1, input.line - input.context)
    const limit = input.line === undefined ? input.limit : input.context * 2 + 1
    const end = Math.min(lines.length, start + limit - 1)
    if (input.line !== undefined && input.line > lines.length) {
      throw new ToolExecutionError("invalid_input", `line ${input.line} is past end of file`, file.relativePath)
    }
    if (start > lines.length) {
      throw new ToolExecutionError("invalid_input", `offset ${start} is past end of file`, file.relativePath)
    }
    const duplicate = repeatedReadStub(ctx, {
      relativePath: file.relativePath,
      start,
      limit,
      end,
      totalLines: lines.length,
      content: file.content,
    })
    if (duplicate) return { content: duplicate }
    const width = String(end).length
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(width, " ")} | ${line}`)
      .join("\n")
    const marker = end < lines.length ? `\n[more: next offset ${end + 1}]` : ""
    return { content: truncateText(`File: ${file.relativePath}\n${body}${marker}`, 32 * 1024) }
  },
}
