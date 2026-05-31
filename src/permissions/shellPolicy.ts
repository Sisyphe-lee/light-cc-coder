export type ShellDenyResult = {
  denied: boolean
  reason?: string
}

const mutatingGit = [
  "git push",
  "git commit",
  "git reset --hard",
  "git clean",
  "git rebase",
  "git merge",
  "git checkout",
  "git restore",
  "git stash",
]

const gitInspectionPrefixes = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "git branch --show-current",
  "git grep",
]

export function hardDenyShellCommand(command: string): ShellDenyResult {
  const normalized = normalizeCommand(command)
  if (normalized.length === 0) return { denied: true, reason: "Empty shell command is denied" }
  if (normalized.includes(":(){ :|:& };:") || normalized.includes(":() { :|:& };:")) {
    return { denied: true, reason: "Fork bomb pattern is denied" }
  }
  if (/\brm\s+-[^\n;|&]*r[^\n;|&]*f[^\n;|&]*(?:\/|~)(?:\s|$)/.test(normalized)) {
    return { denied: true, reason: "Recursive forced removal of root or home is denied" }
  }
  if (/\b(mkfs|mkswap)(?:\s|$)/.test(normalized)) {
    return { denied: true, reason: "Disk formatting commands are denied" }
  }
  if (/\bdd\b[^\n;|&]*\bof=\/dev\//.test(normalized)) {
    return { denied: true, reason: "dd writes to /dev are denied" }
  }
  if (/\b(curl|wget)\b[^\n]*\|\s*(?:sh|bash)\b/.test(normalized)) {
    return { denied: true, reason: "Piping downloaded content into a shell is denied" }
  }
  for (const prefix of mutatingGit) {
    if (hasCommandPrefix(normalized, prefix)) {
      return { denied: true, reason: `Mutating git command is denied: ${prefix}` }
    }
  }
  return { denied: false }
}

export function isGitInspectionCommand(command: string): boolean {
  const normalized = normalizeCommand(command)
  return gitInspectionPrefixes.some((prefix) => hasCommandPrefix(normalized, prefix))
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

function hasCommandPrefix(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `)
}
