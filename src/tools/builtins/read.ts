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

const previewLineLimit = 80
const lineContextLimit = 200

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description:
    'Read a UTF-8 text file from the workspace with 1-based line numbers. Targets a single file: to list or explore a directory such as "." or "src", use glob or grep instead, not read. Use workspace-relative paths. Path-only preview is coarse, capped at 80 lines, and should not be paged. Prefer grep first, then line+context 40-80 around a known symbol or grep hit. Do not re-read the same routine with a larger window just to see the complete flow. Offset paging is disabled.',
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to read." },
      offset: { type: "number", description: "Preview mode only; must be 1. Offset paging is disabled.", default: 1 },
      limit: {
        type: "number",
        description: "Maximum preview lines from the start of the file; capped at 80.",
        default: previewLineLimit,
      },
      line: { type: "number", description: "Optional 1-based target line for a centered read window." },
      context: { type: "number", description: "Lines before and after line when line is provided. Prefer 40-80 for localization.", default: 40 },
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
        context: optionalInteger(object, "context", 40, { min: 0, max: lineContextLimit }),
      }
    }
    if (object.context !== undefined) {
      throw new ToolExecutionError("invalid_input", "context requires line")
    }
    const offset = optionalInteger(object, "offset", 1, { min: 1 })
    if (offset !== 1) {
      throw new ToolExecutionError("invalid_input", "offset paging is disabled; use grep to find a line number, then read with line+context")
    }
    return {
      path,
      offset,
      limit: optionalInteger(object, "limit", previewLineLimit, { min: 1, max: previewLineLimit }),
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
    const warning =
      input.line === undefined
        ? "Warning: path-only preview is coarse and capped at 80 lines. Do not page; use grep to find a line, then read with line+context.\n"
        : ""
    const duplicate = repeatedReadStub(ctx, {
      relativePath: file.relativePath,
      start,
      limit,
      end,
      totalLines: lines.length,
      content: file.content,
    })
    if (duplicate) return { content: `${warning}${duplicate}` }
    const width = String(end).length
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(width, " ")} | ${line}`)
      .join("\n")
    const marker =
      end < lines.length ? "\n[more: use grep to find a symbol or read with line+context; offset paging is disabled]" : ""
    return { content: truncateText(`File: ${file.relativePath}\n${warning}${body}${marker}`, 32 * 1024) }
  },
}
