import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const maxSectionChars = 12_000

export async function renderWorkspaceDiff(cwd: string): Promise<string> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"])
  if (!root.ok) return "Diff unavailable: this workspace is not inside a git repository."

  const status = await git(cwd, ["status", "--short", "--untracked-files=normal", "--", "."])
  const unstaged = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--", "."])
  const staged = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat", "--", "."])

  const sections = [
    "# Workspace Diff",
    `Git root: ${root.stdout.trim()}`,
    "## Status",
    status.ok && status.stdout.trim() ? cap(status.stdout.trimEnd()) : "(clean)",
    "## Unstaged Diff Stat",
    unstaged.ok && unstaged.stdout.trim() ? cap(unstaged.stdout.trimEnd()) : "(none)",
    "## Staged Diff Stat",
    staged.ok && staged.stdout.trim() ? cap(staged.stdout.trimEnd()) : "(none)",
  ]
  return sections.join("\n")
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout: String(stdout) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

function cap(value: string): string {
  if (value.length <= maxSectionChars) return value
  return `${value.slice(0, maxSectionChars)}\n[truncated: diff section capped at ${maxSectionChars} chars]`
}
