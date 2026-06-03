#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { DEFAULT_EVAL_MODEL } from "../adapters/defaults"
import { loadCoderAdapter } from "../adapters/coders/loader"
import type { CoderAdapter, CoderAdapterStatus, CoderEvalTarget } from "../adapters/coders/types"
import { startProviderProxy } from "../provider-proxy/run"
import { safeInstanceFromRecord } from "../swebench/types"

export const EVAL_MATRIX_RUN_SCHEMA_VERSION = 1

export type MatrixBenchmark = CoderEvalTarget
export type MatrixRunMode = "dry-run" | "run"
export type MatrixPermissionMode = "read-only" | "workspace-write" | "danger-full-access"

export type MatrixRunRequest = {
  runId?: string
  reportDir?: string
  workDir?: string
  coders?: string[]
  benchmarks?: MatrixBenchmark[]
  tasks?: Partial<Record<MatrixBenchmark, string[]>>
  genericTasks?: string[]
  concurrency?: number
  mode?: MatrixRunMode
  allowDraftReal?: boolean
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  envFile?: string
  providerProxy?: {
    upstreamBaseUrl?: string
    listenHost?: string
    apiKeyEnv?: string
  }
  maxSteps?: number
  permissionMode?: MatrixPermissionMode
  allowLargeRun?: boolean
  maxJobs?: number
  profileCoders?: string[]
  swebench?: {
    profile?: "lite" | "verified"
    instancesFile?: string
    tasksetFile?: string
    python?: string
    keepWorkspaces?: boolean
    extraArgs?: string[]
  }
  tbench?: {
    dataset?: string
    harbor?: string
    attempts?: number
    extraArgs?: string[]
  }
}

export type MatrixJobCommand = {
  args: string[]
  cwd: string
  env?: Record<string, string>
  envFile?: string
  providerProxy?: MatrixJobProviderProxy
}

export type MatrixJobProviderProxy = {
  activate: boolean
  listenHost: string
  upstreamBaseUrl: string
  apiKeyEnv: string
  model: string
  profilePath: string
}

export type MatrixJob = {
  id: string
  index: number
  matrixRunId: string
  runId: string
  coderRef: string
  coderId: string
  coderDisplayName: string
  coderStatus: CoderAdapterStatus
  benchmark: MatrixBenchmark
  taskId: string
  model: string
  artifactDir: string
  reportDir: string
  workDir: string
  command: MatrixJobCommand
}

export type MatrixPlan = {
  schemaVersion: typeof EVAL_MATRIX_RUN_SCHEMA_VERSION
  mode: MatrixRunMode
  runId: string
  createdAt: string
  reportDir: string
  workDir: string
  concurrency: number
  model: string
  totals: {
    coders: number
    benchmarks: number
    tasks: number
    jobs: number
    draftJobs: number
  }
  jobs: MatrixJob[]
  warnings: string[]
  profileCoders: string[]
}

export type MatrixCommandExecution = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export type MatrixCommandRunner = (command: MatrixJobCommand, job: MatrixJob) => Promise<MatrixCommandExecution>

export type MatrixJobResult = {
  id: string
  index: number
  coderId: string
  coderStatus: CoderAdapterStatus
  benchmark: MatrixBenchmark
  taskId: string
  runId: string
  reportDir: string
  workDir: string
  artifactDir: string
  status: "completed" | "failed"
  exitCode?: number
  startedAt: string
  endedAt: string
  durationMs: number
  commandPath: string
  stdoutPath: string
  stderrPath: string
  stdoutBytes: number
  stderrBytes: number
  providerProfilePath?: string
  error?: string
}

export type MatrixSummary = {
  schemaVersion: typeof EVAL_MATRIX_RUN_SCHEMA_VERSION
  status: "completed" | "failed"
  mode: MatrixRunMode
  runId: string
  startedAt: string
  endedAt: string
  durationMs: number
  reportDir: string
  workDir: string
  planPath: string
  jobsPath: string
  concurrency: number
  model: string
  totals: {
    jobs: number
    completed: number
    failed: number
    draftJobs: number
  }
  jobs: MatrixJobResult[]
  warnings: string[]
}

type ResolvedMatrixRunRequest = Required<
  Pick<
    MatrixRunRequest,
    | "runId"
    | "reportDir"
    | "workDir"
    | "coders"
    | "benchmarks"
    | "genericTasks"
    | "concurrency"
    | "mode"
    | "allowDraftReal"
    | "model"
    | "apiKeyEnv"
    | "maxSteps"
    | "permissionMode"
    | "allowLargeRun"
    | "maxJobs"
    | "profileCoders"
  >
> &
  Pick<MatrixRunRequest, "baseUrl" | "envFile"> & {
    providerProxy?: {
      upstreamBaseUrl: string
      listenHost?: string
      apiKeyEnv?: string
    }
    tasks: Record<MatrixBenchmark, string[]>
    swebench: NonNullable<MatrixRunRequest["swebench"]>
    tbench: NonNullable<MatrixRunRequest["tbench"]>
  }

type CliParseState = {
  request: MatrixRunRequest
  genericTasks: string[]
  swebenchTasks: string[]
  tbenchTasks: string[]
}

export async function main(argv: string[]): Promise<number> {
  try {
    const summary = await runMatrix(parseArgs(argv))
    printSummary(summary)
    return summary.status === "completed" ? 0 : 1
  } catch (error) {
    console.error(stringifyError(error))
    return 1
  }
}

export async function runMatrix(
  request: MatrixRunRequest,
  runner: MatrixCommandRunner = runCommand,
): Promise<MatrixSummary> {
  const startedAt = new Date()
  const startedMs = Date.now()
  const plan = await createMatrixPlan(request)
  await mkdir(plan.reportDir, { recursive: true })

  const planPath = join(plan.reportDir, "plan.json")
  const jobsPath = join(plan.reportDir, "jobs.jsonl")
  await writeJson(planPath, plan)

  const jobs = await runJobsWithConcurrency(plan.jobs, plan.concurrency, (job) => runMatrixJob(job, runner))
  await writeFile(jobsPath, `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`, "utf8")

  const failed = jobs.filter((job) => job.status === "failed").length
  const summary: MatrixSummary = {
    schemaVersion: EVAL_MATRIX_RUN_SCHEMA_VERSION,
    status: failed === 0 ? "completed" : "failed",
    mode: plan.mode,
    runId: plan.runId,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    reportDir: plan.reportDir,
    workDir: plan.workDir,
    planPath,
    jobsPath,
    concurrency: plan.concurrency,
    model: plan.model,
    totals: {
      jobs: jobs.length,
      completed: jobs.length - failed,
      failed,
      draftJobs: plan.totals.draftJobs,
    },
    jobs,
    warnings: plan.warnings,
  }
  await writeJson(join(plan.reportDir, "summary.json"), summary)
  return summary
}

export async function createMatrixPlan(request: MatrixRunRequest): Promise<MatrixPlan> {
  const options = normalizeRequest(request)
  const adapters = await Promise.all(options.coders.map((coder) => loadCoderAdapter(coder)))
  const warnings: string[] = []
  const jobs: MatrixJob[] = []
  let index = 0

  for (let coderIndex = 0; coderIndex < adapters.length; coderIndex++) {
    const adapter = adapters[coderIndex]
    const coderRef = options.coders[coderIndex] ?? adapter.id
    validateAdapter(adapter, options, warnings)

    for (const benchmark of options.benchmarks) {
      for (const taskId of options.tasks[benchmark]) {
        index += 1
        jobs.push(buildJob({ index, adapter, coderRef, benchmark, taskId, options }))
      }
    }
  }

  if (jobs.length > options.maxJobs) {
    throw new Error(`Refusing to schedule ${jobs.length} matrix jobs without increasing --max-jobs`)
  }
  if (options.mode === "run" && jobs.length > 5 && !options.allowLargeRun) {
    throw new Error("Refusing to run more than 5 matrix jobs without --allow-large-run")
  }

  return {
    schemaVersion: EVAL_MATRIX_RUN_SCHEMA_VERSION,
    mode: options.mode,
    runId: options.runId,
    createdAt: new Date().toISOString(),
    reportDir: options.reportDir,
    workDir: options.workDir,
    concurrency: options.concurrency,
    model: options.model,
    totals: {
      coders: adapters.length,
      benchmarks: options.benchmarks.length,
      tasks: options.benchmarks.reduce((total, benchmark) => total + options.tasks[benchmark].length, 0),
      jobs: jobs.length,
      draftJobs: jobs.filter((job) => job.coderStatus === "draft").length,
    },
    jobs,
    warnings,
    profileCoders: options.profileCoders,
  }
}

export async function runJobsWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("concurrency must be a positive integer")
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    }),
  )

  return results
}

function parseArgs(argv: string[]): MatrixRunRequest {
  const state: CliParseState = {
    request: {
      coders: [],
      benchmarks: [],
      mode: "dry-run",
      model: DEFAULT_EVAL_MODEL,
      concurrency: 1,
      allowDraftReal: false,
      swebench: { extraArgs: [] },
      tbench: { extraArgs: [] },
    },
    genericTasks: [],
    swebenchTasks: [],
    tbenchTasks: [],
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--run-id") state.request.runId = requireValue(argv, ++index, arg)
    else if (arg === "--report-dir") state.request.reportDir = requireValue(argv, ++index, arg)
    else if (arg === "--work-dir") state.request.workDir = requireValue(argv, ++index, arg)
    else if (arg === "--coder") state.request.coders?.push(requireValue(argv, ++index, arg))
    else if (arg === "--benchmark") state.request.benchmarks?.push(parseBenchmark(requireValue(argv, ++index, arg)))
    else if (arg === "--task") state.genericTasks.push(requireValue(argv, ++index, arg))
    else if (arg === "--swebench-task" || arg === "--swebench-instance") state.swebenchTasks.push(requireValue(argv, ++index, arg))
    else if (arg === "--tbench-task" || arg === "--terminal-bench-task") state.tbenchTasks.push(requireValue(argv, ++index, arg))
    else if (arg === "--concurrency") state.request.concurrency = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--dry-run") state.request.mode = "dry-run"
    else if (arg === "--run") state.request.mode = "run"
    else if (arg === "--allow-draft-real") state.request.allowDraftReal = true
    else if (arg === "--model") state.request.model = requireValue(argv, ++index, arg)
    else if (arg === "--base-url") state.request.baseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") state.request.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--env-file") state.request.envFile = requireValue(argv, ++index, arg)
    else if (arg === "--provider-proxy-upstream-base-url" || arg === "--provider-proxy-upstream")
      state.request.providerProxy = { ...(state.request.providerProxy ?? {}), upstreamBaseUrl: requireValue(argv, ++index, arg) }
    else if (arg === "--provider-proxy-listen-host")
      state.request.providerProxy = { ...(state.request.providerProxy ?? {}), listenHost: requireValue(argv, ++index, arg) }
    else if (arg === "--provider-proxy-api-key-env")
      state.request.providerProxy = { ...(state.request.providerProxy ?? {}), apiKeyEnv: requireValue(argv, ++index, arg) }
    else if (arg === "--max-steps") state.request.maxSteps = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--permission-mode") state.request.permissionMode = parsePermissionMode(requireValue(argv, ++index, arg))
    else if (arg === "--allow-large-run") state.request.allowLargeRun = true
    else if (arg === "--max-jobs") state.request.maxJobs = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--profile-coder") {
      state.request.profileCoders = [...(state.request.profileCoders ?? []), requireValue(argv, ++index, arg)]
    }
    else if (arg === "--swebench-profile") state.request.swebench = { ...state.request.swebench, profile: parseSwebenchProfile(requireValue(argv, ++index, arg)) }
    else if (arg === "--swebench-instances-file" || arg === "--instances-file")
      state.request.swebench = { ...state.request.swebench, instancesFile: requireValue(argv, ++index, arg) }
    else if (arg === "--swebench-taskset-file")
      state.request.swebench = { ...state.request.swebench, tasksetFile: requireValue(argv, ++index, arg) }
    else if (arg === "--swebench-python") state.request.swebench = { ...state.request.swebench, python: requireValue(argv, ++index, arg) }
    else if (arg === "--keep-workspaces") state.request.swebench = { ...state.request.swebench, keepWorkspaces: true }
    else if (arg === "--swebench-extra-arg")
      state.request.swebench = {
        ...state.request.swebench,
        extraArgs: [...(state.request.swebench?.extraArgs ?? []), requireValue(argv, ++index, arg)],
      }
    else if (arg === "--tbench-dataset") state.request.tbench = { ...state.request.tbench, dataset: requireValue(argv, ++index, arg) }
    else if (arg === "--tbench-harbor" || arg === "--harbor")
      state.request.tbench = { ...state.request.tbench, harbor: requireValue(argv, ++index, arg) }
    else if (arg === "--tbench-attempts")
      state.request.tbench = { ...state.request.tbench, attempts: parsePositiveInteger(requireValue(argv, ++index, arg), arg) }
    else if (arg === "--tbench-extra-arg")
      state.request.tbench = {
        ...state.request.tbench,
        extraArgs: [...(state.request.tbench?.extraArgs ?? []), requireValue(argv, ++index, arg)],
      }
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }

  state.request.genericTasks = state.genericTasks
  state.request.tasks = {
    swebench: state.swebenchTasks,
    "terminal-bench": state.tbenchTasks,
  }
  return state.request
}

function normalizeRequest(request: MatrixRunRequest): ResolvedMatrixRunRequest {
  const runId = request.runId ?? defaultRunId()
  const reportDir = resolve(request.reportDir ?? join(process.cwd(), ".light-cc", "evals", runId, "matrix"))
  const workDir = resolve(request.workDir ?? join(reportDir, "work"))
  const coders = unique(request.coders && request.coders.length > 0 ? request.coders : ["lightcc"])
  const genericTasks = request.genericTasks ?? []
  const tasksetTasks = readSwebenchTasksetIds(request.swebench?.tasksetFile)
  const requestedTasks: Record<MatrixBenchmark, string[]> = {
    swebench: unique([...(request.tasks?.swebench ?? []), ...tasksetTasks]),
    "terminal-bench": unique(request.tasks?.["terminal-bench"] ?? []),
  }
  const benchmarks = unique(
    request.benchmarks && request.benchmarks.length > 0 ? request.benchmarks : inferBenchmarks(requestedTasks, genericTasks),
  )
  const tasks: Record<MatrixBenchmark, string[]> = {
    swebench: benchmarks.includes("swebench") ? unique([...requestedTasks.swebench, ...genericTasks]) : requestedTasks.swebench,
    "terminal-bench": benchmarks.includes("terminal-bench")
      ? unique([...requestedTasks["terminal-bench"], ...genericTasks])
      : requestedTasks["terminal-bench"],
  }

  if (benchmarks.length === 0) throw new Error("At least one benchmark is required")
  for (const benchmark of benchmarks) {
    if (tasks[benchmark].length === 0) {
      throw new Error(`At least one task is required for ${benchmark}`)
    }
  }

  const concurrency = request.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("--concurrency must be a positive integer")
  const maxJobs = request.maxJobs ?? 50
  if (!Number.isInteger(maxJobs) || maxJobs <= 0) throw new Error("--max-jobs must be a positive integer")
  if (request.providerProxy && !request.providerProxy.upstreamBaseUrl) {
    throw new Error("--provider-proxy-upstream-base-url is required when provider proxy options are set")
  }

  return {
    runId,
    reportDir,
    workDir,
    coders,
    benchmarks,
    tasks,
    genericTasks,
    concurrency,
    mode: request.mode ?? "dry-run",
    allowDraftReal: request.allowDraftReal ?? false,
    model: request.model ?? DEFAULT_EVAL_MODEL,
    baseUrl: request.baseUrl,
    apiKeyEnv: request.apiKeyEnv ?? process.env.LIGHT_CC_API_KEY_ENV ?? "OPENAI_API_KEY",
    envFile: request.envFile,
    providerProxy: request.providerProxy?.upstreamBaseUrl
      ? {
          upstreamBaseUrl: request.providerProxy.upstreamBaseUrl,
          listenHost: request.providerProxy.listenHost,
          apiKeyEnv: request.providerProxy.apiKeyEnv,
        }
      : undefined,
    maxSteps: request.maxSteps ?? 80,
    permissionMode: request.permissionMode ?? "danger-full-access",
    allowLargeRun: request.allowLargeRun ?? false,
    maxJobs,
    profileCoders: unique(request.profileCoders ?? []),
    swebench: {
      extraArgs: [],
      ...(request.swebench ?? {}),
      instancesFile: request.swebench?.instancesFile ?? request.swebench?.tasksetFile,
    },
    tbench: {
      extraArgs: [],
      ...(request.tbench ?? {}),
    },
  }
}

function inferBenchmarks(tasks: Record<MatrixBenchmark, string[]>, genericTasks: string[]): MatrixBenchmark[] {
  const benchmarks: MatrixBenchmark[] = []
  if (tasks.swebench.length > 0) benchmarks.push("swebench")
  if (tasks["terminal-bench"].length > 0) benchmarks.push("terminal-bench")
  if (benchmarks.length === 0 && genericTasks.length > 0) benchmarks.push("terminal-bench")
  return benchmarks
}

function validateAdapter(adapter: CoderAdapter, options: ResolvedMatrixRunRequest, warnings: string[]): void {
  for (const benchmark of options.benchmarks) {
    if (!adapter.targets.includes(benchmark)) {
      throw new Error(`Coder adapter ${adapter.id} does not support ${benchmark}`)
    }
  }
  if (options.mode === "run" && adapter.status === "draft") {
    const message = `Coder adapter ${adapter.id} is draft`
    if (!options.allowDraftReal) throw new Error(`${message}; pass --allow-draft-real to attempt a real matrix run`)
    warnings.push(`${message}; real run override enabled`)
  }
}

function buildJob(input: {
  index: number
  adapter: CoderAdapter
  coderRef: string
  benchmark: MatrixBenchmark
  taskId: string
  options: ResolvedMatrixRunRequest
}): MatrixJob {
  const { index, adapter, coderRef, benchmark, taskId, options } = input
  const jobId = buildJobId(index, adapter.id, benchmark, taskId)
  const artifactDir = join(options.reportDir, "jobs", jobId)
  const reportDir = join(artifactDir, "report")
  const workDir = join(options.workDir, jobId)
  const runId = `${sanitizePathSegment(options.runId)}-${jobId}`
  const baseJob = {
    id: jobId,
    index,
    matrixRunId: options.runId,
    runId,
    coderRef,
    coderId: adapter.id,
    coderDisplayName: adapter.displayName,
    coderStatus: adapter.status,
    benchmark,
    taskId,
    model: options.model,
    artifactDir,
    reportDir,
    workDir,
  }
  return {
    ...baseJob,
    command:
      benchmark === "swebench"
        ? buildSwebenchCommand(baseJob, options)
        : buildTerminalBenchCommand(baseJob, options),
  }
}

function buildSwebenchCommand(
  job: Omit<MatrixJob, "command">,
  options: ResolvedMatrixRunRequest,
): MatrixJobCommand {
  const args = [
    process.execPath,
    "run",
    "eval:swebench",
    "--",
    "--coder",
    job.coderRef,
    "--model",
    options.model,
    "--run-id",
    job.runId,
    "--report-dir",
    job.reportDir,
    "--work-dir",
    job.workDir,
    "--instance",
    job.taskId,
    "--max-steps",
    String(options.maxSteps),
    "--permission-mode",
    options.permissionMode,
    options.mode === "run" ? "--run-agent" : "--dry-run",
  ]
  if (options.swebench.profile) args.push("--profile", options.swebench.profile)
  if (options.swebench.instancesFile) args.push("--instances-file", options.swebench.instancesFile)
  if (options.swebench.python) args.push("--python", options.swebench.python)
  if (options.swebench.keepWorkspaces) args.push("--keep-workspaces")
  if (options.baseUrl && !options.providerProxy) args.push("--base-url", options.baseUrl)
  if (options.apiKeyEnv) args.push("--api-key-env", options.apiKeyEnv)
  if (options.profileCoders.includes(job.coderId)) args.push("--agent-profile")
  if (options.allowLargeRun) args.push("--allow-large-run")
  args.push(...(options.swebench.extraArgs ?? []))
  return { args, cwd: process.cwd(), envFile: options.envFile, providerProxy: buildJobProviderProxy(job, options) }
}

function buildTerminalBenchCommand(
  job: Omit<MatrixJob, "command">,
  options: ResolvedMatrixRunRequest,
): MatrixJobCommand {
  const args = [
    process.execPath,
    "run",
    "eval:tbench",
    "--",
    "--coder",
    job.coderRef,
    "--model",
    options.model,
    "--run-id",
    job.runId,
    "--report-dir",
    job.reportDir,
    "--jobs-dir",
    job.workDir,
    "--task",
    job.taskId,
    "--max-steps",
    String(options.maxSteps),
    "--permission-mode",
    options.permissionMode,
    options.mode === "run" ? "--run" : "--dry-run",
  ]
  if (options.tbench.dataset) args.push("--dataset", options.tbench.dataset)
  if (options.tbench.harbor) args.push("--harbor", options.tbench.harbor)
  if (options.tbench.attempts !== undefined) args.push("--attempts", String(options.tbench.attempts))
  if (options.baseUrl && !options.providerProxy) args.push("--base-url", options.baseUrl)
  if (options.apiKeyEnv) args.push("--api-key-env", options.apiKeyEnv)
  if (options.profileCoders.includes(job.coderId)) args.push("--agent-profile")
  if (options.allowLargeRun) args.push("--allow-large-run")
  args.push(...(options.tbench.extraArgs ?? []))
  return { args, cwd: process.cwd(), envFile: options.envFile, providerProxy: buildJobProviderProxy(job, options) }
}

function buildJobProviderProxy(
  job: Omit<MatrixJob, "command">,
  options: ResolvedMatrixRunRequest,
): MatrixJobProviderProxy | undefined {
  if (!options.providerProxy) return undefined
  return {
    activate: options.mode === "run",
    listenHost: options.providerProxy.listenHost ?? "127.0.0.1",
    upstreamBaseUrl: options.providerProxy.upstreamBaseUrl,
    apiKeyEnv: options.providerProxy.apiKeyEnv ?? options.apiKeyEnv,
    model: options.model,
    profilePath: join(job.reportDir, "provider.profile.json"),
  }
}

async function runMatrixJob(job: MatrixJob, runner: MatrixCommandRunner): Promise<MatrixJobResult> {
  const startedAt = new Date()
  const startedMs = Date.now()
  const commandPath = join(job.artifactDir, "command.json")
  const stdoutPath = join(job.artifactDir, "stdout.log")
  const stderrPath = join(job.artifactDir, "stderr.log")
  await mkdir(job.artifactDir, { recursive: true })
  await mkdir(job.workDir, { recursive: true })
  const providerProfilePath = job.command.providerProxy?.profilePath
  let providerProxy: Awaited<ReturnType<typeof startProviderProxy>> | undefined

  try {
    const command = { ...job.command, args: [...job.command.args], env: { ...(job.command.env ?? {}) } }
    if (job.command.providerProxy?.activate) {
      await mkdir(dirname(job.command.providerProxy.profilePath), { recursive: true })
      const proxyPort = await getFreePort(job.command.providerProxy.listenHost)
      providerProxy = await startProviderProxy({
        listenHost: job.command.providerProxy.listenHost,
        port: proxyPort,
        upstreamBaseUrl: job.command.providerProxy.upstreamBaseUrl,
        apiKeyEnv: job.command.providerProxy.apiKeyEnv,
        out: job.command.providerProxy.profilePath,
        model: job.command.providerProxy.model,
      })
      command.args = withBaseUrlArg(command.args, `http://${job.command.providerProxy.listenHost}:${providerProxy.port}`)
    }
    const execution = await runner(command, job)
    if (providerProxy) {
      await providerProxy.stop()
      providerProxy = undefined
    }
    await writeFile(stdoutPath, execution.stdout, "utf8")
    await writeFile(stderrPath, execution.stderr, "utf8")
    await writeJson(commandPath, {
      args: command.args,
      cwd: command.cwd,
      envNames: await commandEnvNames(command),
      providerProfilePath,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      stdoutPath,
      stderrPath,
    })
    return {
      id: job.id,
      index: job.index,
      coderId: job.coderId,
      coderStatus: job.coderStatus,
      benchmark: job.benchmark,
      taskId: job.taskId,
      runId: job.runId,
      reportDir: job.reportDir,
      workDir: job.workDir,
      artifactDir: job.artifactDir,
      status: execution.exitCode === 0 ? "completed" : "failed",
      exitCode: execution.exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      commandPath,
      stdoutPath,
      stderrPath,
      stdoutBytes: Buffer.byteLength(execution.stdout),
      stderrBytes: Buffer.byteLength(execution.stderr),
      providerProfilePath,
      error: execution.exitCode === 0 ? undefined : `command exited ${execution.exitCode}`,
    }
  } catch (error) {
    if (providerProxy) await providerProxy.stop().catch(() => undefined)
    const message = stringifyError(error)
    await writeFile(stdoutPath, "", "utf8")
    await writeFile(stderrPath, `${message}\n`, "utf8")
    await writeJson(commandPath, {
      args: job.command.args,
      cwd: job.command.cwd,
      envNames: await commandEnvNames(job.command),
      providerProfilePath,
      error: message,
      stdoutPath,
      stderrPath,
    })
    return {
      id: job.id,
      index: job.index,
      coderId: job.coderId,
      coderStatus: job.coderStatus,
      benchmark: job.benchmark,
      taskId: job.taskId,
      runId: job.runId,
      reportDir: job.reportDir,
      workDir: job.workDir,
      artifactDir: job.artifactDir,
      status: "failed",
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      commandPath,
      stdoutPath,
      stderrPath,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(message),
      providerProfilePath,
      error: message,
    }
  }
}

function withBaseUrlArg(args: string[], baseUrl: string): string[] {
  const index = args.indexOf("--base-url")
  if (index >= 0) {
    const next = [...args]
    next[index + 1] = baseUrl
    return next
  }
  return [...args, "--base-url", baseUrl]
}

async function getFreePort(host: string): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, host, () => resolveListen())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : undefined
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  if (!port) throw new Error("Failed to allocate provider proxy port")
  return port
}

async function runCommand(command: MatrixJobCommand): Promise<MatrixCommandExecution> {
  const startedMs = Date.now()
  const envFile = command.envFile ? await readEnvFile(command.envFile) : { names: [], values: {} }
  const proc = Bun.spawn(command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...envFile.values, ...(command.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedMs,
  }
}

async function commandEnvNames(command: MatrixJobCommand): Promise<string[]> {
  const envFile = command.envFile ? await readEnvFile(command.envFile) : { names: [], values: {} }
  return [...new Set([...envFile.names, ...Object.keys(command.env ?? {})])].sort()
}

async function readEnvFile(path: string): Promise<{ names: string[]; values: Record<string, string> }> {
  const text = await readFile(path, "utf8")
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf("=")
    if (index <= 0) continue
    const key = trimmed.slice(0, index)
    const value = trimmed.slice(index + 1)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values[key] = value
  }
  return { names: Object.keys(values), values }
}

function buildJobId(index: number, coderId: string, benchmark: MatrixBenchmark, taskId: string): string {
  const prefix = String(index).padStart(3, "0")
  const benchmarkPart = benchmark === "terminal-bench" ? "tbench" : "swebench"
  const taskPart = sanitizePathSegment(taskId).slice(0, 60)
  const hash = createHash("sha256").update(`${coderId}:${benchmark}:${taskId}:${index}`).digest("hex").slice(0, 8)
  return `${prefix}-${sanitizePathSegment(coderId)}-${benchmarkPart}-${taskPart}-${hash}`
}

function parseBenchmark(value: string): MatrixBenchmark {
  if (value === "swebench") return "swebench"
  if (value === "tbench" || value === "terminal-bench") return "terminal-bench"
  throw new Error(`Invalid benchmark: ${value}`)
}

function parseSwebenchProfile(value: string): "lite" | "verified" {
  if (value === "lite" || value === "verified") return value
  throw new Error(`Invalid --swebench-profile: ${value}`)
}

function parsePermissionMode(value: string): MatrixPermissionMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value
  throw new Error(`Invalid --permission-mode: ${value}`)
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function defaultRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")
  const suffix = createHash("sha256").update(`${timestamp}-${Math.random()}`).digest("hex").slice(0, 8)
  return `matrix-${timestamp}-${suffix}`
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function readSwebenchTasksetIds(path: string | undefined): string[] {
  if (!path) return []
  const text = readFileSync(resolve(path), "utf8")
  const trimmed = text.trim()
  if (!trimmed) return []
  const ids: string[] = []
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith("{")) {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid SWE-bench taskset row: ${line}`)
      }
      const record = parsed as Record<string, unknown>
      rejectForbiddenSwebenchTasksetFields(record)
      ids.push(safeInstanceFromRecord(record).instance_id)
    } else {
      ids.push(line)
    }
  }
  return unique(ids)
}

function rejectForbiddenSwebenchTasksetFields(record: Record<string, unknown>): void {
  const forbidden = ["patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "fail_to_pass", "pass_to_pass"]
  const found = forbidden.filter((key) => key in record)
  if (found.length > 0) {
    throw new Error(`SWE-bench taskset row contains evaluator-only fields: ${found.join(", ")}`)
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_")
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function printSummary(summary: MatrixSummary): void {
  console.log(
    `Eval matrix ${summary.mode}: jobs=${summary.totals.jobs} completed=${summary.totals.completed} failed=${summary.totals.failed}`,
  )
  console.log(`Artifacts: ${summary.reportDir}`)
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(): string {
  return [
    "Usage: bun evals/matrix/run.ts --coder lightcc --benchmark tbench --tbench-task <task-id> [--dry-run|--run]",
    "       bun evals/matrix/run.ts --coder lightcc --benchmark swebench --swebench-task <instance-id> --swebench-instances-file <path>",
    "       bun evals/matrix/run.ts --benchmark swebench --swebench-taskset-file <safe-jsonl>",
    "       bun evals/matrix/run.ts --concurrency 2 --allow-draft-real --run ...",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
