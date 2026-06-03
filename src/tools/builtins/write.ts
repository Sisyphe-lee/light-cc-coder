import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { invalidateReadCacheForPath } from "./readCache"
import { createUnifiedDiff, expectObject, expectString, optionalBoolean } from "./util"

type WriteInput = {
  path: string
  content: string
  overwrite: boolean
}

export const writeTool: ToolDefinition<WriteInput> = {
  name: "write",
  description: "Create or overwrite a workspace text file. Existing files require overwrite=true.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean", default: false },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "write")
    return {
      path: expectString(object, "path"),
      content: expectString(object, "content"),
      overwrite: optionalBoolean(object, "overwrite") ?? false,
    }
  },
  accesses(input) {
    return { writes: [input.path] }
  },
  async execute(input, ctx) {
    const exists = await ctx.workspace.exists(input.path)
    if (exists && !input.overwrite) {
      const resolved = await ctx.workspace.resolveForWrite(input.path)
      throw new ToolExecutionError("patch_conflict", "File already exists; set overwrite=true to replace it", resolved.relativePath)
    }
    const before = exists ? (await ctx.workspace.readTextFile(input.path)).content : ""
    const resolved = await ctx.workspace.writeTextFile(input.path, input.content)
    invalidateReadCacheForPath(ctx, resolved.relativePath)
    const action = exists ? "Wrote" : "Created"
    return {
      content: `${action} ${resolved.relativePath}\n${createUnifiedDiff(resolved.relativePath, before, input.content)}`,
    }
  },
}
