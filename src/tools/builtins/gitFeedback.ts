import { spawn } from "node:child_process"
import { isSensitiveRelativePath } from "../../workspace/pathBoundary"
import { ToolExecutionError, truncateText } from "../result"
import type { ToolDefinition } from "../registry"
import { expectObject, optionalString } from "./util"

type GitFeedbackInput = {
  reason: string
}

type GitRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

type StatusSnapshot = {
  staged: string[]
  unstaged: string[]
  untracked: string[]
  redactedDiffFiles: string[]
}

const statusFileCap = 80
const previewFileCap = 16
const diffPreviewBytes = 24 * 1024
const gitOutputBytes = 256 * 1024
const gitTimeoutMs = 5_000

export const gitFeedbackTool: ToolDefinition<GitFeedbackInput> = {
  name: "git_feedback",
  description:
    "Inspect git branch, dirty files, diff stat, and a bounded diff preview only when the user asks for git state or a concrete patch conflict requires it. Requires a concise reason. This tool never mutates git state.",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: {
        type: "string",
        description: "Why git state is needed now, e.g. user requested it or a patch conflict is visible.",
      },
    },
    required: ["reason"],
  },
  parse(input) {
    const object = expectObject(input, "git_feedback")
    const reason = optionalString(object, "reason")?.trim()
    if (!reason) {
      throw new ToolExecutionError(
        "invalid_input",
        "git_feedback requires reason: use only when the user asks for git state or a patch conflict is visible",
      )
    }
    return { reason }
  },
  async execute(_input, ctx) {
    const feedback = await collectGitFeedback(ctx.workspace.root, ctx.signal)
    return { content: feedback }
  },
}

async function collectGitFeedback(cwd: string, signal: AbortSignal): Promise<string> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"], signal)
  if (root.exitCode !== 0) {
    return ["# Git Feedback", "Repository: no", "Reason: workspace is not inside a git repository."].join("\n")
  }

  const [branch, head, statusRaw, unstagedStat, stagedStat] = await Promise.all([
    currentBranch(cwd, signal),
    shortHead(cwd, signal),
    git(cwd, ["status", "--porcelain=v1", "-z", "--", "."], signal),
    git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--", "."], signal),
    git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat", "--", "."], signal),
  ])

  if (statusRaw.exitCode !== 0) {
    return [
      "# Git Feedback",
      "Repository: yes",
      `Repository root: ${root.stdout.trim()}`,
      `Branch: ${branch}`,
      `HEAD: ${head}`,
      `Error: git status failed (${statusRaw.stderr.trim() || statusRaw.stdout.trim() || "unknown error"})`,
    ].join("\n")
  }

  const status = parsePorcelainStatus(statusRaw.stdout)
  const dirtyCount = status.staged.length + status.unstaged.length + status.untracked.length
  const lines = [
    "# Git Feedback",
    "Repository: yes",
    `Repository root: ${root.stdout.trim()}`,
    `Branch: ${branch}`,
    `HEAD: ${head}`,
    `Dirty: ${dirtyCount === 0 ? "no" : "yes"}`,
    `Changed files: ${dirtyCount} (${status.staged.length} staged, ${status.unstaged.length} unstaged, ${status.untracked.length} untracked)`,
    "",
    renderFileSection("Staged files", status.staged, statusFileCap),
    "",
    renderFileSection("Unstaged files", status.unstaged, statusFileCap),
    "",
    renderFileSection("Untracked files", status.untracked, statusFileCap),
    "",
    "## Diff Stat",
    renderStat("Staged", stagedStat),
    renderStat("Unstaged", unstagedStat),
    "",
    "## Diff Preview",
    await renderDiffPreview(cwd, status, signal),
  ]
  return lines.join("\n")
}

async function currentBranch(cwd: string, signal: AbortSignal): Promise<string> {
  const symbolic = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()
  const detached = await git(cwd, ["rev-parse", "--short", "HEAD"], signal)
  if (detached.exitCode === 0 && detached.stdout.trim()) return `detached at ${detached.stdout.trim()}`
  return "(unborn)"
}

async function shortHead(cwd: string, signal: AbortSignal): Promise<string> {
  const result = await git(cwd, ["rev-parse", "--short", "HEAD"], signal)
  if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim()
  return "(no commits)"
}

function parsePorcelainStatus(raw: string): StatusSnapshot {
  const staged = new Set<string>()
  const unstaged = new Set<string>()
  const untracked = new Set<string>()
  const redactedDiffFiles = new Set<string>()
  const records = raw.split("\0")
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    if (code === "??") {
      untracked.add(path)
      continue
    }
    if (code === "!!") continue
    const stagedCode = code[0]
    const unstagedCode = code[1]
    const oldPath = stagedCode === "R" || stagedCode === "C" ? records[index + 1] : undefined
    if (isSensitiveRelativePath(path) || (oldPath && isSensitiveRelativePath(oldPath))) {
      redactedDiffFiles.add(path)
    }
    if (stagedCode && stagedCode !== " ") staged.add(path)
    if (unstagedCode && unstagedCode !== " ") unstaged.add(path)
    if (stagedCode === "R" || stagedCode === "C") index += 1
  }
  return {
    staged: Array.from(staged).sort(),
    unstaged: Array.from(unstaged).sort(),
    untracked: Array.from(untracked).sort(),
    redactedDiffFiles: Array.from(redactedDiffFiles).sort(),
  }
}

function renderFileSection(title: string, files: string[], cap: number): string {
  if (files.length === 0) return `## ${title}\n(none)`
  const visible = files.slice(0, cap)
  const lines = [`## ${title}`]
  for (const file of visible) lines.push(`- ${file}`)
  if (files.length > visible.length) lines.push(`[truncated: ${files.length - visible.length} additional files omitted]`)
  return lines.join("\n")
}

function renderStat(label: string, result: GitRunResult): string {
  if (result.exitCode !== 0) return `${label}: unavailable (${result.stderr.trim() || "git diff --stat failed"})`
  const stat = result.stdout.trim()
  return `${label}:\n${stat.length > 0 ? truncateText(stat, 12 * 1024) : "(none)"}`
}

async function renderDiffPreview(cwd: string, status: StatusSnapshot, signal: AbortSignal): Promise<string> {
  const chunks: string[] = []
  let remainingBytes = diffPreviewBytes
  let previewedFiles = 0

  const append = (text: string): boolean => {
    if (remainingBytes <= 0) return false
    const capped = truncateText(text, remainingBytes)
    chunks.push(capped)
    remainingBytes -= Buffer.byteLength(capped, "utf8")
    return Buffer.byteLength(text, "utf8") <= Buffer.byteLength(capped, "utf8")
  }

  for (const [label, files, argsPrefix] of [
    ["staged", status.staged, ["diff", "--cached", "--no-ext-diff", "--no-textconv"] as string[]],
    ["unstaged", status.unstaged, ["diff", "--no-ext-diff", "--no-textconv"] as string[]],
  ] as const) {
    for (const file of files) {
      if (previewedFiles >= previewFileCap) {
        chunks.push(`[truncated: diff preview capped at ${previewFileCap} files]`)
        return chunks.join("\n")
      }
      previewedFiles += 1
      if (isSensitiveRelativePath(file) || status.redactedDiffFiles.includes(file)) {
        chunks.push(`### ${label}: ${file}\n[redacted: sensitive path patch omitted]`)
        continue
      }
      const diff = await git(cwd, [...argsPrefix, "--", file], signal)
      if (diff.exitCode !== 0) {
        chunks.push(`### ${label}: ${file}\n[diff unavailable: ${diff.stderr.trim() || "git diff failed"}]`)
        continue
      }
      const content = diff.stdout.trimEnd()
      if (content.length === 0) continue
      const complete = append(`### ${label}: ${file}\n${content}\n`)
      if (!complete) {
        chunks.push(`[truncated: diff preview capped at ${diffPreviewBytes} bytes]`)
        return chunks.join("\n")
      }
    }
  }

  if (chunks.length === 0) return "(no staged or unstaged diff preview)"
  if (status.untracked.length > 0) chunks.push("Untracked files are listed above; file contents are not previewed.")
  return chunks.join("\n")
}

function git(cwd: string, args: string[], signal: AbortSignal): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd,
      env: { ...process.env, GIT_EXTERNAL_DIFF: "false", GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = new CappedBuffer(gitOutputBytes)
    const stderr = new CappedBuffer(16 * 1024)
    let timedOut = false
    let settled = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, gitTimeoutMs)
    const onAbort = () => child.kill("SIGTERM")
    signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk))
    child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk))
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      resolve({ exitCode: null, stdout: "", stderr: error.message, timedOut })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      resolve({
        exitCode: code,
        stdout: stdout.text(),
        stderr: timedOut ? `${stderr.text()}\n[git command timed out]` : stderr.text(),
        timedOut,
      })
    })
  })
}

class CappedBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    if (this.truncated) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (this.bytes + buffer.byteLength > this.maxBytes) {
      const keep = Math.max(0, this.maxBytes - this.bytes)
      if (keep > 0) this.chunks.push(buffer.subarray(0, keep))
      this.bytes = this.maxBytes
      this.truncated = true
      return
    }
    this.chunks.push(buffer)
    this.bytes += buffer.byteLength
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString("utf8")
    return this.truncated ? `${text}\n[truncated: git output capped at ${this.maxBytes} bytes]` : text
  }
}
