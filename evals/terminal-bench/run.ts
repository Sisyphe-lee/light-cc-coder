import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ProfileReport } from "../../profiling/report/types"
import { DEFAULT_EVAL_MODEL } from "../adapters/defaults"
import { loadCoderAdapter } from "../adapters/coders/loader"
import type { CoderAdapter } from "../adapters/coders/types"
import {
  safeTaskId,
  sanitizePathSegment,
  TERMINAL_BENCH_DEFAULTS,
  type TerminalBenchCoderMetadata,
  type TerminalBenchCommand,
  type TerminalBenchOptions,
  type TerminalBenchRunContext,
  type TerminalBenchTaskResult,
} from "./types"

const LIGHTCC_TERMINAL_BENCH_RUNTIME_CODER_IDS = new Set(["lightcc"])
const READY_TERMINAL_BENCH_RUNTIME_CODER_IDS = new Set(["lightcc", "openhands", "aider", "opencode"])
const SAFE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_ENV_NAME_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD)/i
const DEFAULT_EXTERNAL_HOST_DIR = "/home/sjx/.local"
const DEFAULT_EXTERNAL_CONTAINER_BIN_DIR = "/home/sjx/.local/bin"

type CommandResult = {
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

type PreflightCheck = {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
  command?: string[]
}

type HarborJobSummary = {
  path: string
  nTotalTrials?: number
  nCompletedTrials?: number
  nErroredTrials?: number
  nRunningTrials?: number
  nPendingTrials?: number
  nCancelledTrials?: number
  meanReward?: number
  costUsd?: number | null
}

type TerminalBenchAgentProfile = {
  reportPath: string
  sourceTranscript: string
  observedDurationMs: number
  profileSpanCount: number
  topBottleneck: string | null
  provider: {
    callCount: number
    totalDurationMs: number
    firstTokenMsP50: number | null
    streamMsP50: number | null
    inputTokens: number | null
    outputTokens: number | null
    cacheReadInputTokens: number | null
  }
  topSlowSpans: Array<{
    name: string
    category: string
    status: string
    durationMs: number
  }>
  warnings: string[]
}

type TerminalBenchWrapperProfileSummary = {
  path: string
  valid: boolean
  warningCount: number
  errors: string[]
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = normalizeOptions(parseArgs(argv))
    const coderAdapter = await loadCoderAdapter(options.coder)
    validateCoderForRun(options, coderAdapter)
    const context = buildRunContext(options)
    await mkdir(context.reportDir, { recursive: true })

    if (options.preflight) {
      const checks = await runPreflight(options, context, coderAdapter)
      await writeJson(join(context.reportDir, "preflight.json"), { checks })
      const failed = checks.some((check) => check.status === "fail")
      await writeSummary(options, context, coderAdapter, [], undefined, checks)
      printSummary(options, context, [], failed ? "preflight failed" : undefined)
      return failed ? 1 : 0
    }

    const tasks = await selectTasks(options)
    validateSelection(options, tasks)
    const results = await prepareTasks(tasks, context, options.datasetName)
    const command = buildTerminalBenchCommand(options, context, coderAdapter, tasks)
    await writeJson(join(context.reportDir, "harbor-command.json"), command)
    await writeJson(join(context.reportDir, "run.json"), {
      runId: context.runId,
      startedAt: new Date().toISOString(),
      defaults: TERMINAL_BENCH_DEFAULTS,
      coder: buildCoderMetadata(options, coderAdapter),
      mode: {
        dryRun: isDryRun(options),
        runHarbor: options.runHarbor,
        preflight: options.preflight,
        agentProfile: options.agentProfile,
        externalInstallMode: options.externalInstallMode,
      },
      options: serializableOptions(options),
      command,
    })

    let harborResult: CommandResult | undefined
    let harborJob: HarborJobSummary | undefined
    if (options.runHarbor) {
      const harborDir = join(context.reportDir, "harbor")
      await mkdir(harborDir, { recursive: true })
      harborResult = await runCommand(command.args, process.cwd(), command.env)
      await writeFile(join(harborDir, "stdout.log"), harborResult.stdout, "utf8")
      await writeFile(join(harborDir, "stderr.log"), harborResult.stderr, "utf8")
      await writeJson(join(harborDir, "command.json"), commandResultArtifact(harborResult, join(harborDir, "stdout.log"), join(harborDir, "stderr.log")))
      harborJob = await readHarborJobSummary(context)
    }

    await writeSummary(options, context, coderAdapter, results, harborResult, undefined, harborJob)
    const failed = harborResult && (harborResult.exitCode !== 0 || harborJobHasUnfinishedOrFailedTrials(harborJob))
    printSummary(options, context, results, failed ? "harbor failed" : undefined)
    return failed ? 1 : 0
  } catch (error) {
    console.error(stringifyError(error))
    return 1
  }
}

export function buildTerminalBenchCommand(
  options: TerminalBenchOptions,
  context: TerminalBenchRunContext,
  coderAdapter?: CoderAdapter,
  selectedTasks: string[] = options.tasks,
): TerminalBenchCommand {
  const args = [
    options.harborBin,
    "run",
    "-d",
    options.datasetName,
    "--agent-import-path",
    options.agentImportPath,
    "-k",
    String(options.attempts),
    "--jobs-dir",
    context.jobsDir,
    "--job-name",
    sanitizePathSegment(context.runId),
  ]
  for (const task of selectedTasks) args.push("-i", task)
  if (options.limit !== undefined) args.push("-l", String(options.limit))
  if (options.model) args.push("-m", options.model)
  if (options.environment) args.push("--env", options.environment)
  if (options.nConcurrent !== undefined) args.push("-n", String(options.nConcurrent))
  if (options.timeoutMultiplier !== undefined) args.push("--timeout-multiplier", String(options.timeoutMultiplier))
  if (options.agentTimeoutMultiplier !== undefined) args.push("--agent-timeout-multiplier", String(options.agentTimeoutMultiplier))
  if (options.verifierTimeoutMultiplier !== undefined) args.push("--verifier-timeout-multiplier", String(options.verifierTimeoutMultiplier))
  if (options.agentSetupTimeoutMultiplier !== undefined) args.push("--agent-setup-timeout-multiplier", String(options.agentSetupTimeoutMultiplier))
  if (options.environmentBuildTimeoutMultiplier !== undefined) args.push("--environment-build-timeout-multiplier", String(options.environmentBuildTimeoutMultiplier))
  for (const host of allowedEnvironmentHosts(options)) args.push("--allow-environment-host", host)
  for (const host of allowedAgentHosts(options)) args.push("--allow-agent-host", host)
  for (const entry of verifierEnvArgs(options)) args.push("--verifier-env", entry)
  if (options.mounts.length > 0) args.push("--mounts", mergeMountSpecs(options.mounts))
  for (const path of options.extraDockerCompose) args.push("--extra-docker-compose", path)

  const env: Record<string, string> = {
    PYTHONPATH: process.env.PYTHONPATH ? `${process.cwd()}:${process.env.PYTHONPATH}` : process.cwd(),
    LIGHT_CC_TBENCH_MAX_STEPS: String(options.maxSteps),
    LIGHT_CC_TBENCH_PERMISSION_MODE: options.permissionMode,
    LIGHT_CC_TBENCH_OS_SANDBOX: options.osSandbox,
    LIGHT_CC_API_KEY_ENV: options.apiKeyEnv,
    LIGHT_CC_TBENCH_CODER_ID: coderAdapter?.id ?? options.coder,
    LIGHT_CC_TBENCH_CODER_STATUS: coderAdapter?.status ?? "draft",
    LIGHT_CC_TBENCH_CODER_MODEL: options.model ?? DEFAULT_EVAL_MODEL,
    LIGHT_CC_TBENCH_PROVIDER_BASE_URL: options.baseUrl ?? "",
    LIGHT_CC_TBENCH_RUN_ID: context.runId,
    LIGHT_CC_TBENCH_WORKSPACE: "/workspace",
    LIGHT_CC_TBENCH_ARTIFACT_DIR: "/logs/agent",
    LIGHT_CC_TBENCH_PROMPT_FILE: "/logs/agent/prompt.md",
    LIGHT_CC_TBENCH_TRANSCRIPT_PATH: "/logs/agent/transcript.jsonl",
    LIGHT_CC_TBENCH_PATCH_PATH: "/logs/agent/patch.diff",
    LIGHT_CC_TBENCH_RESULT_PATH: "/logs/agent/result.json",
    LIGHT_CC_TBENCH_EXTERNAL_INSTALL_MODE: options.externalInstallMode,
    LIGHT_CC_TBENCH_EXTERNAL_BIN_DIR: options.externalContainerBinDir,
    LIGHT_CC_TBENCH_EXTERNAL_RUN_TIMEOUT_SECONDS: String(options.externalRunTimeoutSeconds),
  }
  if (coderAdapter) {
    const coderMetadata = buildCoderMetadata(options, coderAdapter)
    env.LIGHT_CC_TBENCH_CODER_DISPLAY_NAME = coderMetadata.displayName
    env.LIGHT_CC_TBENCH_CODER_RUNTIME = coderMetadata.runtime
    env.LIGHT_CC_TBENCH_CODER_RUN_STATUS = coderMetadata.runStatus
  }
  if (options.agentPackageSpec) env.LIGHT_CC_TBENCH_NPM_SPEC = options.agentPackageSpec
  if (options.agentNodeDir) env.LIGHT_CC_TBENCH_NODE_DIR = options.agentNodeDir
  if (options.agentEnvFile) env.LIGHT_CC_TBENCH_ENV_FILE = options.agentEnvFile
  if (options.sandboxSettings) env.LIGHT_CC_TBENCH_SANDBOX_SETTINGS = options.sandboxSettings
  if (options.baseUrl) env.LIGHT_CC_BASE_URL = options.baseUrl
  if (options.model) env.LIGHT_CC_MODEL = options.model
  if (options.agentProfile) env.LIGHT_CC_TBENCH_AGENT_PROFILE = "1"
  if (options.verifierProxy) {
    env.HTTP_PROXY = options.verifierProxy
    env.HTTPS_PROXY = options.verifierProxy
    env.NO_PROXY = process.env.NO_PROXY ?? "localhost,127.0.0.1,::1"
    env.http_proxy = options.verifierProxy
    env.https_proxy = options.verifierProxy
    env.no_proxy = env.NO_PROXY
  }
  return { args, cwd: process.cwd(), env }
}

async function selectTasks(options: TerminalBenchOptions): Promise<string[]> {
  const fromFile = options.tasksFile ? await readTasksFile(options.tasksFile) : []
  const explicit = [...new Set([...fromFile, ...options.tasks])]
  if (explicit.length > 0) return explicit
  if (options.limit !== undefined) return Array.from({ length: options.limit }, (_, index) => `limit-${index + 1}`)
  return []
}

async function readTasksFile(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8")
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) throw new Error("--tasks-file JSON must be an array")
    return parsed.map((value) => safeTaskId(String(value)))
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeTaskId)
}

async function prepareTasks(tasks: string[], context: TerminalBenchRunContext, datasetName: string): Promise<TerminalBenchTaskResult[]> {
  await writeFile(join(context.reportDir, "selected_tasks.jsonl"), `${tasks.map((taskId) => JSON.stringify({ task_id: taskId })).join("\n")}\n`, "utf8")
  const results: TerminalBenchTaskResult[] = []
  for (const taskId of tasks) {
    const artifactDir = join(context.reportDir, "tasks", sanitizePathSegment(taskId))
    await mkdir(artifactDir, { recursive: true })
    await writeFile(
      join(artifactDir, "prompt.md"),
      [
        `# Terminal-Bench Task ${taskId}`,
        "",
        "The task instruction is supplied by Harbor inside the task container at runtime.",
        "This dry-run artifact records the selected public task id and command contract only.",
        "",
      ].join("\n"),
      "utf8",
    )
    await writeJson(join(artifactDir, "task.json"), {
      task_id: taskId,
      dataset: datasetName,
    })
    await writeJson(join(artifactDir, "metrics.json"), {
      taskId,
      status: "prepared",
      artifactDir,
    })
    results.push({ taskId, status: "prepared", artifactDir })
  }
  return results
}

async function writeSummary(
  options: TerminalBenchOptions,
  context: TerminalBenchRunContext,
  coderAdapter: CoderAdapter,
  results: TerminalBenchTaskResult[],
  harborResult?: CommandResult,
  preflight?: PreflightCheck[],
  harborJob?: HarborJobSummary,
): Promise<void> {
  const completed = harborJob?.nCompletedTrials ?? results.filter((result) => result.status === "completed").length
  const failed = harborJob?.nErroredTrials ?? results.filter((result) => result.status === "failed").length
  const profileReports = options.agentProfile ? await collectTerminalBenchProfiles(context.jobsDir) : []
  const wrapperProfiles = await collectTerminalBenchWrapperProfiles(context.jobsDir)
  await writeJson(join(context.reportDir, "summary.json"), {
    runId: context.runId,
    reportDir: context.reportDir,
    jobsDir: context.jobsDir,
    dataset: {
      name: options.datasetName,
      runner: TERMINAL_BENCH_DEFAULTS.runner,
      attempts: options.attempts,
    },
    coder: {
      ...buildCoderMetadata(options, coderAdapter),
    },
    mode: {
      dryRun: isDryRun(options),
      runHarbor: options.runHarbor,
      preflight: options.preflight,
      agentProfile: options.agentProfile,
    },
    totals: {
      selected: results.length,
      prepared: results.filter((result) => result.status === "prepared").length,
      completed,
      failed,
    },
    tasks: results,
    profileReports,
    wrapperProfilePaths: wrapperProfiles.map((profile) => profile.path),
    wrapperProfileSummaries: wrapperProfiles,
    providerProfilePaths: options.providerProfilePath ? [options.providerProfilePath] : [],
    harbor: harborResult
      ? {
          exitCode: harborResult.exitCode,
          durationMs: harborResult.durationMs,
          stdoutBytes: Buffer.byteLength(harborResult.stdout),
          stderrBytes: Buffer.byteLength(harborResult.stderr),
        }
      : undefined,
    harborJob,
    preflight,
  })
}

async function readHarborJobSummary(context: TerminalBenchRunContext): Promise<HarborJobSummary | undefined> {
  const path = join(context.jobsDir, sanitizePathSegment(context.runId), "result.json")
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    stats?: {
      n_completed_trials?: number
      n_errored_trials?: number
      n_running_trials?: number
      n_pending_trials?: number
      n_cancelled_trials?: number
      cost_usd?: number | null
      evals?: Record<string, { metrics?: Array<{ mean?: number }> }>
    }
    n_total_trials?: number
  }
  const evals = Object.values(parsed.stats?.evals ?? {})
  const meanReward = evals
    .flatMap((entry) => entry.metrics ?? [])
    .map((metric) => metric.mean)
    .find((mean): mean is number => typeof mean === "number")
  return {
    path,
    nTotalTrials: parsed.n_total_trials,
    nCompletedTrials: parsed.stats?.n_completed_trials,
    nErroredTrials: parsed.stats?.n_errored_trials,
    nRunningTrials: parsed.stats?.n_running_trials,
    nPendingTrials: parsed.stats?.n_pending_trials,
    nCancelledTrials: parsed.stats?.n_cancelled_trials,
    meanReward,
    costUsd: parsed.stats?.cost_usd,
  }
}

async function collectTerminalBenchProfiles(jobsDir: string): Promise<TerminalBenchAgentProfile[]> {
  if (!existsSync(jobsDir)) return []
  const paths = await findProfileReports(jobsDir)
  const profiles: TerminalBenchAgentProfile[] = []
  for (const path of paths) {
    try {
      const report = JSON.parse(await readFile(path, "utf8")) as ProfileReport
      profiles.push(summarizeTerminalBenchProfile(path, report))
    } catch {
      // Ignore malformed profile files here; Harbor/trial failures are classified from normal artifacts.
    }
  }
  return profiles
}

async function findProfileReports(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === "profile.report.json" && path.includes(`${join("agent", "profile.report.json")}`)) {
        found.push(path)
      }
    }
  }
  await walk(root)
  return found.sort()
}

async function collectTerminalBenchWrapperProfiles(jobsDir: string): Promise<TerminalBenchWrapperProfileSummary[]> {
  if (!existsSync(jobsDir)) return []
  const paths = await findNamedFiles(jobsDir, "wrapper.profile.json")
  const profiles: TerminalBenchWrapperProfileSummary[] = []
  const { validateWrapperProfile } = await import("../wrapper-profile/validate")
  for (const path of paths) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown
      const validation = validateWrapperProfile(value)
      const warnings = value && typeof value === "object" && Array.isArray((value as { warnings?: unknown }).warnings)
        ? ((value as { warnings: unknown[] }).warnings.filter((warning) => typeof warning === "string") as string[])
        : []
      profiles.push({
        path,
        valid: validation.ok,
        warningCount: warnings.length,
        errors: validation.errors,
      })
    } catch (error) {
      profiles.push({ path, valid: false, warningCount: 0, errors: [stringifyError(error)] })
    }
  }
  return profiles
}

async function findNamedFiles(root: string, filename: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === filename) found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

function summarizeTerminalBenchProfile(reportPath: string, report: ProfileReport): TerminalBenchAgentProfile {
  return {
    reportPath,
    sourceTranscript: report.sourceTranscript,
    observedDurationMs: report.summary.observedDurationMs,
    profileSpanCount: report.summary.profileSpanCount,
    topBottleneck: report.summary.topBottleneck,
    provider: {
      callCount: report.provider.callCount,
      totalDurationMs: report.provider.totalDurationMs,
      firstTokenMsP50: report.provider.firstTokenMsP50,
      streamMsP50: report.provider.streamMsP50,
      inputTokens: report.provider.inputTokens,
      outputTokens: report.provider.outputTokens,
      cacheReadInputTokens: report.provider.cacheReadInputTokens,
    },
    topSlowSpans: report.topSlowSpans.slice(0, 5).map((span) => ({
      name: span.name,
      category: span.category,
      status: span.status,
      durationMs: span.durationMs,
    })),
    warnings: report.warnings,
  }
}

async function runPreflight(
  options: TerminalBenchOptions,
  context: TerminalBenchRunContext,
  coderAdapter: CoderAdapter,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  checks.push({
    name: "coder-adapter",
    status: coderAdapter.status === "ready" ? "pass" : "warn",
    detail: `${coderAdapter.id} (${coderAdapter.status})`,
  })
  checks.push({
    name: "coder-target",
    status: coderAdapter.targets.includes("terminal-bench") ? "pass" : "fail",
    detail: "terminal-bench",
  })
  checks.push(await runCheck("harbor-cli", [options.harborBin, "--version"]))
  checks.push(await runCheck("docker-cli", ["docker", "--version"]))
  checks.push(await runCheck("docker-compose", ["docker", "compose", "version"]))
  const dockerInfo = await runCheck("docker-daemon", ["docker", "info"])
  checks.push(dockerInfo)
  checks.push(await runAgentImportCheck(options))
  if (options.externalInstallMode === "mounted" && !LIGHTCC_TERMINAL_BENCH_RUNTIME_CODER_IDS.has(coderAdapter.id)) {
    checks.push(await runExternalMountedRuntimeCheck(options, coderAdapter))
  }
  checks.push({
    name: "jobs-dir",
    status: existsSync(context.jobsDir) || existsSync(context.reportDir) ? "pass" : "warn",
    detail: context.jobsDir,
  })
  return checks
}

async function runAgentImportCheck(options: TerminalBenchOptions): Promise<PreflightCheck> {
  if (!options.agentImportPath.includes(":")) {
    return {
      name: "agent-import-path",
      status: "fail",
      detail: "Expected module:Class import path",
    }
  }
  const args = [
    resolvePythonBin(options),
    "-c",
    [
      "import importlib",
      `spec = ${JSON.stringify(options.agentImportPath)}`,
      "module_name, class_name = spec.split(':', 1)",
      "module = importlib.import_module(module_name)",
      "getattr(module, class_name)",
      "print(spec)",
    ].join("; "),
  ]
  return runCheck("agent-import-path", args, {
    PYTHONPATH: process.env.PYTHONPATH ? `${process.cwd()}:${process.env.PYTHONPATH}` : process.cwd(),
  })
}

async function runExternalMountedRuntimeCheck(options: TerminalBenchOptions, coderAdapter: CoderAdapter): Promise<PreflightCheck> {
  const hostDir = options.externalHostDir ?? DEFAULT_EXTERNAL_HOST_DIR
  const executable = coderAdapter.command.executable
  const executablePath = join(hostDir, "bin", executable)
  if (!existsSync(hostDir)) {
    return {
      name: "external-mounted-runtime",
      status: "fail",
      detail: `missing host runtime root: ${hostDir}`,
      command: [executablePath],
    }
  }
  if (!existsSync(executablePath)) {
    return {
      name: "external-mounted-runtime",
      status: "fail",
      detail: `missing executable: ${executablePath}`,
      command: [executablePath],
    }
  }
  const probeArg = executable === "aider" ? "--version" : "--help"
  return runCheck("external-mounted-runtime", [executablePath, probeArg], {
    PATH: `${join(hostDir, "bin")}:${process.env.PATH ?? ""}`,
  })
}

async function runCheck(name: string, args: string[], env: Record<string, string> = {}): Promise<PreflightCheck> {
  try {
    const result = await runCommand(args, process.cwd(), env)
    const output = (result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`).split(/\r?\n/)[0] ?? ""
    return {
      name,
      status: result.exitCode === 0 ? "pass" : "fail",
      detail: output,
      command: args,
    }
  } catch (error) {
    return { name, status: "fail", detail: stringifyError(error), command: args }
  }
}

async function runCommand(args: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
  const startedMs = Date.now()
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { args, cwd, exitCode, stdout, stderr, durationMs: Date.now() - startedMs }
}

function commandResultArtifact(result: CommandResult, stdoutPath: string, stderrPath: string): Record<string, unknown> {
  return {
    args: result.args,
    cwd: result.cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutPath,
    stderrPath,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
  }
}

function normalizeOptions(options: TerminalBenchOptions): TerminalBenchOptions {
  options.pythonBin ??= inferPythonFromHarborBin(options.harborBin) ?? process.env.PYTHON ?? "python3"
  options.apiKeyEnv = parseEnvName(options.apiKeyEnv, "LIGHT_CC_API_KEY_ENV")
  if (options.externalInstallMode === "mounted") {
    options.externalHostDir ??= DEFAULT_EXTERNAL_HOST_DIR
    const mountTarget = dirname(options.externalContainerBinDir)
    const mount = JSON.stringify({
      type: "bind",
      source: options.externalHostDir,
      target: mountTarget,
      read_only: true,
    })
    const alreadyMounted = options.mounts.some((existing) => {
      try {
        const parsed = JSON.parse(existing) as unknown
        const entries = Array.isArray(parsed) ? parsed : [parsed]
        return entries.some((entry) => {
          if (!entry || typeof entry !== "object") return false
          const record = entry as Record<string, unknown>
          return record.source === options.externalHostDir && record.target === mountTarget
        })
      } catch {
        return existing.includes(options.externalHostDir ?? "") && existing.includes(mountTarget)
      }
    })
    if (!alreadyMounted) options.mounts.push(mount)
  }
  if (options.dryRunExplicit && options.runHarbor) throw new Error("Use --dry-run separately from --run")
  if (!options.allowLargeRun && options.tasks.length === 0 && !options.tasksFile && options.limit === undefined && !options.preflight) {
    throw new Error("Refusing to run the full Terminal-Bench split; pass --task, --limit, --preflight, or --allow-large-run")
  }
  if (!options.allowLargeRun && options.limit !== undefined && options.limit > 5) {
    throw new Error("Refusing to select more than 5 Terminal-Bench tasks without --allow-large-run")
  }
  return options
}

function validateSelection(options: TerminalBenchOptions, tasks: string[]): void {
  if (options.runHarbor && !options.allowLargeRun && tasks.length * options.attempts > 5) {
    throw new Error("Refusing to run more than 5 Terminal-Bench attempts without --allow-large-run")
  }
}

function validateCoderForRun(options: TerminalBenchOptions, adapter: CoderAdapter): void {
  if (!adapter.targets.includes("terminal-bench")) {
    throw new Error(`Coder adapter ${adapter.id} does not support terminal-bench`)
  }
  if (options.runHarbor && adapter.status !== "ready") {
    throw new Error(`Coder adapter ${adapter.id} is ${adapter.status}; real --run requires a ready adapter`)
  }
  if (options.runHarbor && !isReadyTerminalBenchRuntime(options, adapter)) {
    throw new Error(
      `Terminal-Bench --run supports only verified installed-agent runtimes (${[...LIGHTCC_TERMINAL_BENCH_RUNTIME_CODER_IDS].join(", ")}); pass --allow-unverified-runtime for a single-task smoke of ${[...READY_TERMINAL_BENCH_RUNTIME_CODER_IDS].join(", ")}`,
    )
  }
}

function parseArgs(argv: string[]): TerminalBenchOptions {
  const options: TerminalBenchOptions = {
    tasks: [],
    datasetName: TERMINAL_BENCH_DEFAULTS.datasetName,
    attempts: TERMINAL_BENCH_DEFAULTS.attempts,
    preflight: false,
    runHarbor: false,
    dryRunExplicit: false,
    allowLargeRun: false,
    allowUnverifiedRuntime: false,
    harborBin: "harbor",
    allowAgentHosts: [],
    allowEnvironmentHosts: [],
    verifierEnv: [],
    extraDockerCompose: [],
    mounts: [],
    externalInstallMode: "online",
    externalContainerBinDir: DEFAULT_EXTERNAL_CONTAINER_BIN_DIR,
    externalRunTimeoutSeconds: 1800,
    agentImportPath: TERMINAL_BENCH_DEFAULTS.agentImportPath,
    model: DEFAULT_EVAL_MODEL,
    maxSteps: 120,
    permissionMode: "danger-full-access",
    osSandbox: "off",
    apiKeyEnv: process.env.LIGHT_CC_API_KEY_ENV ?? "OPENAI_API_KEY",
    coder: "lightcc",
    agentProfile: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--task" || arg === "-t") options.tasks.push(safeTaskId(requireValue(argv, ++index, arg)))
    else if (arg === "--tasks-file") options.tasksFile = requireValue(argv, ++index, arg)
    else if (arg === "--limit") options.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--dataset" || arg === "-d") options.datasetName = requireValue(argv, ++index, arg)
    else if (arg === "--attempts" || arg === "-k") options.attempts = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--run-id") options.runId = requireValue(argv, ++index, arg)
    else if (arg === "--report-dir") options.reportDir = requireValue(argv, ++index, arg)
    else if (arg === "--jobs-dir") options.jobsDir = requireValue(argv, ++index, arg)
    else if (arg === "--preflight") options.preflight = true
    else if (arg === "--run") options.runHarbor = true
    else if (arg === "--dry-run") options.dryRunExplicit = true
    else if (arg === "--allow-large-run") options.allowLargeRun = true
    else if (arg === "--allow-unverified-runtime") options.allowUnverifiedRuntime = true
    else if (arg === "--harbor") options.harborBin = requireValue(argv, ++index, arg)
    else if (arg === "--python") options.pythonBin = requireValue(argv, ++index, arg)
    else if (arg === "--agent-import-path") options.agentImportPath = requireValue(argv, ++index, arg)
    else if (arg === "--model") options.model = requireValue(argv, ++index, arg)
    else if (arg === "--env") options.environment = requireValue(argv, ++index, arg)
    else if (arg === "--n-concurrent" || arg === "-n") options.nConcurrent = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--timeout-multiplier") options.timeoutMultiplier = parsePositiveNumber(requireValue(argv, ++index, arg), arg)
    else if (arg === "--agent-timeout-multiplier") options.agentTimeoutMultiplier = parsePositiveNumber(requireValue(argv, ++index, arg), arg)
    else if (arg === "--verifier-timeout-multiplier") options.verifierTimeoutMultiplier = parsePositiveNumber(requireValue(argv, ++index, arg), arg)
    else if (arg === "--agent-setup-timeout-multiplier") options.agentSetupTimeoutMultiplier = parsePositiveNumber(requireValue(argv, ++index, arg), arg)
    else if (arg === "--environment-build-timeout-multiplier") options.environmentBuildTimeoutMultiplier = parsePositiveNumber(requireValue(argv, ++index, arg), arg)
    else if (arg === "--allow-agent-host") options.allowAgentHosts.push(requireValue(argv, ++index, arg))
    else if (arg === "--allow-environment-host") options.allowEnvironmentHosts.push(requireValue(argv, ++index, arg))
    else if (arg === "--verifier-env" || arg === "--ve") options.verifierEnv.push(parseEnvAssignment(requireValue(argv, ++index, arg), arg))
    else if (arg === "--verifier-proxy") options.verifierProxy = requireValue(argv, ++index, arg)
    else if (arg === "--extra-docker-compose") options.extraDockerCompose.push(requireValue(argv, ++index, arg))
    else if (arg === "--agent-package-spec") options.agentPackageSpec = requireValue(argv, ++index, arg)
    else if (arg === "--agent-node-dir") options.agentNodeDir = requireValue(argv, ++index, arg)
    else if (arg === "--agent-env-file") options.agentEnvFile = requireValue(argv, ++index, arg)
    else if (arg === "--mounts") options.mounts.push(requireValue(argv, ++index, arg))
    else if (arg === "--external-install-mode") options.externalInstallMode = parseExternalInstallMode(requireValue(argv, ++index, arg))
    else if (arg === "--external-host-dir") options.externalHostDir = requireValue(argv, ++index, arg)
    else if (arg === "--external-container-bin-dir") options.externalContainerBinDir = requireValue(argv, ++index, arg)
    else if (arg === "--external-run-timeout-seconds") options.externalRunTimeoutSeconds = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--max-steps") options.maxSteps = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--permission-mode") options.permissionMode = parsePermissionMode(requireValue(argv, ++index, arg))
    else if (arg === "--os-sandbox") options.osSandbox = parseOsSandbox(requireValue(argv, ++index, arg))
    else if (arg === "--sandbox-settings") options.sandboxSettings = requireValue(argv, ++index, arg)
    else if (arg === "--base-url") options.baseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.apiKeyEnv = parseEnvName(requireValue(argv, ++index, arg), arg)
    else if (arg === "--coder") options.coder = requireValue(argv, ++index, arg)
    else if (arg === "--agent-profile") options.agentProfile = true
    else if (arg === "--provider-profile-path") options.providerProfilePath = requireValue(argv, ++index, arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function buildRunContext(options: TerminalBenchOptions): TerminalBenchRunContext {
  const runId = options.runId ?? defaultRunId()
  const reportDir = resolve(options.reportDir ?? join(process.cwd(), ".light-cc", "evals", runId, "terminal-bench"))
  const jobsDir = resolve(options.jobsDir ?? join(reportDir, "jobs"))
  return { runId, reportDir, jobsDir }
}

function isDryRun(options: TerminalBenchOptions): boolean {
  return options.dryRunExplicit || !options.runHarbor
}

function buildCoderMetadata(options: TerminalBenchOptions, adapter: CoderAdapter): TerminalBenchCoderMetadata {
  const readyRuntime = isReadyTerminalBenchRuntime(options, adapter)
  const verifiedRuntime = LIGHTCC_TERMINAL_BENCH_RUNTIME_CODER_IDS.has(adapter.id)
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    status: adapter.status,
    model: options.model ?? DEFAULT_EVAL_MODEL,
    installKind: adapter.install.kind,
    installPackage: adapter.install.package,
    runtime: readyRuntime
      ? LIGHTCC_TERMINAL_BENCH_RUNTIME_CODER_IDS.has(adapter.id)
        ? "lightcc-installed-agent"
        : "external-installed-agent"
      : "planned-external-installed-agent",
    runStatus: readyRuntime ? (verifiedRuntime ? "ready" : "smoke-unverified") : "dry-run-only",
  }
}

function isReadyTerminalBenchRuntime(options: TerminalBenchOptions, adapter: CoderAdapter): boolean {
  const loadedFromPath = existsSync(resolve(options.coder))
  if (loadedFromPath || adapter.status !== "ready") return false
  if (LIGHTCC_TERMINAL_BENCH_RUNTIME_CODER_IDS.has(adapter.id)) return true
  return options.allowUnverifiedRuntime && READY_TERMINAL_BENCH_RUNTIME_CODER_IDS.has(adapter.id)
}

function harborJobHasUnfinishedOrFailedTrials(job: HarborJobSummary | undefined): boolean {
  if (!job) return false
  const errored = job.nErroredTrials ?? 0
  const cancelled = job.nCancelledTrials ?? 0
  const running = job.nRunningTrials ?? 0
  const pending = job.nPendingTrials ?? 0
  const total = job.nTotalTrials
  const completed = job.nCompletedTrials
  return errored > 0 || cancelled > 0 || running > 0 || pending > 0 || (total !== undefined && completed !== undefined && completed < total)
}

function resolvePythonBin(options: TerminalBenchOptions): string {
  return options.pythonBin ?? inferPythonFromHarborBin(options.harborBin) ?? process.env.PYTHON ?? "python3"
}

function inferPythonFromHarborBin(harborBin: string): string | undefined {
  if (!harborBin.includes("/")) return undefined
  return join(dirname(resolve(harborBin)), "python")
}

function allowedAgentHosts(options: TerminalBenchOptions): string[] {
  const hosts = new Set(options.allowAgentHosts)
  if (options.baseUrl) {
    try {
      hosts.add(new URL(options.baseUrl).hostname)
    } catch {
      // Provider base URLs are validated by the coder itself; do not fail dry-run generation here.
    }
  }
  return [...hosts]
}

function allowedEnvironmentHosts(options: TerminalBenchOptions): string[] {
  const hosts = new Set(options.allowEnvironmentHosts)
  if (options.verifierProxy) {
    try {
      hosts.add(new URL(options.verifierProxy).hostname)
    } catch {
      // The proxy value is passed through for Docker/verifier tooling to validate.
    }
  }
  return [...hosts]
}

function verifierEnvArgs(options: TerminalBenchOptions): string[] {
  const entries = [...options.verifierEnv]
  if (options.verifierProxy) {
    const proxy = options.verifierProxy
    const keys = new Set(entries.map((entry) => entry.split("=", 1)[0]?.toUpperCase()))
    if (!keys.has("HTTP_PROXY")) entries.push(`HTTP_PROXY=${proxy}`)
    if (!keys.has("HTTPS_PROXY")) entries.push(`HTTPS_PROXY=${proxy}`)
    if (!keys.has("NO_PROXY")) entries.push("NO_PROXY=localhost,127.0.0.1,::1")
  }
  return entries
}

function parseEnvAssignment(value: string, flag: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new Error(`${flag} must be in KEY=VALUE format`)
  const key = value.slice(0, value.indexOf("="))
  if (SECRET_ENV_NAME_PATTERN.test(key)) {
    throw new Error(`${flag} refuses secret-like key ${key}; values are written to Terminal-Bench artifacts`)
  }
  return value
}

function parseEnvName(value: string, flag: string): string {
  if (!SAFE_ENV_NAME_PATTERN.test(value)) throw new Error(`${flag} must be an environment variable name`)
  return value
}

function mergeMountSpecs(mounts: string[]): string {
  const merged: unknown[] = []
  for (const mount of mounts) {
    const parsed = JSON.parse(mount) as unknown
    if (Array.isArray(parsed)) merged.push(...parsed)
    else merged.push(parsed)
  }
  return JSON.stringify(merged)
}

function serializableOptions(options: TerminalBenchOptions): Record<string, unknown> {
  return { ...options }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function printSummary(
  options: TerminalBenchOptions,
  context: TerminalBenchRunContext,
  results: TerminalBenchTaskResult[],
  error?: string,
): void {
  const mode = options.preflight ? "preflight" : isDryRun(options) ? "dry-run" : "run"
  console.log(`Terminal-Bench ${mode}: selected=${results.length}${error ? ` error=${error}` : ""}`)
  console.log(`Artifacts: ${context.reportDir}`)
}

function defaultRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")
  const suffix = createHash("sha256").update(`${timestamp}-${Math.random()}`).digest("hex").slice(0, 8)
  return `tbench-${timestamp}-${suffix}`
}

function parsePermissionMode(value: string): TerminalBenchOptions["permissionMode"] {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value
  throw new Error(`Invalid --permission-mode: ${value}`)
}

function parseOsSandbox(value: string): TerminalBenchOptions["osSandbox"] {
  if (value === "off" || value === "auto" || value === "required") return value
  throw new Error(`Invalid --os-sandbox: ${value}`)
}

function parseExternalInstallMode(value: string): TerminalBenchOptions["externalInstallMode"] {
  if (value === "online" || value === "mounted") return value
  throw new Error(`Invalid --external-install-mode: ${value}`)
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`)
  return parsed
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(): string {
  return [
    "Usage: bun run eval:tbench -- --coder lightcc --task <task-id> [--dry-run|--run]",
    "       bun run eval:tbench -- --limit 3 --dry-run",
    "       bun run eval:tbench -- --coder openhands --external-install-mode mounted --allow-unverified-runtime --task <task-id> --run",
    "       bun run eval:tbench -- --preflight",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
