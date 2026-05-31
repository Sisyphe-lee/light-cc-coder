import { spawn } from "node:child_process"
import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, expectString, optionalBoolean, optionalInteger, optionalString } from "./util"

type GrepInput = {
  pattern: string
  path?: string
  glob?: string
  caseSensitive: boolean
  maxResults: number
}

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description: "Search workspace text with ripgrep and return relativePath:line:column:text matches.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern for ripgrep." },
      path: { type: "string", description: "Optional workspace-relative directory or file to search." },
      glob: { type: "string", description: "Optional ripgrep glob filter." },
      caseSensitive: { type: "boolean", description: "Use case-sensitive matching.", default: true },
      maxResults: { type: "number", description: "Maximum matches to return.", default: 100 },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  parse(input) {
    const object = expectObject(input, "grep")
    const pattern = expectString(object, "pattern")
    if (pattern.length === 0) throw new ToolExecutionError("invalid_input", "pattern must not be empty")
    return {
      pattern,
      path: optionalString(object, "path"),
      glob: optionalString(object, "glob"),
      caseSensitive: optionalBoolean(object, "caseSensitive") ?? true,
      maxResults: optionalInteger(object, "maxResults", 100, { min: 1, max: 1000 }),
    }
  },
  accesses(input) {
    return { searches: [input.path ?? ".", input.pattern] }
  },
  async execute(input, ctx) {
    const root = await ctx.workspace.resolveSearchRoot(input.path)
    const args = [
      "--json",
      "--line-number",
      "--column",
      "--color",
      "never",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!references/repos/**",
      "--glob",
      "!WebRepo/**",
    ]
    if (!input.caseSensitive) args.push("-i")
    if (input.glob) args.push("--glob", input.glob)
    args.push(input.pattern, root.relativePath === "." ? "." : root.relativePath)

    const observation = await runRg(args, ctx.workspace.boundary.root, ctx.signal)
    if (observation.code === 1) return { content: "No matches." }
    if (observation.code !== 0) {
      throw new ToolExecutionError("invalid_input", observation.stderr.trim() || "ripgrep failed")
    }

    const matches = parseRgJson(observation.stdout, ctx.workspace.boundary.root, input.maxResults)
    const marker = matches.truncated ? `\n[truncated: more than ${input.maxResults} matches]` : ""
    return {
      content: matches.lines.length === 0 ? "No matches." : `Matches:\n${matches.lines.join("\n")}${marker}`,
    }
  },
}

function runRg(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      if (signal.aborted) reject(error)
      else reject(new ToolExecutionError("io_error", `Failed to run rg: ${error.message}`))
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function parseRgJson(
  stdout: string,
  workspaceRoot: string,
  maxResults: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let truncated = false
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.length === 0) continue
    const item = JSON.parse(raw) as RgJsonLine
    if (item.type !== "match") continue
    const data = item.data
    if (lines.length >= maxResults) {
      truncated = true
      continue
    }
    const pathText = data.path.text
    const relativePath = pathText.startsWith(workspaceRoot)
      ? pathText.slice(workspaceRoot.length + 1).split("\\").join("/")
      : pathText.split("\\").join("/")
    const line = data.lines.text.replace(/\r?\n$/, "")
    const column = (data.submatches[0]?.start ?? 0) + 1
    lines.push(`${relativePath}:${data.line_number}:${column}:${line}`)
  }
  return { lines, truncated }
}

type RgJsonLine =
  | {
      type: "match"
      data: {
        path: { text: string }
        lines: { text: string }
        line_number: number
        submatches: Array<{ start: number }>
      }
    }
  | { type: "begin" | "end" | "summary" | "context"; data: unknown }
