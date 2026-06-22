export type GitPatchCommandResult = {
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export type GitPatchCollection = {
  baseRef: string
  patch: string
  addIntent: GitPatchCommandResult
  headDiff: GitPatchCommandResult
  committedDiff: GitPatchCommandResult
  baseDiff: GitPatchCommandResult
  commands: GitPatchCommandResult[]
  committedChangesCollected: boolean
  headDiffMissedChanges: boolean
  error?: string
}

type CollectGitPatchOptions = {
  timeoutMs?: number
  env?: Record<string, string>
}

export async function collectGitPatchSinceBase(
  workspace: string,
  baseRef: string,
  options: CollectGitPatchOptions = {},
): Promise<GitPatchCollection> {
  const addIntent = await runGitCommand(["git", "add", "-N", "."], workspace, options)
  const headDiff = await runGitCommand(["git", "diff", "--binary", "--no-ext-diff", "HEAD"], workspace, options)
  const committedDiff = await runGitCommand(["git", "diff", "--binary", "--no-ext-diff", baseRef, "HEAD"], workspace, options)
  const baseDiff = await runGitCommand(["git", "diff", "--binary", "--no-ext-diff", baseRef], workspace, options)
  const patch = baseDiff.exitCode === 0 ? baseDiff.stdout : ""
  const commands = [addIntent, headDiff, committedDiff, baseDiff]
  const error =
    addIntent.exitCode !== 0
      ? `git add -N failed: ${firstLine(addIntent.stderr) || `exit ${addIntent.exitCode}`}`
      : baseDiff.exitCode !== 0
        ? `git diff from base failed: ${firstLine(baseDiff.stderr) || `exit ${baseDiff.exitCode}`}`
        : undefined

  return {
    baseRef,
    patch,
    addIntent,
    headDiff,
    committedDiff,
    baseDiff,
    commands,
    committedChangesCollected: committedDiff.exitCode === 0 && committedDiff.stdout.length > 0,
    headDiffMissedChanges: headDiff.exitCode === 0 && headDiff.stdout.length === 0 && patch.length > 0,
    error,
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? ""
}

async function runGitCommand(
  args: string[],
  cwd: string,
  options: CollectGitPatchOptions,
): Promise<GitPatchCommandResult> {
  const startedMs = Date.now()
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let terminateTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs && options.timeoutMs > 0) {
    terminateTimer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000)
    }, options.timeoutMs)
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (terminateTimer) clearTimeout(terminateTimer)
  if (killTimer) clearTimeout(killTimer)
  const timeoutMessage = options.timeoutMs ? `Timed out after ${options.timeoutMs}ms` : "Timed out"
  const finalStderr = timedOut ? [stderr.trimEnd(), timeoutMessage].filter(Boolean).join("\n") : stderr

  return {
    args,
    cwd,
    exitCode: timedOut && exitCode === 0 ? 124 : exitCode,
    stdout,
    stderr: finalStderr,
    durationMs: Date.now() - startedMs,
    timedOut,
  }
}
