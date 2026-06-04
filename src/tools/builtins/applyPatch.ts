import { unlink } from "node:fs/promises"
import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { invalidateReadCacheForPath } from "./readCache"
import { countOccurrences, createUnifiedDiff, expectObject, expectString } from "./util"

type ApplyPatchInput = {
  patch: string
}

type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; hunks: PatchHunk[] }

type PatchHunk = {
  oldText: string
  newText: string
}

type FilePlan = {
  path: string
  absolutePath: string
  before: string
  after?: string
  action: "Added" | "Updated" | "Deleted"
}

export const applyPatchTool: ToolDefinition<ApplyPatchInput> = {
  name: "apply_patch",
  description: "Apply a small patch DSL with Add File, Update File, and Delete File sections inside the workspace.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Patch text beginning with *** Begin Patch and ending with *** End Patch." },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "apply_patch")
    return { patch: expectString(object, "patch") }
  },
  async execute(input, ctx) {
    const operations = parsePatch(input.patch)
    const planned = new Map<string, FilePlan>()

    for (const op of operations) {
      if (op.type === "add") {
        if (await ctx.workspace.exists(op.path)) {
          throw new ToolExecutionError("patch_conflict", "Add File target already exists", op.path)
        }
        const resolved = await ctx.workspace.resolveForWrite(op.path)
        if (planned.has(resolved.relativePath)) {
          throw new ToolExecutionError("patch_conflict", "Patch contains conflicting operations for one file", resolved.relativePath)
        }
        planned.set(resolved.relativePath, {
          path: resolved.relativePath,
          before: "",
          after: op.content,
          absolutePath: resolved.absolutePath,
          action: "Added",
        })
        continue
      }

      if (op.type === "delete") {
        const plan = await getExistingPlan(op.path, planned, ctx)
        if (plan.after === undefined) {
          throw new ToolExecutionError("patch_conflict", "File is already deleted by this patch", plan.path)
        }
        if (plan.action === "Added") {
          throw new ToolExecutionError("patch_conflict", "Patch adds and deletes the same file", plan.path)
        }
        plan.after = undefined
        plan.action = "Deleted"
        continue
      }

      const plan = await getExistingPlan(op.path, planned, ctx)
      if (plan.after === undefined) {
        throw new ToolExecutionError("patch_conflict", "Patch updates a file after deleting it", plan.path)
      }
      let next = plan.after
      for (const hunk of op.hunks) {
        const occurrences = countOccurrences(next, hunk.oldText)
        if (occurrences !== 1) {
          throw new ToolExecutionError(
            "patch_conflict",
            occurrences === 0 ? "Patch hunk context was not found" : "Patch hunk context is not unique",
            plan.path,
          )
        }
        next = next.replace(hunk.oldText, hunk.newText)
      }
      plan.after = next
      if (plan.action !== "Added") plan.action = "Updated"
    }

    for (const item of planned.values()) {
      if (item.after === undefined) {
        await unlink(item.absolutePath)
      } else {
        await ctx.workspace.writeTextFile(item.path, item.after)
      }
      invalidateReadCacheForPath(ctx, item.path)
    }

    return {
      content: Array.from(planned.values())
        .map((item) => `${item.action} ${item.path}\n${createUnifiedDiff(item.path, item.before, item.after ?? "")}`)
        .join("\n\n"),
    }
  },
}

async function getExistingPlan(
  path: string,
  planned: Map<string, FilePlan>,
  ctx: Parameters<typeof applyPatchTool.execute>[1],
): Promise<FilePlan> {
  const file = await ctx.workspace.readTextFile(path)
  const existing = planned.get(file.relativePath)
  if (existing) return existing
  const plan: FilePlan = {
    path: file.relativePath,
    before: file.content,
    after: file.content,
    absolutePath: file.absolutePath,
    action: "Updated",
  }
  planned.set(file.relativePath, plan)
  return plan
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new ToolExecutionError("malformed_patch", "Patch must start with *** Begin Patch and end with *** End Patch")
  }
  const operations: PatchOperation[] = []
  let index = 1
  while (index < lines.length - 1) {
    const line = lines[index]
    if (line.startsWith("*** Add File: ")) {
      const path = parsePatchPath(line, "*** Add File: ")
      const body: string[] = []
      index += 1
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new ToolExecutionError("malformed_patch", "Add File lines must start with +", path)
        }
        body.push(lines[index].slice(1))
        index += 1
      }
      operations.push({ type: "add", path, content: body.join("\n") + (body.length > 0 ? "\n" : "") })
      continue
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: parsePatchPath(line, "*** Delete File: ") })
      index += 1
      continue
    }

    if (line.startsWith("*** Update File: ")) {
      const path = parsePatchPath(line, "*** Update File: ")
      const hunks: PatchHunk[] = []
      index += 1
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        if (lines[index] !== "@@" && !lines[index].startsWith("@@ ")) {
          throw new ToolExecutionError("malformed_patch", "Update sections require @@ hunks", path)
        }
        index += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        while (index < lines.length - 1 && !lines[index].startsWith("*** ") && lines[index] !== "@@" && !lines[index].startsWith("@@ ")) {
          const hunkLine = lines[index]
          if (hunkLine.startsWith(" ")) {
            oldLines.push(hunkLine.slice(1))
            newLines.push(hunkLine.slice(1))
          } else if (hunkLine.startsWith("-")) {
            oldLines.push(hunkLine.slice(1))
          } else if (hunkLine.startsWith("+")) {
            newLines.push(hunkLine.slice(1))
          } else {
            throw new ToolExecutionError("malformed_patch", "Hunk lines must start with space, -, or +", path)
          }
          index += 1
        }
        if (oldLines.length === 0) {
          throw new ToolExecutionError("malformed_patch", "Update hunk must include context or removed lines", path)
        }
        hunks.push({ oldText: joinPatchLines(oldLines), newText: joinPatchLines(newLines) })
      }
      if (hunks.length === 0) {
        throw new ToolExecutionError("malformed_patch", "Update File requires at least one hunk", path)
      }
      operations.push({ type: "update", path, hunks })
      continue
    }

    if (line.length === 0) {
      index += 1
      continue
    }
    throw new ToolExecutionError("malformed_patch", `Unknown patch directive: ${line}`)
  }
  if (operations.length === 0) {
    throw new ToolExecutionError("malformed_patch", "Patch contains no operations")
  }
  return operations
}

function parsePatchPath(line: string, prefix: string): string {
  const path = line.slice(prefix.length)
  const parts = path.split("/")
  if (path.length === 0 || path.startsWith("/") || parts.includes("..") || parts.includes(".")) {
    throw new ToolExecutionError("malformed_patch", "Patch paths must be non-empty workspace-relative paths")
  }
  return path
}

function joinPatchLines(lines: string[]): string {
  return lines.join("\n") + "\n"
}
