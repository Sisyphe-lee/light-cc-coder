#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { validateWrapperProfile } from "../wrapper-profile/validate"

const BENCHMARKS = ["swebench", "terminal-bench"] as const
const FAILURE_TYPES = [
  "model_failure",
  "verifier_flake",
  "harness_failure",
  "timeout",
  "empty_patch",
  "api_or_network_failure",
  "environment_failure",
] as const

type BenchmarkName = (typeof BENCHMARKS)[number]
type FailureType = (typeof FAILURE_TYPES)[number]

type ReportOptions = {
  runId?: string
  evalRoot?: string
  runDir?: string
  outputDir?: string
}

type NormalizedReportOptions = {
  runId: string
  evalRoot: string
  runDir: string
  outputDir: string
}

type JsonRecord = Record<string, unknown>

type ReadResult =
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string }
  | { status: "ok"; path: string; value: unknown }

type WrapperProfileRead = {
  path?: string
  valid: boolean
  warningCount: number
  errors: string[]
}

type ProviderProfileRead = {
  path?: string
  valid: boolean
  warningCount: number
  errors: string[]
}

export type ReportFailure = {
  benchmark: BenchmarkName
  itemId: string
  failureType: FailureType
  status?: string
  reason: string
  artifactDir?: string
}

type BenchmarkCost = {
  benchmark: BenchmarkName
  currency: "USD"
  totalUsd: number | null
  source?: string
  usage?: unknown
}

type BenchmarkProfileReport = {
  itemCount: number
  profiledItemCount: number
  missingProfileItemCount: number
  warningCount: number
  reportPaths: string[]
  topBottlenecks: Array<{ category: string; count: number }>
  provider: {
    callCount: number
    totalDurationMs: number
    inputTokens: number | null
    outputTokens: number | null
    cacheReadInputTokens: number | null
  }
  context: {
    assembleCount: number
    totalDurationMs: number
    maxEstimatedTokens: number | null
  }
  runtime: {
    bashCount: number
    nonzeroExitCount: number
  }
  transcriptWrite: {
    writeCount: number
    totalDurationMs: number | null
  }
}

type ProfileCoverageBucket = {
  coveredItems: number
  missingItems: number
  coveragePct: number
  invalidItems: number
  warningCount: number
  paths: string[]
}

type BenchmarkProfileCoverage = {
  itemCount: number
  wrapper: ProfileCoverageBucket
  internal: ProfileCoverageBucket
  provider: ProfileCoverageBucket
}

type BenchmarkReport = {
  benchmark: BenchmarkName
  status: "ok" | "missing" | "input_error"
  summaryPath: string
  readError?: string
  coder?: JsonRecord
  mode?: JsonRecord
  totals: {
    selected: number
    prepared: number
    completed: number
    failed: number
    skipped: number
  }
  cost: BenchmarkCost
  profile?: BenchmarkProfileReport
  profileCoverage: BenchmarkProfileCoverage
  matrix?: MatrixBenchmarkReport
  failures: ReportFailure[]
  notes: string[]
}

type MatrixBenchmarkReport = {
  runId: string
  jobCount: number
  taskCount: number
  coderCount: number
  coders: MatrixCoderReport[]
}

type MatrixCoderReport = {
  coderId: string
  selected: number
  completed: number
  failed: number
  skipped: number
  profileCoverage: BenchmarkProfileCoverage
}

type UnifiedReport = {
  schemaVersion: 1
  runId: string
  generatedAt: string
  evalRoot: string
  runDir: string
  reportDir: string
  totals: {
    benchmarksPresent: number
    benchmarksMissing: number
    selected: number
    prepared: number
    completed: number
    failed: number
    skipped: number
    failureRecords: number
    knownCostUsd: number | null
    profiledItems: number
    missingProfileItems: number
    profileCoverage: BenchmarkProfileCoverage
  }
  benchmarks: BenchmarkReport[]
  failures: ReportFailure[]
}

type CostReport = {
  schemaVersion: 1
  runId: string
  generatedAt: string
  currency: "USD"
  totalUsd: number | null
  benchmarks: BenchmarkCost[]
}

export async function main(argv: string[]): Promise<number> {
  let options: NormalizedReportOptions
  try {
    options = normalizeOptions(parseArgs(argv))
  } catch (error) {
    console.error(stringifyError(error))
    return 2
  }

  const result = await generateUnifiedReport(options)
  await writeReportFiles(options.outputDir, result.report, result.cost)
  printReport(result.report)
  return result.hadInputError ? 1 : 0
}

export async function generateUnifiedReport(
  options: NormalizedReportOptions,
): Promise<{ report: UnifiedReport; cost: CostReport; hadInputError: boolean }> {
  const generatedAt = new Date().toISOString()
  const benchmarks = await Promise.all(BENCHMARKS.map((benchmark) => readBenchmarkReport(benchmark, options.runDir)))
  const failures = benchmarks.flatMap((benchmark) => benchmark.failures)
  const knownCosts = benchmarks
    .map((benchmark) => benchmark.cost.totalUsd)
    .filter((cost): cost is number => typeof cost === "number")
  const knownCostUsd = knownCosts.length > 0 ? roundUsd(knownCosts.reduce((sum, cost) => sum + cost, 0)) : null
  const profileCoverage = aggregateBenchmarkCoverage(benchmarks.map((benchmark) => benchmark.profileCoverage))
  const report: UnifiedReport = {
    schemaVersion: 1,
    runId: options.runId,
    generatedAt,
    evalRoot: options.evalRoot,
    runDir: options.runDir,
    reportDir: options.outputDir,
    totals: {
      benchmarksPresent: benchmarks.filter((benchmark) => benchmark.status === "ok").length,
      benchmarksMissing: benchmarks.filter((benchmark) => benchmark.status === "missing").length,
      selected: sumTotals(benchmarks, "selected"),
      prepared: sumTotals(benchmarks, "prepared"),
      completed: sumTotals(benchmarks, "completed"),
      failed: sumTotals(benchmarks, "failed"),
      skipped: sumTotals(benchmarks, "skipped"),
      failureRecords: failures.length,
      knownCostUsd,
      profiledItems: benchmarks.reduce((sum, benchmark) => sum + (benchmark.profile?.profiledItemCount ?? 0), 0),
      missingProfileItems: benchmarks.reduce((sum, benchmark) => sum + (benchmark.profile?.missingProfileItemCount ?? 0), 0),
      profileCoverage,
    },
    benchmarks,
    failures,
  }
  return {
    report,
    cost: {
      schemaVersion: 1,
      runId: options.runId,
      generatedAt,
      currency: "USD",
      totalUsd: knownCostUsd,
      benchmarks: benchmarks.map((benchmark) => benchmark.cost),
    },
    hadInputError: benchmarks.some((benchmark) => benchmark.status === "input_error"),
  }
}

async function readBenchmarkReport(benchmark: BenchmarkName, runDir: string): Promise<BenchmarkReport> {
  const summaryPath = join(runDir, benchmark, "summary.json")
  const readResult = await readJson(summaryPath)
  if (readResult.status === "missing") {
    const matrixReport = benchmark === "swebench" ? await readMatrixBenchmarkReport(benchmark, runDir) : undefined
    if (matrixReport) return matrixReport
    return emptyBenchmarkReport(benchmark, summaryPath, "missing", [`Missing ${summaryPath}`])
  }
  if (readResult.status === "error") {
    const failure = makeFailure(benchmark, "summary.json", "harness_failure", readResult.error)
    return {
      ...emptyBenchmarkReport(benchmark, summaryPath, "input_error", [readResult.error]),
      readError: readResult.error,
      failures: [failure],
    }
  }

  const summary = asRecord(readResult.value)
  if (!summary) {
    const reason = "summary.json did not contain a JSON object"
    return {
      ...emptyBenchmarkReport(benchmark, summaryPath, "input_error", [reason]),
      readError: reason,
      failures: [makeFailure(benchmark, "summary.json", "harness_failure", reason)],
    }
  }

  return benchmark === "swebench"
    ? analyzeSweBench(summary, summaryPath)
    : analyzeTerminalBench(summary, summaryPath)
}

async function readMatrixBenchmarkReport(benchmark: BenchmarkName, runDir: string): Promise<BenchmarkReport | undefined> {
  const matrixSummaryPath = join(runDir, "summary.json")
  const matrixRead = await readJson(matrixSummaryPath)
  if (matrixRead.status !== "ok") return undefined
  const matrixSummary = asRecord(matrixRead.value)
  if (!matrixSummary || numberValue(matrixSummary, "schemaVersion") !== 1) return undefined
  const jobs = arrayRecords(matrixSummary.jobs).filter((job) => stringValue(job, "benchmark") === benchmark)
  if (jobs.length === 0) return undefined

  const collected: Array<{ job: JsonRecord; summary: JsonRecord; summaryPath: string }> = []
  for (const job of jobs) {
    const reportDir = stringValue(job, "reportDir")
    const summaryPath = reportDir ? join(resolvePathRelativeToSummary(matrixSummaryPath, reportDir), "summary.json") : ""
    const summaryRead = summaryPath ? await readJson(summaryPath) : { status: "missing" as const, path: "summary.json" }
    if (summaryRead.status === "ok") {
      const summary = asRecord(summaryRead.value)
      if (summary) {
        collected.push({ job, summary, summaryPath })
        continue
      }
    }
    collected.push({ job, summary: synthesizeMissingMatrixJobSummary(job, summaryRead), summaryPath: summaryRead.path })
  }

  const synthetic = await mergeMatrixSweBenchSummaries(matrixSummary, jobs, collected, matrixSummaryPath)
  const report = await analyzeSweBench(synthetic.summary, matrixSummaryPath)
  return {
    ...report,
    summaryPath: matrixSummaryPath,
    coder: {
      id: "matrix",
      status: stringValue(matrixSummary, "status") ?? "unknown",
      displayName: `Matrix (${synthetic.matrix.coderCount} coders)`,
    },
    mode: {
      matrix: true,
      runMode: stringValue(matrixSummary, "mode"),
    },
    matrix: synthetic.matrix,
  }
}

async function analyzeSweBench(summary: JsonRecord, summaryPath: string): Promise<BenchmarkReport> {
  const results = arrayRecords(summary.results)
  const checks = arrayRecords(summary.checks)
  const mode = recordValue(summary, "mode")
  const dryRun = booleanValue(mode, "dryRun") === true
  const failures: ReportFailure[] = []

  for (const result of results) {
    const itemId = stringValue(result, "instanceId") ?? stringValue(result, "instance_id") ?? "unknown-instance"
    const status = stringValue(result, "status")
    const reason = stringValue(result, "error") ?? statusReason(status)
    const emptyPatch = hasEmptyPatch(result)
    const isFailure =
      status === "failed" ||
      status === "skipped" ||
      (!dryRun && status === "prepared") ||
      (!dryRun && status === "completed" && emptyPatch)
    if (!isFailure) continue
    failures.push(
      makeFailure(
        "swebench",
        itemId,
        classifyFailure({ status, reason, emptyPatch, benchmark: "swebench" }),
        emptyPatch && !stringValue(result, "error") ? "empty patch" : reason,
        status,
        stringValue(result, "artifactDir"),
      ),
    )
  }

  for (const check of checks.filter((check) => stringValue(check, "status") === "fail")) {
    const itemId = stringValue(check, "name") ?? "preflight"
    const reason = stringValue(check, "detail") ?? "preflight check failed"
    failures.push(makeFailure("swebench", itemId, classifyFailure({ reason, status: "failed", benchmark: "swebench" }), reason, "failed"))
  }

  const summaryStatus = stringValue(summary, "status")
  const summaryError = stringValue(summary, "error")
  if (summaryStatus === "failed" && failures.length === 0) {
    const reason = summaryError ?? "SWE-bench run failed"
    failures.push(makeFailure("swebench", "run", classifyFailure({ reason, status: summaryStatus, benchmark: "swebench" }), reason, summaryStatus))
  }

  const internalProfiles = results.map((result) => recordValue(result, "profile")).filter((profile): profile is JsonRecord => Boolean(profile))
  const wrapperProfiles = await collectWrapperProfiles({
    summaryPath,
    summary,
    itemRecords: results,
    artifactDirs: results.map((result) => stringValue(result, "artifactDir")).filter((path): path is string => Boolean(path)),
    scanRoots: [],
  })
  const providerProfiles = await collectProviderProfiles({
    summaryPath,
    summary,
    itemRecords: results,
    artifactDirs: results.map((result) => stringValue(result, "artifactDir")).filter((path): path is string => Boolean(path)),
    scanRoots: [dirname(summaryPath)],
  })

  return {
    benchmark: "swebench",
    status: "ok",
    summaryPath,
    coder: recordValue(summary, "coder"),
    mode,
    totals: normalizeTotals(recordValue(summary, "totals"), results),
    cost: sweBenchCost(summary),
    profile: aggregateProfiles(internalProfiles, results.length),
    profileCoverage: aggregateProfileCoverage(results.length, wrapperProfiles, internalProfiles, providerProfiles),
    failures,
    notes: [],
  }
}

async function analyzeTerminalBench(summary: JsonRecord, summaryPath: string): Promise<BenchmarkReport> {
  const tasks = arrayRecords(summary.tasks)
  const preflight = arrayRecords(summary.preflight)
  const mode = recordValue(summary, "mode")
  const failures: ReportFailure[] = []

  for (const task of tasks) {
    const itemId = stringValue(task, "taskId") ?? stringValue(task, "task_id") ?? "unknown-task"
    const status = stringValue(task, "status")
    if (status !== "failed" && status !== "skipped") continue
    const reason = stringValue(task, "error") ?? statusReason(status)
    failures.push(
      makeFailure(
        "terminal-bench",
        itemId,
        classifyFailure({ status, reason, benchmark: "terminal-bench" }),
        reason,
        status,
        stringValue(task, "artifactDir"),
      ),
    )
  }

  for (const check of preflight.filter((check) => stringValue(check, "status") === "fail")) {
    const itemId = stringValue(check, "name") ?? "preflight"
    const reason = stringValue(check, "detail") ?? "preflight check failed"
    failures.push(
      makeFailure("terminal-bench", itemId, classifyFailure({ reason, status: "failed", benchmark: "terminal-bench" }), reason, "failed"),
    )
  }

  const harbor = recordValue(summary, "harbor")
  const harborExitCode = numberValue(harbor, "exitCode")
  if (harborExitCode !== undefined && harborExitCode !== 0) {
    const reason = `Harbor exited ${harborExitCode}`
    failures.push(
      makeFailure("terminal-bench", "harbor", classifyFailure({ reason, status: "failed", benchmark: "terminal-bench" }), reason, "failed"),
    )
  }

  const harborJob = recordValue(summary, "harborJob")
  const erroredTrials = numberValue(harborJob, "nErroredTrials")
  const cancelledTrials = numberValue(harborJob, "nCancelledTrials")
  const runningTrials = numberValue(harborJob, "nRunningTrials")
  const pendingTrials = numberValue(harborJob, "nPendingTrials")
  const totalTrials = numberValue(harborJob, "nTotalTrials")
  const completedTrials = numberValue(harborJob, "nCompletedTrials")
  const hasTrialLifecycleFailure =
    (erroredTrials ?? 0) > 0 ||
    (cancelledTrials ?? 0) > 0 ||
    (runningTrials ?? 0) > 0 ||
    (pendingTrials ?? 0) > 0 ||
    (totalTrials !== undefined && completedTrials !== undefined && completedTrials < totalTrials)
  if (hasTrialLifecycleFailure) {
    const reason = `Harbor trial lifecycle incomplete or errored: completed=${completedTrials ?? "unknown"}/${totalTrials ?? "unknown"}, errored=${erroredTrials ?? 0}, cancelled=${cancelledTrials ?? 0}, running=${runningTrials ?? 0}, pending=${pendingTrials ?? 0}`
    failures.push(
      makeFailure("terminal-bench", "harbor-job", classifyFailure({ reason, status: "failed", benchmark: "terminal-bench" }), reason, "failed"),
    )
  }

  const meanReward = numberValue(harborJob, "meanReward")
  if (!hasTrialLifecycleFailure && meanReward !== undefined && meanReward < 1) {
    const reason = `Terminal-Bench mean reward ${meanReward}`
    failures.push(
      makeFailure(
        "terminal-bench",
        "harbor-job",
        classifyFailure({ reason, status: "failed", benchmark: "terminal-bench" }),
        reason,
        "failed",
      ),
    )
  }

  const internalProfiles = arrayRecords(summary.profileReports)
  const jobsDir = stringValue(summary, "jobsDir")
  const wrapperProfiles = await collectWrapperProfiles({
    summaryPath,
    summary,
    itemRecords: tasks,
    artifactDirs: tasks.map((task) => stringValue(task, "artifactDir")).filter((path): path is string => Boolean(path)),
    scanRoots: jobsDir ? [resolvePathRelativeToSummary(summaryPath, jobsDir)] : [],
  })
  const providerProfiles = await collectProviderProfiles({
    summaryPath,
    summary,
    itemRecords: tasks,
    artifactDirs: tasks.map((task) => stringValue(task, "artifactDir")).filter((path): path is string => Boolean(path)),
    scanRoots: [dirname(summaryPath), ...(jobsDir ? [resolvePathRelativeToSummary(summaryPath, jobsDir)] : [])],
  })

  return {
    benchmark: "terminal-bench",
    status: "ok",
    summaryPath,
    coder: recordValue(summary, "coder"),
    mode,
    totals: normalizeTotals(recordValue(summary, "totals"), tasks),
    cost: terminalBenchCost(summary),
    profile: aggregateProfiles(internalProfiles, tasks.length),
    profileCoverage: aggregateProfileCoverage(tasks.length, wrapperProfiles, internalProfiles, providerProfiles),
    failures,
    notes: [],
  }
}

function synthesizeMissingMatrixJobSummary(job: JsonRecord, readResult: ReadResult): JsonRecord {
  const taskId = stringValue(job, "taskId") ?? "unknown-instance"
  const artifactDir = stringValue(job, "artifactDir")
  const reason = readResult.status === "error" ? readResult.error : `Missing ${readResult.path}`
  return {
    runId: stringValue(job, "runId"),
    status: "failed",
    mode: { matrix: true },
    coder: {
      id: stringValue(job, "coderId") ?? "unknown-coder",
      status: stringValue(job, "coderStatus"),
    },
    totals: {
      selected: 1,
      prepared: 0,
      completed: 0,
      failed: 1,
      skipped: 0,
    },
    results: [
      {
        instanceId: taskId,
        status: "failed",
        artifactDir,
        prediction: { model_patch: "" },
        error: reason,
      },
    ],
    error: reason,
  }
}

async function mergeMatrixSweBenchSummaries(
  matrixSummary: JsonRecord,
  jobs: JsonRecord[],
  collected: Array<{ job: JsonRecord; summary: JsonRecord; summaryPath: string }>,
  matrixSummaryPath: string,
): Promise<{ summary: JsonRecord; matrix: MatrixBenchmarkReport }> {
  const results = collected.flatMap(({ job, summary }) =>
    normalizedMatrixResults(job, summary).map((result) => ({
      ...result,
      matrixCoderId: stringValue(job, "coderId"),
      matrixJobId: stringValue(job, "id"),
    })),
  )
  const providerProfilePaths = jobs
    .map((job) => stringValue(job, "providerProfilePath"))
    .filter((path): path is string => Boolean(path))
  const costTotalUsd = nullableRoundUsd(
    collected
      .map(({ summary }) => numberValue(recordValue(summary, "cost"), "totalUsd"))
      .filter((value): value is number => typeof value === "number")
      .reduce((sum, value) => sum + value, 0),
    collected.some(({ summary }) => numberValue(recordValue(summary, "cost"), "totalUsd") !== undefined),
  )
  const syntheticSummary: JsonRecord = {
    runId: stringValue(matrixSummary, "runId"),
    status: stringValue(matrixSummary, "status") ?? "completed",
    mode: { matrix: true, runMode: stringValue(matrixSummary, "mode") },
    coder: {
      id: "matrix",
      status: stringValue(matrixSummary, "status") ?? "unknown",
    },
    totals: sumMatrixTotals(collected.map((entry) => entry.summary), results),
    results,
    cost: costTotalUsd === null ? undefined : { currency: "USD", totalUsd: costTotalUsd },
    providerProfilePaths,
  }
  return {
    summary: syntheticSummary,
    matrix: {
      runId: stringValue(matrixSummary, "runId") ?? basename(dirname(matrixSummaryPath)),
      jobCount: jobs.length,
      taskCount: new Set(jobs.map((job) => stringValue(job, "taskId")).filter((task): task is string => Boolean(task))).size,
      coderCount: new Set(jobs.map((job) => stringValue(job, "coderId")).filter((coder): coder is string => Boolean(coder))).size,
      coders: await buildMatrixCoderReports(collected, matrixSummaryPath),
    },
  }
}

function normalizedMatrixResults(job: JsonRecord, summary: JsonRecord): JsonRecord[] {
  const results = arrayRecords(summary.results)
  if (results.length > 0) return results
  return [
    {
      instanceId: stringValue(job, "taskId") ?? "unknown-instance",
      status: stringValue(job, "status") === "completed" ? "completed" : "failed",
      artifactDir: stringValue(job, "artifactDir"),
      prediction: { model_patch: "" },
      error: stringValue(job, "error"),
    },
  ]
}

function sumMatrixTotals(summaries: JsonRecord[], results: JsonRecord[]): BenchmarkReport["totals"] {
  const totals = summaries.map((summary) => recordValue(summary, "totals")).filter((total): total is JsonRecord => Boolean(total))
  if (totals.length === 0) return normalizeTotals(undefined, results)
  return {
    selected: totals.reduce((sum, total) => sum + (numberValue(total, "selected") ?? 0), 0),
    prepared: totals.reduce((sum, total) => sum + (numberValue(total, "prepared") ?? 0), 0),
    completed: totals.reduce((sum, total) => sum + (numberValue(total, "completed") ?? 0), 0),
    failed: totals.reduce((sum, total) => sum + (numberValue(total, "failed") ?? 0), 0),
    skipped: totals.reduce((sum, total) => sum + (numberValue(total, "skipped") ?? 0), 0),
  }
}

async function buildMatrixCoderReports(
  collected: Array<{ job: JsonRecord; summary: JsonRecord; summaryPath: string }>,
  matrixSummaryPath: string,
): Promise<MatrixCoderReport[]> {
  const byCoder = new Map<string, Array<{ job: JsonRecord; summary: JsonRecord; summaryPath: string }>>()
  for (const entry of collected) {
    const coderId = stringValue(entry.job, "coderId") ?? stringValue(recordValue(entry.summary, "coder"), "id") ?? "unknown-coder"
    byCoder.set(coderId, [...(byCoder.get(coderId) ?? []), entry])
  }

  const reports: MatrixCoderReport[] = []
  for (const [coderId, entries] of [...byCoder.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const results = entries.flatMap((entry) => normalizedMatrixResults(entry.job, entry.summary))
    const syntheticSummary: JsonRecord = {
      runId: stringValue(entries[0]?.summary, "runId"),
      status: "completed",
      mode: { matrix: true },
      totals: sumMatrixTotals(entries.map((entry) => entry.summary), results),
      results,
      providerProfilePaths: entries.map((entry) => stringValue(entry.job, "providerProfilePath")).filter((path): path is string => Boolean(path)),
    }
    const internalProfiles = results.map((result) => recordValue(result, "profile")).filter((profile): profile is JsonRecord => Boolean(profile))
    const wrapperProfiles = await collectWrapperProfiles({
      summaryPath: matrixSummaryPath,
      summary: syntheticSummary,
      itemRecords: results,
      artifactDirs: results.map((result) => stringValue(result, "artifactDir")).filter((path): path is string => Boolean(path)),
      scanRoots: [],
    })
    const providerProfiles = await collectProviderProfiles({
      summaryPath: matrixSummaryPath,
      summary: syntheticSummary,
      itemRecords: results,
      artifactDirs: results.map((result) => stringValue(result, "artifactDir")).filter((path): path is string => Boolean(path)),
      scanRoots: [],
    })
    const totals = normalizeTotals(recordValue(syntheticSummary, "totals"), results)
    reports.push({
      coderId,
      selected: totals.selected,
      completed: totals.completed,
      failed: totals.failed,
      skipped: totals.skipped,
      profileCoverage: aggregateProfileCoverage(results.length, wrapperProfiles, internalProfiles, providerProfiles),
    })
  }
  return reports
}

function emptyBenchmarkReport(
  benchmark: BenchmarkName,
  summaryPath: string,
  status: "missing" | "input_error",
  notes: string[],
): BenchmarkReport {
  return {
    benchmark,
    status,
    summaryPath,
    totals: {
      selected: 0,
      prepared: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    },
    cost: {
      benchmark,
      currency: "USD",
      totalUsd: null,
    },
    profileCoverage: emptyProfileCoverage(0),
    failures: [],
    notes,
  }
}

function normalizeTotals(totals: JsonRecord | undefined, items: JsonRecord[]): BenchmarkReport["totals"] {
  return {
    selected: numberValue(totals, "selected") ?? items.length,
    prepared: numberValue(totals, "prepared") ?? countStatus(items, "prepared"),
    completed: numberValue(totals, "completed") ?? countStatus(items, "completed"),
    failed: numberValue(totals, "failed") ?? countStatus(items, "failed"),
    skipped: numberValue(totals, "skipped") ?? countStatus(items, "skipped"),
  }
}

function sweBenchCost(summary: JsonRecord): BenchmarkCost {
  const cost = recordValue(summary, "cost")
  const resultCosts = arrayRecords(summary.results)
    .map((result) => numberValue(recordValue(result, "cost"), "totalUsd"))
    .filter((value): value is number => typeof value === "number")
  const totalUsd =
    numberValue(cost, "totalUsd") ??
    (resultCosts.length > 0 ? roundUsd(resultCosts.reduce((sum, value) => sum + value, 0)) : null)
  return {
    benchmark: "swebench",
    currency: "USD",
    totalUsd,
    source: stringValue(recordValue(cost, "pricing"), "source"),
    usage: summary.usage,
  }
}

function terminalBenchCost(summary: JsonRecord): BenchmarkCost {
  const harborJob = recordValue(summary, "harborJob")
  return {
    benchmark: "terminal-bench",
    currency: "USD",
    totalUsd: numberValue(harborJob, "costUsd") ?? numberValue(recordValue(summary, "cost"), "totalUsd") ?? null,
    source: harborJob ? "Terminal-Bench Harbor result.json cost_usd" : undefined,
  }
}

function aggregateProfiles(profiles: JsonRecord[], itemCount: number): BenchmarkProfileReport | undefined {
  if (profiles.length === 0 && itemCount === 0) return undefined
  const reportPaths = profiles.map((profile) => stringValue(profile, "reportPath")).filter((value): value is string => Boolean(value))
  const topBottleneckCounts = new Map<string, number>()
  let warningCount = 0
  for (const profile of profiles) {
    const bottleneck = stringValue(profile, "topBottleneck")
    if (bottleneck) topBottleneckCounts.set(bottleneck, (topBottleneckCounts.get(bottleneck) ?? 0) + 1)
    const warnings = Array.isArray(profile.warnings) ? profile.warnings : []
    warningCount += warnings.length
  }
  return {
    itemCount,
    profiledItemCount: profiles.length,
    missingProfileItemCount: Math.max(0, itemCount - profiles.length),
    warningCount,
    reportPaths,
    topBottlenecks: [...topBottleneckCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)),
    provider: {
      callCount: sumNestedNumber(profiles, "provider", "callCount"),
      totalDurationMs: roundMs(sumNestedNumber(profiles, "provider", "totalDurationMs")),
      inputTokens: nullableSumNestedNumber(profiles, "provider", "inputTokens"),
      outputTokens: nullableSumNestedNumber(profiles, "provider", "outputTokens"),
      cacheReadInputTokens: nullableSumNestedNumber(profiles, "provider", "cacheReadInputTokens"),
    },
    context: {
      assembleCount: sumNestedNumber(profiles, "context", "assembleCount"),
      totalDurationMs: roundMs(sumNestedNumber(profiles, "context", "totalDurationMs")),
      maxEstimatedTokens: nullableMaxNestedNumber(profiles, "context", "maxEstimatedTokens"),
    },
    runtime: {
      bashCount: sumNestedNumber(profiles, "runtime", "bashCount"),
      nonzeroExitCount: sumNestedNumber(profiles, "runtime", "nonzeroExitCount"),
    },
    transcriptWrite: {
      writeCount: sumNestedNumber(profiles, "transcriptWrite", "writeCount"),
      totalDurationMs: nullableRoundMs(nullableSumNestedNumber(profiles, "transcriptWrite", "totalDurationMs")),
    },
  }
}

type CollectWrapperProfilesInput = {
  summaryPath: string
  summary: JsonRecord
  itemRecords: JsonRecord[]
  artifactDirs: string[]
  scanRoots: string[]
}

async function collectWrapperProfiles(input: CollectWrapperProfilesInput): Promise<WrapperProfileRead[]> {
  const profiles: WrapperProfileRead[] = []
  const seenPaths = new Set<string>()

  const addProfile = (value: unknown, path?: string) => {
    const validation = validateWrapperProfile(value)
    profiles.push({
      path,
      valid: validation.ok,
      warningCount: arrayStrings(asRecord(value)?.warnings).length,
      errors: validation.errors,
    })
  }

  const addPath = async (path: string, missingIsError: boolean) => {
    const resolved = resolvePathRelativeToSummary(input.summaryPath, path)
    if (seenPaths.has(resolved)) return
    seenPaths.add(resolved)
    const readResult = await readJson(resolved)
    if (readResult.status === "ok") addProfile(readResult.value, resolved)
    else if (missingIsError || readResult.status === "error") {
      profiles.push({
        path: resolved,
        valid: false,
        warningCount: 0,
        errors: [readResult.status === "missing" ? `Missing ${resolved}` : readResult.error],
      })
    }
  }

  for (const profile of arrayRecords(input.summary.wrapperProfiles)) addProfile(profile)
  for (const path of arrayStrings(input.summary.wrapperProfilePaths)) await addPath(path, true)
  const summaryWrapperProfile = recordValue(input.summary, "wrapperProfile")
  if (summaryWrapperProfile) addProfile(summaryWrapperProfile)
  const summaryWrapperProfilePath = stringValue(input.summary, "wrapperProfilePath") ?? stringValue(input.summary, "wrapperProfileJsonPath")
  if (summaryWrapperProfilePath) await addPath(summaryWrapperProfilePath, true)

  for (const item of input.itemRecords) {
    const itemProfile = recordValue(item, "wrapperProfile")
    if (itemProfile) addProfile(itemProfile)
    const itemPath = stringValue(item, "wrapperProfilePath") ?? stringValue(item, "wrapperProfileJsonPath")
    if (itemPath) await addPath(itemPath, true)
  }

  for (const artifactDir of input.artifactDirs) {
    const resolved = resolvePathRelativeToSummary(input.summaryPath, artifactDir)
    await addPath(join(resolved, "wrapper.profile.json"), false)
    await addPath(join(resolved, "agent", "wrapper.profile.json"), false)
  }

  for (const root of input.scanRoots) {
    for (const path of await findWrapperProfileFiles(root)) await addPath(path, false)
  }

  return profiles
}

async function findWrapperProfileFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === "wrapper.profile.json") found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

type CollectProviderProfilesInput = CollectWrapperProfilesInput

async function collectProviderProfiles(input: CollectProviderProfilesInput): Promise<ProviderProfileRead[]> {
  const profiles: ProviderProfileRead[] = []
  const seenPaths = new Set<string>()

  const addProfile = (value: unknown, path?: string) => {
    const validation = validateProviderProfile(value)
    profiles.push({
      path,
      valid: validation.ok,
      warningCount: validation.warningCount,
      errors: validation.errors,
    })
  }

  const addPath = async (path: string, missingIsError: boolean) => {
    const resolved = resolvePathRelativeToSummary(input.summaryPath, path)
    if (seenPaths.has(resolved)) return
    seenPaths.add(resolved)
    const readResult = await readJson(resolved)
    if (readResult.status === "ok") addProfile(readResult.value, resolved)
    else if (missingIsError || readResult.status === "error") {
      profiles.push({
        path: resolved,
        valid: false,
        warningCount: 0,
        errors: [readResult.status === "missing" ? `Missing ${resolved}` : readResult.error],
      })
    }
  }

  for (const profile of arrayRecords(input.summary.providerProfiles)) addProfile(profile)
  for (const path of arrayStrings(input.summary.providerProfilePaths)) await addPath(path, true)
  const summaryProviderProfile = recordValue(input.summary, "providerProfile")
  if (summaryProviderProfile) addProfile(summaryProviderProfile)
  const summaryProviderProfilePath = stringValue(input.summary, "providerProfilePath") ?? stringValue(input.summary, "providerProfileJsonPath")
  if (summaryProviderProfilePath) await addPath(summaryProviderProfilePath, true)

  for (const item of input.itemRecords) {
    const itemProfile = recordValue(item, "providerProfile")
    if (itemProfile) addProfile(itemProfile)
    const itemPath = stringValue(item, "providerProfilePath") ?? stringValue(item, "providerProfileJsonPath")
    if (itemPath) await addPath(itemPath, true)
  }

  for (const artifactDir of input.artifactDirs) {
    const resolved = resolvePathRelativeToSummary(input.summaryPath, artifactDir)
    await addPath(join(resolved, "provider.profile.json"), false)
    await addPath(join(resolved, "agent", "provider.profile.json"), false)
  }

  for (const root of input.scanRoots) {
    for (const path of await findProviderProfileFiles(root)) await addPath(path, false)
  }

  return profiles
}

async function findProviderProfileFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === "provider.profile.json") found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

function validateProviderProfile(value: unknown): { ok: boolean; warningCount: number; errors: string[] } {
  const errors: string[] = []
  const profile = asRecord(value)
  if (!profile) return { ok: false, warningCount: 0, errors: ["$: expected object"] }
  if (profile.schemaVersion !== 1) errors.push("$.schemaVersion: expected 1")
  if (profile.kind !== "metadata-only-provider-proxy") errors.push("$.kind: expected metadata-only-provider-proxy")
  const privacy = recordValue(profile, "privacy")
  if (stringValue(privacy, "prompt") !== "not_recorded") errors.push("$.privacy.prompt: expected not_recorded")
  if (stringValue(privacy, "response") !== "not_recorded") errors.push("$.privacy.response: expected not_recorded")
  if (stringValue(privacy, "apiKey") !== "not_recorded") errors.push("$.privacy.apiKey: expected not_recorded")
  const totals = recordValue(profile, "totals")
  if (!totals) errors.push("$.totals: expected object")
  else if (numberValue(totals, "requestCount") === undefined) errors.push("$.totals.requestCount: expected number")
  const warnings = arrayStrings(profile.warnings)
  return { ok: errors.length === 0, warningCount: warnings.length, errors }
}

function aggregateProfileCoverage(
  itemCount: number,
  wrapperProfiles: WrapperProfileRead[],
  internalProfiles: JsonRecord[],
  providerProfiles: ProviderProfileRead[] = [],
): BenchmarkProfileCoverage {
  const validWrapperProfiles = wrapperProfiles.filter((profile) => profile.valid)
  const validProviderProfiles = providerProfiles.filter((profile) => profile.valid)
  const internalProviderProfiles = internalProfiles.filter(hasProviderCoverage)
  const providerCoveredItems = validProviderProfiles.length > 0 ? validProviderProfiles.length : internalProviderProfiles.length
  const providerWarningCount =
    validProviderProfiles.length > 0
      ? providerProfiles.reduce((sum, profile) => sum + profile.warningCount + profile.errors.length, 0)
      : 0
  const providerPaths =
    validProviderProfiles.length > 0
      ? validProviderProfiles.map((profile) => profile.path).filter((path): path is string => Boolean(path))
      : internalProviderProfiles.map((profile) => stringValue(profile, "reportPath")).filter((path): path is string => Boolean(path))
  return {
    itemCount,
    wrapper: makeCoverageBucket({
      itemCount,
      coveredItems: validWrapperProfiles.length,
      invalidItems: wrapperProfiles.length - validWrapperProfiles.length,
      warningCount: wrapperProfiles.reduce((sum, profile) => sum + profile.warningCount + profile.errors.length, 0),
      paths: validWrapperProfiles.map((profile) => profile.path).filter((path): path is string => Boolean(path)),
    }),
    internal: makeCoverageBucket({
      itemCount,
      coveredItems: internalProfiles.length,
      invalidItems: 0,
      warningCount: internalProfiles.reduce((sum, profile) => sum + arrayStrings(profile.warnings).length, 0),
      paths: internalProfiles.map((profile) => stringValue(profile, "reportPath")).filter((path): path is string => Boolean(path)),
    }),
    provider: makeCoverageBucket({
      itemCount,
      coveredItems: providerCoveredItems,
      invalidItems: providerProfiles.length - validProviderProfiles.length,
      warningCount: providerWarningCount,
      paths: providerPaths,
    }),
  }
}

function aggregateBenchmarkCoverage(coverages: BenchmarkProfileCoverage[]): BenchmarkProfileCoverage {
  const itemCount = coverages.reduce((sum, coverage) => sum + coverage.itemCount, 0)
  return {
    itemCount,
    wrapper: combineCoverageBuckets(itemCount, coverages.map((coverage) => coverage.wrapper)),
    internal: combineCoverageBuckets(itemCount, coverages.map((coverage) => coverage.internal)),
    provider: combineCoverageBuckets(itemCount, coverages.map((coverage) => coverage.provider)),
  }
}

function emptyProfileCoverage(itemCount: number): BenchmarkProfileCoverage {
  return {
    itemCount,
    wrapper: makeCoverageBucket({ itemCount, coveredItems: 0, invalidItems: 0, warningCount: 0, paths: [] }),
    internal: makeCoverageBucket({ itemCount, coveredItems: 0, invalidItems: 0, warningCount: 0, paths: [] }),
    provider: makeCoverageBucket({ itemCount, coveredItems: 0, invalidItems: 0, warningCount: 0, paths: [] }),
  }
}

function combineCoverageBuckets(itemCount: number, buckets: ProfileCoverageBucket[]): ProfileCoverageBucket {
  return makeCoverageBucket({
    itemCount,
    coveredItems: buckets.reduce((sum, bucket) => sum + bucket.coveredItems, 0),
    invalidItems: buckets.reduce((sum, bucket) => sum + bucket.invalidItems, 0),
    warningCount: buckets.reduce((sum, bucket) => sum + bucket.warningCount, 0),
    paths: buckets.flatMap((bucket) => bucket.paths),
  })
}

function makeCoverageBucket(input: {
  itemCount: number
  coveredItems: number
  invalidItems: number
  warningCount: number
  paths: string[]
}): ProfileCoverageBucket {
  const coveredItems = Math.min(input.itemCount, input.coveredItems)
  return {
    coveredItems,
    missingItems: Math.max(0, input.itemCount - coveredItems),
    coveragePct: input.itemCount === 0 ? 0 : Number(((coveredItems / input.itemCount) * 100).toFixed(2)),
    invalidItems: input.invalidItems,
    warningCount: input.warningCount,
    paths: [...new Set(input.paths)].sort(),
  }
}

function hasProviderCoverage(profile: JsonRecord): boolean {
  const provider = recordValue(profile, "provider")
  return (
    (numberValue(provider, "callCount") ?? 0) > 0 ||
    (numberValue(provider, "totalDurationMs") ?? 0) > 0 ||
    numberValue(provider, "inputTokens") !== undefined ||
    numberValue(provider, "outputTokens") !== undefined ||
    numberValue(provider, "cacheReadInputTokens") !== undefined
  )
}

function sumNestedNumber(records: JsonRecord[], objectKey: string, valueKey: string): number {
  return records.reduce((sum, record) => sum + (numberValue(recordValue(record, objectKey), valueKey) ?? 0), 0)
}

function nullableSumNestedNumber(records: JsonRecord[], objectKey: string, valueKey: string): number | null {
  const values = records
    .map((record) => numberValue(recordValue(record, objectKey), valueKey))
    .filter((value): value is number => typeof value === "number")
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null
}

function nullableMaxNestedNumber(records: JsonRecord[], objectKey: string, valueKey: string): number | null {
  const values = records
    .map((record) => numberValue(recordValue(record, objectKey), valueKey))
    .filter((value): value is number => typeof value === "number")
  return values.length > 0 ? Math.max(...values) : null
}

function roundMs(value: number): number {
  return Number(value.toFixed(3))
}

function nullableRoundMs(value: number | null): number | null {
  return value === null ? null : roundMs(value)
}

function classifyFailure(input: {
  benchmark: BenchmarkName
  status?: string
  reason?: string
  emptyPatch?: boolean
}): FailureType {
  const text = `${input.benchmark} ${input.status ?? ""} ${input.reason ?? ""}`.toLowerCase()
  if (/\b(time[ -]?out|timed out|deadline|time limit|etimedout)\b/.test(text)) return "timeout"
  if (/\b(api|network|connection|connect|econn|enotfound|dns|tls|socket|fetch failed|rate limit|429|500|502|503|504|provider)\b/.test(text)) {
    return "api_or_network_failure"
  }
  if (/\b(docker|daemon|disk|workspace preparation|git fetch|git clone|checkout|dependency|package|python|image|mount|environment build)\b/.test(text)) {
    return "environment_failure"
  }
  if (/\b(flake|flaky|nondetermin|verifier retry|verifier flake)\b/.test(text)) return "verifier_flake"
  if (/\b(harness|evaluator|harbor|result\.json|summary\.json|adapter|parse|invalid json)\b/.test(text)) return "harness_failure"
  if (input.emptyPatch || /\b(empty patch|no patch|patch.diff.*0)\b/.test(text)) return "empty_patch"
  return "model_failure"
}

function hasEmptyPatch(result: JsonRecord): boolean {
  const prediction = recordValue(result, "prediction")
  const modelPatch = stringValue(prediction, "model_patch")
  if (modelPatch !== undefined) return modelPatch.length === 0
  const patchBytes = numberValue(result, "patchBytes")
  if (patchBytes !== undefined) return patchBytes === 0
  return booleanValue(result, "emptyPatch") === true
}

function makeFailure(
  benchmark: BenchmarkName,
  itemId: string,
  failureType: FailureType,
  reason: string,
  status?: string,
  artifactDir?: string,
): ReportFailure {
  return {
    benchmark,
    itemId,
    failureType,
    status,
    reason,
    artifactDir,
  }
}

async function writeReportFiles(outputDir: string, report: UnifiedReport, cost: CostReport): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  await writeJson(join(outputDir, "report.json"), report)
  await writeFile(join(outputDir, "report.md"), renderMarkdown(report), "utf8")
  await writeFile(join(outputDir, "report.zh-CN.md"), renderMarkdownZhCN(report), "utf8")
  await writeFile(join(outputDir, "failures.jsonl"), renderFailuresJsonl(report.failures), "utf8")
  await writeJson(join(outputDir, "cost.json"), cost)
}

function renderMarkdown(report: UnifiedReport): string {
  const lines = [
    "# Unified Eval Report",
    "",
    `Run: \`${report.runId}\``,
    `Generated: \`${report.generatedAt}\``,
    `Artifacts: \`${report.runDir}\``,
    "",
    "## Summary",
    "",
    "| Benchmark | Coder | Input | Selected | Completed | Failed | Cost |",
    "|---|---|---:|---:|---:|---:|---:|",
  ]
  for (const benchmark of report.benchmarks) {
    lines.push(
      `| ${benchmark.benchmark} | ${formatCoder(benchmark.coder)} | ${benchmark.status} | ${benchmark.totals.selected} | ${benchmark.totals.completed} | ${benchmark.totals.failed} | ${formatUsd(benchmark.cost.totalUsd)} |`,
    )
  }
  lines.push("", `Known total cost: ${formatUsd(report.totals.knownCostUsd)}`, "")

  lines.push("## Profile Coverage", "")
  lines.push(
    "| Benchmark | Items | Wrapper | Internal | Provider | Invalid wrapper | Warnings |",
    "|---|---:|---:|---:|---:|---:|---:|",
  )
  for (const benchmark of report.benchmarks) {
    lines.push(
      `| ${benchmark.benchmark} | ${benchmark.profileCoverage.itemCount} | ${formatCoverage(benchmark.profileCoverage.wrapper)} | ${formatCoverage(benchmark.profileCoverage.internal)} | ${formatCoverage(benchmark.profileCoverage.provider)} | ${benchmark.profileCoverage.wrapper.invalidItems} | ${profileCoverageWarningCount(benchmark.profileCoverage)} |`,
    )
  }
  lines.push(
    `| total | ${report.totals.profileCoverage.itemCount} | ${formatCoverage(report.totals.profileCoverage.wrapper)} | ${formatCoverage(report.totals.profileCoverage.internal)} | ${formatCoverage(report.totals.profileCoverage.provider)} | ${report.totals.profileCoverage.wrapper.invalidItems} | ${profileCoverageWarningCount(report.totals.profileCoverage)} |`,
    "",
  )

  const missing = report.benchmarks.filter((benchmark) => benchmark.status === "missing")
  if (missing.length > 0) {
    lines.push("## Missing Inputs", "")
    for (const benchmark of missing) lines.push(`- ${benchmark.benchmark}: \`${benchmark.summaryPath}\``)
    lines.push("")
  }

  const profiled = report.benchmarks.filter((benchmark) => benchmark.profile && benchmark.profile.profiledItemCount > 0)
  if (profiled.length > 0) {
    lines.push("## Profiling", "")
    lines.push(
      "| Benchmark | Profiled | Missing | Top bottleneck | Provider calls | Provider ms | Input tokens | Output tokens | Runtime bash | Warnings |",
      "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|",
    )
    for (const benchmark of profiled) {
      const profile = benchmark.profile as BenchmarkProfileReport
      lines.push(
        `| ${benchmark.benchmark} | ${profile.profiledItemCount} | ${profile.missingProfileItemCount} | ${escapeTableCell(formatBottlenecks(profile))} | ${profile.provider.callCount} | ${profile.provider.totalDurationMs.toFixed(1)} | ${formatNullableNumber(profile.provider.inputTokens)} | ${formatNullableNumber(profile.provider.outputTokens)} | ${profile.runtime.bashCount} | ${profile.warningCount} |`,
      )
    }
    lines.push("")
  }

  renderMatrixMarkdown(lines, report, "en")

  lines.push("## Failures", "")
  if (report.failures.length === 0) {
    lines.push("No failure records detected in available summaries.", "")
  } else {
    lines.push("| Benchmark | Item | Type | Reason |", "|---|---|---|---|")
    for (const failure of report.failures) {
      lines.push(`| ${failure.benchmark} | \`${failure.itemId}\` | ${failure.failureType} | ${escapeTableCell(failure.reason)} |`)
    }
    lines.push("")
  }

  return `${lines.join("\n")}\n`
}

function renderMarkdownZhCN(report: UnifiedReport): string {
  const lines = [
    "# 统一评测报告",
    "",
    `运行: \`${report.runId}\``,
    `生成时间: \`${report.generatedAt}\``,
    `Artifacts: \`${report.runDir}\``,
    "",
    "## 摘要",
    "",
    "| Benchmark | Coder | 输入 | 选择 | 完成 | 失败 | 成本 |",
    "|---|---|---:|---:|---:|---:|---:|",
  ]
  for (const benchmark of report.benchmarks) {
    lines.push(
      `| ${benchmark.benchmark} | ${formatCoder(benchmark.coder)} | ${formatBenchmarkStatusZhCN(benchmark.status)} | ${benchmark.totals.selected} | ${benchmark.totals.completed} | ${benchmark.totals.failed} | ${formatUsd(benchmark.cost.totalUsd)} |`,
    )
  }
  lines.push("", `已知总成本: ${formatUsd(report.totals.knownCostUsd)}`, "")

  lines.push("## Profile 覆盖率", "")
  lines.push(
    "| Benchmark | 项目数 | Wrapper | Internal | Provider | 无效 wrapper | 警告 |",
    "|---|---:|---:|---:|---:|---:|---:|",
  )
  for (const benchmark of report.benchmarks) {
    lines.push(
      `| ${benchmark.benchmark} | ${benchmark.profileCoverage.itemCount} | ${formatCoverage(benchmark.profileCoverage.wrapper)} | ${formatCoverage(benchmark.profileCoverage.internal)} | ${formatCoverage(benchmark.profileCoverage.provider)} | ${benchmark.profileCoverage.wrapper.invalidItems} | ${profileCoverageWarningCount(benchmark.profileCoverage)} |`,
    )
  }
  lines.push(
    `| 合计 | ${report.totals.profileCoverage.itemCount} | ${formatCoverage(report.totals.profileCoverage.wrapper)} | ${formatCoverage(report.totals.profileCoverage.internal)} | ${formatCoverage(report.totals.profileCoverage.provider)} | ${report.totals.profileCoverage.wrapper.invalidItems} | ${profileCoverageWarningCount(report.totals.profileCoverage)} |`,
    "",
  )

  const missing = report.benchmarks.filter((benchmark) => benchmark.status === "missing")
  if (missing.length > 0) {
    lines.push("## 缺少输入", "")
    for (const benchmark of missing) lines.push(`- ${benchmark.benchmark}: \`${benchmark.summaryPath}\``)
    lines.push("")
  }

  const profiled = report.benchmarks.filter((benchmark) => benchmark.profile && benchmark.profile.profiledItemCount > 0)
  if (profiled.length > 0) {
    lines.push("## 性能 Profile", "")
    lines.push(
      "| Benchmark | 已采样 | 缺失 | 主要瓶颈 | Provider 调用 | Provider ms | 输入 tokens | 输出 tokens | Bash | 警告 |",
      "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|",
    )
    for (const benchmark of profiled) {
      const profile = benchmark.profile as BenchmarkProfileReport
      lines.push(
        `| ${benchmark.benchmark} | ${profile.profiledItemCount} | ${profile.missingProfileItemCount} | ${escapeTableCell(formatBottlenecks(profile))} | ${profile.provider.callCount} | ${profile.provider.totalDurationMs.toFixed(1)} | ${formatNullableNumber(profile.provider.inputTokens)} | ${formatNullableNumber(profile.provider.outputTokens)} | ${profile.runtime.bashCount} | ${profile.warningCount} |`,
      )
    }
    lines.push("")
  }

  renderMatrixMarkdown(lines, report, "zh-CN")

  lines.push("## 失败", "")
  if (report.failures.length === 0) {
    lines.push("可用 summary 中没有检测到失败记录。", "")
  } else {
    lines.push("| Benchmark | 项目 | 类型 | 原因 |", "|---|---|---|---|")
    for (const failure of report.failures) {
      lines.push(`| ${failure.benchmark} | \`${failure.itemId}\` | ${failure.failureType} | ${escapeTableCell(failure.reason)} |`)
    }
    lines.push("")
  }

  return `${lines.join("\n")}\n`
}

function renderFailuresJsonl(failures: ReportFailure[]): string {
  if (failures.length === 0) return ""
  return `${failures.map((failure) => JSON.stringify(failure)).join("\n")}\n`
}

function renderMatrixMarkdown(lines: string[], report: UnifiedReport, locale: "en" | "zh-CN"): void {
  const matrixBenchmarks = report.benchmarks.filter((benchmark) => benchmark.matrix)
  if (matrixBenchmarks.length === 0) return
  lines.push(locale === "zh-CN" ? "## Matrix 明细" : "## Matrix Details", "")
  for (const benchmark of matrixBenchmarks) {
    const matrix = benchmark.matrix as MatrixBenchmarkReport
    if (locale === "zh-CN") {
      lines.push(
        `- ${benchmark.benchmark}: ${matrix.coderCount} 路 coder，${matrix.taskCount} 个任务，${matrix.jobCount} 个 job。`,
        "",
        "| Coder | 选择 | 完成 | 失败 | 跳过 | Wrapper | Provider | Internal |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
      )
    } else {
      lines.push(
        `- ${benchmark.benchmark}: ${matrix.coderCount} coders, ${matrix.taskCount} tasks, ${matrix.jobCount} jobs.`,
        "",
        "| Coder | Selected | Completed | Failed | Skipped | Wrapper | Provider | Internal |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
      )
    }
    for (const coder of matrix.coders) {
      lines.push(
        `| ${coder.coderId} | ${coder.selected} | ${coder.completed} | ${coder.failed} | ${coder.skipped} | ${formatCoverage(coder.profileCoverage.wrapper)} | ${formatCoverage(coder.profileCoverage.provider)} | ${formatCoverage(coder.profileCoverage.internal)} |`,
      )
    }
    lines.push("")
  }
}

function printReport(report: UnifiedReport): void {
  console.log(
    `Unified report: benchmarks=${report.totals.benchmarksPresent} missing=${report.totals.benchmarksMissing} failures=${report.totals.failureRecords} cost=${formatUsd(report.totals.knownCostUsd)}`,
  )
  console.log(`Artifacts: ${report.reportDir}`)
}

function parseArgs(argv: string[]): ReportOptions {
  const options: ReportOptions = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--run-id") options.runId = requireValue(argv, ++index, arg)
    else if (arg === "--eval-root") options.evalRoot = requireValue(argv, ++index, arg)
    else if (arg === "--run-dir") options.runDir = requireValue(argv, ++index, arg)
    else if (arg === "--output-dir") options.outputDir = requireValue(argv, ++index, arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function normalizeOptions(options: ReportOptions): NormalizedReportOptions {
  const evalRoot = resolve(options.evalRoot ?? join(process.cwd(), ".light-cc", "evals"))
  const runDir = options.runDir ? resolve(options.runDir) : options.runId ? join(evalRoot, options.runId) : undefined
  if (!runDir) throw new Error("Missing --run-id or --run-dir")
  const runId = options.runId ?? basename(runDir)
  return {
    runId,
    evalRoot,
    runDir,
    outputDir: resolve(options.outputDir ?? join(runDir, "report")),
  }
}

function usage(): string {
  return [
    "Usage: bun evals/report/run.ts --run-id <run_id>",
    "       bun evals/report/run.ts --run-dir .light-cc/evals/<run_id>",
    "",
    "Options:",
    "  --eval-root <dir>   Defaults to .light-cc/evals",
    "  --output-dir <dir>  Defaults to <run-dir>/report",
  ].join("\n")
}

async function readJson(path: string): Promise<ReadResult> {
  if (!existsSync(path)) return { status: "missing", path }
  try {
    return { status: "ok", path, value: JSON.parse(await readFile(path, "utf8")) as unknown }
  } catch (error) {
    return { status: "error", path, error: stringifyError(error) }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function recordValue(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return asRecord(record?.[key])
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record): record is JsonRecord => Boolean(record)) : []
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function stringValue(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function numberValue(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === "boolean" ? value : undefined
}

function countStatus(items: JsonRecord[], status: string): number {
  return items.filter((item) => stringValue(item, "status") === status).length
}

function sumTotals(benchmarks: BenchmarkReport[], key: keyof BenchmarkReport["totals"]): number {
  return benchmarks.reduce((sum, benchmark) => sum + benchmark.totals[key], 0)
}

function statusReason(status: string | undefined): string {
  return status ? `status=${status}` : "unknown failure"
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8))
}

function nullableRoundUsd(value: number, hasValue: boolean): number | null {
  return hasValue ? roundUsd(value) : null
}

function resolvePathRelativeToSummary(summaryPath: string, path: string): string {
  return resolve(path.startsWith("/") ? path : join(dirname(summaryPath), path))
}

function formatUsd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`
}

function formatCoder(coder: JsonRecord | undefined): string {
  const id = stringValue(coder, "id")
  const status = stringValue(coder, "status")
  if (!id) return "n/a"
  return status ? `${id} (${status})` : id
}

function formatBottlenecks(profile: BenchmarkProfileReport): string {
  if (profile.topBottlenecks.length === 0) return "n/a"
  return profile.topBottlenecks.map((item) => `${item.category} (${item.count})`).join(", ")
}

function formatCoverage(bucket: ProfileCoverageBucket): string {
  return `${bucket.coveredItems}/${bucket.coveredItems + bucket.missingItems} (${bucket.coveragePct.toFixed(2)}%)`
}

function profileCoverageWarningCount(coverage: BenchmarkProfileCoverage): number {
  return coverage.wrapper.warningCount + coverage.internal.warningCount + coverage.provider.warningCount
}

function formatBenchmarkStatusZhCN(status: BenchmarkReport["status"]): string {
  if (status === "ok") return "ok"
  if (status === "missing") return "缺失"
  return "输入错误"
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "n/a" : String(value)
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
