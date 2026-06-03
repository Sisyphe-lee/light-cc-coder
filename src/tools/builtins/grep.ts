import { spawn } from "node:child_process"
import { ToolExecutionError } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, expectString, optionalBoolean, optionalInteger, optionalString } from "./util"

type GrepOutputMode = "content" | "files_with_matches" | "count"

type GrepInput = {
  pattern: string
  path?: string
  glob?: string
  caseSensitive: boolean
  maxResults: number
  outputMode: GrepOutputMode
  beforeContext: number
  afterContext: number
}

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search workspace text with ripgrep. Default output returns relativePath:line:column:text matches; output_mode can return files or counts.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern for ripgrep." },
      path: { type: "string", description: "Optional workspace-relative directory or file to search." },
      glob: { type: "string", description: "Optional ripgrep glob filter." },
      caseSensitive: { type: "boolean", description: "Use case-sensitive matching.", default: true },
      maxResults: { type: "number", description: "Maximum matches to return.", default: 100 },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output style: content match lines, matching files, or per-file match counts.",
        default: "content",
      },
      context: { type: "number", description: "Lines of context before and after each content match.", default: 0 },
      beforeContext: { type: "number", description: "Lines of context before each content match.", default: 0 },
      afterContext: { type: "number", description: "Lines of context after each content match.", default: 0 },
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
      outputMode: parseOutputMode(optionalString(object, "output_mode")),
      beforeContext: optionalInteger(object, "beforeContext", optionalInteger(object, "context", 0, { min: 0, max: 20 }), {
        min: 0,
        max: 20,
      }),
      afterContext: optionalInteger(object, "afterContext", optionalInteger(object, "context", 0, { min: 0, max: 20 }), {
        min: 0,
        max: 20,
      }),
    }
  },
  accesses(input) {
    return { searches: [input.path ?? ".", input.pattern] }
  },
  async execute(input, ctx) {
    const root = await ctx.workspace.resolveSearchRoot(input.path)
    const args = buildRgArgs(input, root.relativePath === "." ? "." : root.relativePath)

    const observation = await runRg(args, ctx.workspace.boundary.root, ctx.signal)
    if (observation.code === 1) return { content: "No matches." }
    if (observation.code !== 0) {
      throw new ToolExecutionError("invalid_input", observation.stderr.trim() || "ripgrep failed")
    }

    if (input.outputMode === "files_with_matches") {
      const files = parsePlainLines(observation.stdout, ctx.workspace.boundary.root, input.maxResults)
      const marker = files.truncated ? `\n[truncated: more than ${input.maxResults} files with matches]` : ""
      return { content: files.lines.length === 0 ? "No matches." : `Files:\n${files.lines.join("\n")}${marker}` }
    }

    if (input.outputMode === "count") {
      const counts = parsePlainLines(observation.stdout, ctx.workspace.boundary.root, input.maxResults)
      const marker = counts.truncated ? `\n[truncated: more than ${input.maxResults} files with matches]` : ""
      return { content: counts.lines.length === 0 ? "No matches." : `Counts:\n${counts.lines.join("\n")}${marker}` }
    }

    const matches = parseRgJson(observation.stdout, ctx.workspace.boundary.root, input.maxResults)
    const marker = matches.truncated ? `\n[truncated: more than ${input.maxResults} matches]` : ""
    return { content: matches.lines.length === 0 ? "No matches." : `Matches:\n${matches.lines.join("\n")}${marker}` }
  },
}

function parseOutputMode(value: string | undefined): GrepOutputMode {
  if (value === undefined) return "content"
  if (value === "content" || value === "files_with_matches" || value === "count") return value
  throw new ToolExecutionError("invalid_input", "output_mode must be one of content, files_with_matches, count")
}

function buildRgArgs(input: GrepInput, target: string): string[] {
  const args =
    input.outputMode === "content"
      ? ["--json", "--line-number", "--column", "--color", "never"]
      : input.outputMode === "files_with_matches"
        ? ["--files-with-matches", "--color", "never"]
        : ["--count-matches", "--with-filename", "--color", "never"]
  args.push(
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!references/repos/**",
    "--glob",
    "!WebRepo/**",
  )
  if (!input.caseSensitive) args.push("-i")
  if (input.glob) args.push("--glob", input.glob)
  if (input.outputMode === "content") {
    if (input.beforeContext > 0) args.push("--before-context", String(input.beforeContext))
    if (input.afterContext > 0) args.push("--after-context", String(input.afterContext))
  }
  args.push(input.pattern, target)
  return args
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
  const pendingContext: string[] = []
  let matchCount = 0
  let truncated = false
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.length === 0) continue
    const item = JSON.parse(raw) as RgJsonLine
    if (item.type === "context") {
      const formatted = formatRgJsonLine(item, workspaceRoot, "-")
      if (matchCount === 0) pendingContext.push(formatted)
      else if (!truncated) lines.push(formatted)
      continue
    }
    if (item.type !== "match") continue
    if (matchCount >= maxResults) {
      pendingContext.length = 0
      truncated = true
      continue
    }
    if (pendingContext.length > 0) lines.push(...pendingContext.splice(0))
    lines.push(formatRgJsonLine(item, workspaceRoot, String((item.data.submatches[0]?.start ?? 0) + 1)))
    matchCount += 1
  }
  return { lines, truncated }
}

function formatRgJsonLine(item: Extract<RgJsonLine, { type: "match" | "context" }>, workspaceRoot: string, column: string): string {
  const data = item.data
  const relativePath = normalizeRgPath(data.path.text, workspaceRoot)
  const line = data.lines.text.replace(/\r?\n$/, "")
  return `${relativePath}:${data.line_number}:${column}:${line}`
}

function parsePlainLines(
  stdout: string,
  workspaceRoot: string,
  maxResults: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let truncated = false
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.length === 0) continue
    if (lines.length >= maxResults) {
      truncated = true
      continue
    }
    lines.push(normalizeRgPath(raw, workspaceRoot))
  }
  return { lines, truncated }
}

function normalizeRgPath(pathText: string, workspaceRoot: string): string {
  const normalized = pathText.startsWith(workspaceRoot)
    ? pathText.slice(workspaceRoot.length + 1).split("\\").join("/")
    : pathText.split("\\").join("/")
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
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
  | {
      type: "context"
      data: {
        path: { text: string }
        lines: { text: string }
        line_number: number
      }
    }
  | { type: "begin" | "end" | "summary"; data: unknown }
