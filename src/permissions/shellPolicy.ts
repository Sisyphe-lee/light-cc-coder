export type ShellDenyResult = {
  denied: boolean
  reason?: string
}

const gitInspectionSubcommands = new Set(["status", "diff", "log", "show", "rev-parse", "grep"])

export function hardDenyShellCommand(command: string): ShellDenyResult {
  const normalized = normalizeCommand(command)
  if (normalized.length === 0) return { denied: true, reason: "Empty shell command is denied" }
  if (normalized.includes(":(){ :|:& };:") || normalized.includes(":() { :|:& };:")) {
    return { denied: true, reason: "Fork bomb pattern is denied" }
  }
  if (hasDangerousRm(normalized)) {
    return { denied: true, reason: "Recursive forced removal of root or home is denied" }
  }
  if (/\b(mkfs(\.\w+)?|mkswap)\b/.test(normalized)) {
    return { denied: true, reason: "Disk formatting commands are denied" }
  }
  if (/\bdd\b[^\n;|&]*\bof=\/dev\//.test(normalized)) {
    return { denied: true, reason: "dd writes to /dev are denied" }
  }
  if (/\b(curl|wget)\b[^\n]*\|\s*(?:\S*\/)?(?:env\s+)?(?:sh|bash)\b/.test(normalized)) {
    return { denied: true, reason: "Piping downloaded content into a shell is denied" }
  }
  const git = parseGitInvocation(normalized)
  if (git && isMutatingGit(git.subcommand, git.args)) {
    return { denied: true, reason: `Mutating git command is denied: git ${git.subcommand}` }
  }
  return { denied: false }
}

export function isGitInspectionCommand(command: string): boolean {
  const normalized = normalizeCommand(command)
  if (hasShellControlOperator(normalized)) return false
  const git = parseGitInvocation(normalized)
  if (!git) return false
  if (git.subcommand === "branch") return git.args[0] === "--show-current"
  return gitInspectionSubcommands.has(git.subcommand)
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

function hasDangerousRm(command: string): boolean {
  const segments = command.split(/[;|&]+/)
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    const rmIndex = tokens.indexOf("rm")
    if (rmIndex === -1) continue
    const args = tokens.slice(rmIndex + 1)
    const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--").join("")
    const hasRecursiveForce = flags.includes("r") && flags.includes("f")
    const target = args.find((arg) => arg === "/" || arg === "~")
    if (hasRecursiveForce && target) return true
  }
  return false
}

function hasShellControlOperator(command: string): boolean {
  return /(?:&&|\|\||[;|`])|\$\(/.test(command)
}

function parseGitInvocation(command: string): { subcommand: string; args: string[] } | undefined {
  const tokens = command.split(/\s+/).filter(Boolean)
  if (tokens[0] !== "git") return undefined
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2
      continue
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("-c")) {
      index += 1
      continue
    }
    if (token === "--no-pager" || token === "--paginate" || token === "--bare") {
      index += 1
      continue
    }
    break
  }
  const subcommand = tokens[index]
  if (!subcommand) return undefined
  return { subcommand, args: tokens.slice(index + 1) }
}

function isMutatingGit(subcommand: string, args: string[]): boolean {
  if (["push", "commit", "clean", "rebase", "merge", "restore", "stash"].includes(subcommand)) return true
  if (subcommand === "reset" && args.includes("--hard")) return true
  if (subcommand === "checkout" && args.includes("--")) return true
  return false
}
