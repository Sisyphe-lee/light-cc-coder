import { opendir } from "node:fs/promises"
import { join, relative } from "node:path"
import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, expectString, optionalInteger, optionalString } from "./util"

type GlobInput = {
  pattern: string
  path?: string
  maxResults: number
}

const ignoredDirs = new Set([".git", "node_modules", "WebRepo"])

export const globTool: ToolDefinition<GlobInput> = {
  name: "glob",
  description: "Find files in the workspace using a glob pattern. Results are workspace-relative paths.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern such as **/*.ts." },
      path: { type: "string", description: "Optional workspace-relative directory to search." },
      maxResults: { type: "number", description: "Maximum files to return.", default: 200 },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "glob")
    const pattern = expectString(object, "pattern")
    if (pattern.length === 0 || pattern.startsWith("/") || pattern.includes("\0")) {
      throw new ToolExecutionError("invalid_input", "pattern must be a non-empty relative glob")
    }
    return {
      pattern,
      path: optionalString(object, "path"),
      maxResults: optionalInteger(object, "maxResults", 200, { min: 1, max: 5000 }),
    }
  },
  accesses(input) {
    return { searches: [input.path ?? ".", input.pattern] }
  },
  async execute(input, ctx) {
    const root = await ctx.workspace.resolveSearchRoot(input.path)
    const regex = globToRegExp(input.pattern)
    const files: string[] = []
    await walk(root.absolutePath, async (absolutePath) => {
      const relFromSearchRoot = relative(root.absolutePath, absolutePath).split("\\").join("/")
      const relFromWorkspace = ctx.workspace.boundary.displayPath(absolutePath)
      if (regex.test(relFromSearchRoot) || regex.test(relFromWorkspace)) {
        files.push(relFromWorkspace)
      }
    })
    files.sort()
    const capped = files.slice(0, input.maxResults)
    const marker = files.length > capped.length ? `\n[truncated: ${files.length - capped.length} more files]` : ""
    return { content: capped.length === 0 ? "No files matched." : `Matched files:\n${capped.join("\n")}${marker}` }
  },
}

async function walk(dir: string, onFile: (absolutePath: string) => Promise<void> | void): Promise<void> {
  const entries = await opendir(dir)
  for await (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue
      if (entry.name === "repos" && dir.endsWith(`${join("references")}`)) continue
      await walk(join(dir, entry.name), onFile)
      continue
    }
    if (entry.isFile()) {
      await onFile(join(dir, entry.name))
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let out = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    const next = pattern[index + 1]
    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      out += "(?:.*/)?"
      index += 2
      continue
    }
    if (char === "*" && next === "*") {
      out += ".*"
      index += 1
      continue
    }
    if (char === "*") {
      out += "[^/]*"
      continue
    }
    if (char === "?") {
      out += "[^/]"
      continue
    }
    out += escapeRegExp(char)
  }
  out += "$"
  return new RegExp(out)
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
}
