#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

type JsonRecord = Record<string, unknown>

type FinalReportOptions = {
  runId: string
  outputDir: string
  sweOfficialJsons: Record<string, string>
  tbenchSummaries: string[]
  blockedTbench: Record<string, string>
}

type SweCoderOfficial = {
  coderId: string
  sourcePath: string
  total: number
  submitted: number
  completed: number
  resolved: number
  unresolved: number
  emptyPatch: number
  errors: number
  scorePct: number
  resolvedIds: string[]
  unresolvedIds: string[]
  emptyPatchIds: string[]
  errorIds: string[]
}

type TBenchRunReport = {
  sourcePath: string
  runId: string
  coderId: string
  runStatus?: string
  model?: string
  selected: number
  completed: number
  failed: number
  meanReward: number | null
  nTotalTrials: number | null
  nCompletedTrials: number | null
  nErroredTrials: number | null
  nCancelledTrials: number | null
  nRunningTrials: number | null
  nPendingTrials: number | null
  costUsd: number | null
  durationMs: number | null
  failureType: FailureType | null
  failureReason: string | null
  wrapperProfile: ProfileAggregate
  providerProfile: ProviderAggregate
  exceptionStats: Record<string, string[]>
}

type BlockedTBenchCoder = {
  coderId: string
  reason: string
}

type ProfileAggregate = {
  profiles: number
  validProfiles: number
  totalProcessMs: number
  nonzeroExitCount: number
  warningCount: number
  paths: string[]
}

type ProviderAggregate = {
  profiles: number
  requestCount: number
  successCount: number
  errorCount: number
  totalLatencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  estimatedUsd: number | null
  paths: string[]
}

type FailureType =
  | "model_failure"
  | "verifier_flake"
  | "harness_failure"
  | "timeout"
  | "empty_patch"
  | "api_or_network_failure"
  | "environment_failure"

type FailureRecord = {
  benchmark: "swebench" | "terminal-bench"
  coderId: string
  itemId: string
  failureType: FailureType
  reason: string
  sourcePath?: string
}

type FinalReport = {
  schemaVersion: 1
  runId: string
  generatedAt: string
  outputDir: string
  sweOfficial: {
    coders: SweCoderOfficial[]
  }
  terminalBench: {
    runs: TBenchRunReport[]
    blocked: BlockedTBenchCoder[]
  }
  totals: {
    sweResolved: Record<string, string>
    tbenchMeanReward: Record<string, number | null>
    knownCostUsd: number | null
    failures: number
  }
  failures: FailureRecord[]
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    const report = await buildFinalReport(options)
    await writeFinalReport(options.outputDir, report)
    console.log(`Final eval report written: ${options.outputDir}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function buildFinalReport(options: FinalReportOptions): Promise<FinalReport> {
  const sweCoders = await Promise.all(
    Object.entries(options.sweOfficialJsons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([coderId, path]) => readSweOfficial(coderId, path)),
  )
  const tbenchRuns = await Promise.all(options.tbenchSummaries.map(readTBenchSummary))
  const blocked = Object.entries(options.blockedTbench)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([coderId, reason]) => ({ coderId, reason }))
  const failures = [
    ...sweCoders.flatMap(sweFailures),
    ...tbenchRuns.flatMap(tbenchFailures),
    ...blocked.map((entry): FailureRecord => ({
      benchmark: "terminal-bench",
      coderId: entry.coderId,
      itemId: "gate",
      failureType: "harness_failure",
      reason: entry.reason,
    })),
  ]
  const knownCosts = tbenchRuns.map((run) => run.costUsd).filter((value): value is number => typeof value === "number")
  const providerCosts = tbenchRuns
    .map((run) => run.providerProfile.estimatedUsd)
    .filter((value): value is number => typeof value === "number")
  return {
    schemaVersion: 1,
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    sweOfficial: { coders: sweCoders },
    terminalBench: { runs: tbenchRuns, blocked },
    totals: {
      sweResolved: Object.fromEntries(sweCoders.map((coder) => [coder.coderId, `${coder.resolved}/${coder.total}`])),
      tbenchMeanReward: Object.fromEntries(tbenchRuns.map((run) => [run.coderId, run.meanReward])),
      knownCostUsd: roundNullable(sumNullable([...knownCosts, ...providerCosts])),
      failures: failures.length,
    },
    failures,
  }
}

async function readSweOfficial(coderId: string, path: string): Promise<SweCoderOfficial> {
  const resolvedPath = resolve(path)
  const data = asRecord(JSON.parse(await readFile(resolvedPath, "utf8")))
  if (!data) throw new Error(`SWE official JSON is not an object: ${path}`)
  const total = numberValue(data, "total_instances") ?? arrayStrings(data.submitted_ids).length
  const resolvedIds = arrayStrings(data.resolved_ids)
  const unresolvedIds = arrayStrings(data.unresolved_ids)
  const emptyPatchIds = arrayStrings(data.empty_patch_ids)
  const errorIds = arrayStrings(data.error_ids)
  return {
    coderId,
    sourcePath: resolvedPath,
    total,
    submitted: arrayStrings(data.submitted_ids).length,
    completed: arrayStrings(data.completed_ids).length,
    resolved: resolvedIds.length,
    unresolved: unresolvedIds.length,
    emptyPatch: emptyPatchIds.length,
    errors: errorIds.length,
    scorePct: total > 0 ? roundPct((resolvedIds.length / total) * 100) : 0,
    resolvedIds,
    unresolvedIds,
    emptyPatchIds,
    errorIds,
  }
}

async function readTBenchSummary(path: string): Promise<TBenchRunReport> {
  const resolvedPath = resolve(path)
  const summary = asRecord(JSON.parse(await readFile(resolvedPath, "utf8")))
  if (!summary) throw new Error(`Terminal-Bench summary is not an object: ${path}`)
  const coder = recordValue(summary, "coder")
  const totals = recordValue(summary, "totals")
  const harbor = recordValue(summary, "harbor")
  const harborJob = recordValue(summary, "harborJob")
  const wrapperProfilePaths = arrayStrings(summary.wrapperProfilePaths).map((profilePath) => resolveMaybeRelative(resolvedPath, profilePath))
  const providerProfilePaths = arrayStrings(summary.providerProfilePaths).map((profilePath) => resolveMaybeRelative(resolvedPath, profilePath))
  const wrapperProfile = await aggregateWrapperProfiles(wrapperProfilePaths)
  const providerProfile = await aggregateProviderProfiles(providerProfilePaths)
  const exceptionStats = await readExceptionStats(stringValue(harborJob, "path"))
  const failure = classifyTBenchRun(harborJob, exceptionStats)
  return {
    sourcePath: resolvedPath,
    runId: stringValue(summary, "runId") ?? "unknown-run",
    coderId: stringValue(coder, "id") ?? "unknown-coder",
    runStatus: stringValue(coder, "runStatus"),
    model: stringValue(coder, "model"),
    selected: numberValue(totals, "selected") ?? 0,
    completed: numberValue(totals, "completed") ?? 0,
    failed: numberValue(totals, "failed") ?? 0,
    meanReward: nullableNumberValue(harborJob, "meanReward"),
    nTotalTrials: nullableNumberValue(harborJob, "nTotalTrials"),
    nCompletedTrials: nullableNumberValue(harborJob, "nCompletedTrials"),
    nErroredTrials: nullableNumberValue(harborJob, "nErroredTrials"),
    nCancelledTrials: nullableNumberValue(harborJob, "nCancelledTrials"),
    nRunningTrials: nullableNumberValue(harborJob, "nRunningTrials"),
    nPendingTrials: nullableNumberValue(harborJob, "nPendingTrials"),
    costUsd: nullableNumberValue(harborJob, "costUsd"),
    durationMs: nullableNumberValue(harbor, "durationMs"),
    failureType: failure?.failureType ?? null,
    failureReason: failure?.reason ?? null,
    wrapperProfile,
    providerProfile,
    exceptionStats,
  }
}

async function aggregateWrapperProfiles(paths: string[]): Promise<ProfileAggregate> {
  let totalProcessMs = 0
  let nonzeroExitCount = 0
  let warningCount = 0
  let validProfiles = 0
  for (const path of paths) {
    if (!existsSync(path)) continue
    const profile = asRecord(JSON.parse(await readFile(path, "utf8")))
    if (!profile) continue
    validProfiles += profile.schemaVersion === 1 ? 1 : 0
    const process = recordValue(profile, "process")
    totalProcessMs += numberValue(process, "durationMs") ?? 0
    const exitCode = numberValue(process, "exitCode")
    if (exitCode !== undefined && exitCode !== 0) nonzeroExitCount += 1
    warningCount += arrayStrings(profile.warnings).length
  }
  return {
    profiles: paths.length,
    validProfiles,
    totalProcessMs: roundMs(totalProcessMs),
    nonzeroExitCount,
    warningCount,
    paths,
  }
}

async function aggregateProviderProfiles(paths: string[]): Promise<ProviderAggregate> {
  let profiles = 0
  let requestCount = 0
  let successCount = 0
  let errorCount = 0
  let totalLatencyMs = 0
  const inputTokens: number[] = []
  const outputTokens: number[] = []
  const totalTokens: number[] = []
  const estimatedCosts: number[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    const profile = asRecord(JSON.parse(await readFile(path, "utf8")))
    if (!profile) continue
    profiles += 1
    const totals = recordValue(profile, "totals")
    const usage = recordValue(totals, "usage")
    const cost = recordValue(totals, "cost")
    requestCount += numberValue(totals, "requestCount") ?? 0
    successCount += numberValue(totals, "successCount") ?? 0
    errorCount += numberValue(totals, "errorCount") ?? 0
    totalLatencyMs += numberValue(totals, "totalLatencyMs") ?? 0
    pushNumber(inputTokens, numberValue(usage, "inputTokens"))
    pushNumber(outputTokens, numberValue(usage, "outputTokens"))
    pushNumber(totalTokens, numberValue(usage, "totalTokens"))
    pushNumber(estimatedCosts, numberValue(cost, "estimatedUsd"))
  }
  return {
    profiles,
    requestCount,
    successCount,
    errorCount,
    totalLatencyMs: roundMs(totalLatencyMs),
    inputTokens: sumNullable(inputTokens),
    outputTokens: sumNullable(outputTokens),
    totalTokens: sumNullable(totalTokens),
    estimatedUsd: roundNullable(sumNullable(estimatedCosts)),
    paths,
  }
}

async function readExceptionStats(path: string | undefined): Promise<Record<string, string[]>> {
  if (!path || !existsSync(path)) return {}
  const job = asRecord(JSON.parse(await readFile(path, "utf8")))
  const stats = recordValue(job, "stats")
  const evals = recordValue(stats, "evals")
  const result: Record<string, string[]> = {}
  for (const entry of Object.values(evals ?? {})) {
    const exceptionStats = recordValue(asRecord(entry), "exception_stats")
    if (!exceptionStats) continue
    for (const [name, values] of Object.entries(exceptionStats)) {
      result[name] = [...(result[name] ?? []), ...arrayStrings(values)]
    }
  }
  return result
}

function classifyTBenchRun(harborJob: JsonRecord | undefined, exceptionStats: Record<string, string[]>): { failureType: FailureType; reason: string } | null {
  if (!harborJob) return null
  const errored = numberValue(harborJob, "nErroredTrials") ?? 0
  const cancelled = numberValue(harborJob, "nCancelledTrials") ?? 0
  const running = numberValue(harborJob, "nRunningTrials") ?? 0
  const pending = numberValue(harborJob, "nPendingTrials") ?? 0
  const total = numberValue(harborJob, "nTotalTrials")
  const completed = numberValue(harborJob, "nCompletedTrials")
  const meanReward = numberValue(harborJob, "meanReward")
  const exceptionNames = Object.keys(exceptionStats)
  if (errored > 0 || cancelled > 0 || running > 0 || pending > 0 || (total !== undefined && completed !== undefined && completed < total)) {
    const reason = exceptionNames.length > 0
      ? `trial lifecycle failure: ${exceptionNames.join(", ")}`
      : `trial lifecycle failure: completed=${completed ?? "unknown"}/${total ?? "unknown"}, errored=${errored}, cancelled=${cancelled}, running=${running}, pending=${pending}`
    return { failureType: classifyFailure(reason), reason }
  }
  if (meanReward !== undefined && meanReward < 1) {
    return { failureType: "model_failure", reason: `mean reward ${meanReward}` }
  }
  return null
}

function sweFailures(coder: SweCoderOfficial): FailureRecord[] {
  return [
    ...coder.unresolvedIds.map((itemId): FailureRecord => ({
      benchmark: "swebench",
      coderId: coder.coderId,
      itemId,
      failureType: "model_failure",
      reason: "official evaluator unresolved",
      sourcePath: coder.sourcePath,
    })),
    ...coder.emptyPatchIds.map((itemId): FailureRecord => ({
      benchmark: "swebench",
      coderId: coder.coderId,
      itemId,
      failureType: "empty_patch",
      reason: "official evaluator empty patch",
      sourcePath: coder.sourcePath,
    })),
    ...coder.errorIds.map((itemId): FailureRecord => ({
      benchmark: "swebench",
      coderId: coder.coderId,
      itemId,
      failureType: "harness_failure",
      reason: "official evaluator error",
      sourcePath: coder.sourcePath,
    })),
  ]
}

function tbenchFailures(run: TBenchRunReport): FailureRecord[] {
  if (!run.failureType || !run.failureReason) return []
  return [
    {
      benchmark: "terminal-bench",
      coderId: run.coderId,
      itemId: run.runId,
      failureType: run.failureType,
      reason: run.failureReason,
      sourcePath: run.sourcePath,
    },
  ]
}

async function writeFinalReport(outputDir: string, report: FinalReport): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await writeFile(join(outputDir, "report.zh-CN.md"), renderZhCN(report), "utf8")
  await writeFile(join(outputDir, "report.md"), renderZhCN(report), "utf8")
  await writeFile(join(outputDir, "failures.jsonl"), report.failures.map((failure) => JSON.stringify(failure)).join("\n") + "\n", "utf8")
  await writeFile(
    join(outputDir, "cost.json"),
    `${JSON.stringify({ schemaVersion: 1, runId: report.runId, currency: "USD", totalUsd: report.totals.knownCostUsd }, null, 2)}\n`,
    "utf8",
  )
}

function renderZhCN(report: FinalReport): string {
  const lines = [
    "# SWE-bench Verified + Terminal-Bench 四路横评报告",
    "",
    `Run ID: \`${report.runId}\``,
    `Generated: \`${report.generatedAt}\``,
    "",
    "## 总览",
    "",
    "| Benchmark | Coder | 结果 | 成本 | 备注 |",
    "|---|---|---:|---:|---|",
  ]
  for (const coder of report.sweOfficial.coders) {
    lines.push(`| SWE-bench Verified | ${coder.coderId} | ${coder.resolved}/${coder.total} (${coder.scorePct}%) | - | empty=${coder.emptyPatch}, errors=${coder.errors} |`)
  }
  for (const run of report.terminalBench.runs) {
    lines.push(`| Terminal-Bench | ${run.coderId} | reward=${formatNumber(run.meanReward)} trials=${formatNumber(run.nCompletedTrials)}/${formatNumber(run.nTotalTrials)} | ${formatUsd(run.costUsd ?? run.providerProfile.estimatedUsd)} | ${run.failureReason ?? "ok"} |`)
  }
  for (const blocked of report.terminalBench.blocked) {
    lines.push(`| Terminal-Bench | ${blocked.coderId} | blocked | - | ${blocked.reason} |`)
  }

  lines.push("", "## SWE 官方结果", "")
  lines.push("| Coder | Resolved | Unresolved | Empty Patch | Errors | Completed | Submitted |")
  lines.push("|---|---:|---:|---:|---:|---:|---:|")
  for (const coder of report.sweOfficial.coders) {
    lines.push(`| ${coder.coderId} | ${coder.resolved}/${coder.total} | ${coder.unresolved} | ${coder.emptyPatch} | ${coder.errors} | ${coder.completed} | ${coder.submitted} |`)
  }

  lines.push("", "## Terminal-Bench 结果", "")
  lines.push("| Coder | Run | Selected | Completed | Errored | Reward | Duration | Wrapper Profiles | Provider Requests | Failure |")
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|")
  for (const run of report.terminalBench.runs) {
    lines.push(
      `| ${run.coderId} | ${run.runId} | ${run.selected} | ${formatNumber(run.nCompletedTrials)} | ${formatNumber(run.nErroredTrials)} | ${formatNumber(run.meanReward)} | ${formatDuration(run.durationMs)} | ${run.wrapperProfile.validProfiles}/${run.wrapperProfile.profiles} | ${run.providerProfile.requestCount} | ${run.failureReason ?? "ok"} |`,
    )
  }
  if (report.terminalBench.blocked.length > 0) {
    lines.push("", "## Blocked Gate", "")
    lines.push("| Coder | Reason |")
    lines.push("|---|---|")
    for (const blocked of report.terminalBench.blocked) lines.push(`| ${blocked.coderId} | ${blocked.reason} |`)
  }

  lines.push("", "## Profiling 摘要", "")
  lines.push("| Coder | Wrapper process time | Nonzero exits | Provider requests | Provider errors | Input tokens | Output tokens |")
  lines.push("|---|---:|---:|---:|---:|---:|---:|")
  for (const run of report.terminalBench.runs) {
    lines.push(
      `| ${run.coderId} | ${formatDuration(run.wrapperProfile.totalProcessMs)} | ${run.wrapperProfile.nonzeroExitCount} | ${run.providerProfile.requestCount} | ${run.providerProfile.errorCount} | ${formatNumber(run.providerProfile.inputTokens)} | ${formatNumber(run.providerProfile.outputTokens)} |`,
    )
  }

  const topFailures = failureCounts(report.failures)
  lines.push("", "## 失败分类", "")
  lines.push("| Type | Count |")
  lines.push("|---|---:|")
  for (const [type, count] of topFailures) lines.push(`| ${type} | ${count} |`)
  lines.push("")
  lines.push("说明：报告只包含 bounded metadata、路径、计数、耗时和失败类型；不包含 API key、prompt/response 正文、stdout/stderr 正文或 patch 正文。")
  return `${lines.join("\n")}\n`
}

function failureCounts(failures: FailureRecord[]): Array<[FailureType, number]> {
  const counts = new Map<FailureType, number>()
  for (const failure of failures) counts.set(failure.failureType, (counts.get(failure.failureType) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
}

function classifyFailure(reason: string): FailureType {
  const text = reason.toLowerCase()
  if (/\b(timeout|timed out|deadline)\b/.test(text)) return "timeout"
  if (/\b(api|network|connection|connect|dns|tls|socket|rate limit|429|500|502|503|504|provider)\b/.test(text)) return "api_or_network_failure"
  if (/\b(agentsetuptimeouterror|install|pipx|npm|uv|docker|image|mount|environment|command not found|missing executable)\b/.test(text)) return "environment_failure"
  if (/\b(rewardfilenotfound|harbor|harness|result\.json|wrapper)\b/.test(text)) return "harness_failure"
  if (/\b(flake|flaky|nondetermin)\b/.test(text)) return "verifier_flake"
  return "model_failure"
}

function parseArgs(argv: string[]): FinalReportOptions {
  const options: FinalReportOptions = {
    runId: "final-eval",
    outputDir: resolve(".light-cc/evals/final-report"),
    sweOfficialJsons: {},
    tbenchSummaries: [],
    blockedTbench: {},
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--run-id") options.runId = requireValue(argv, ++index, arg)
    else if (arg === "--output-dir") options.outputDir = resolve(requireValue(argv, ++index, arg))
    else if (arg === "--swe-official-json") {
      const [coder, path] = splitAssignment(requireValue(argv, ++index, arg), arg)
      options.sweOfficialJsons[coder] = path
    } else if (arg === "--tbench-summary") options.tbenchSummaries.push(requireValue(argv, ++index, arg))
    else if (arg === "--tbench-blocked") {
      const [coder, reason] = splitAssignment(requireValue(argv, ++index, arg), arg)
      options.blockedTbench[coder] = reason
    } else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function splitAssignment(value: string, flag: string): [string, string] {
  const separator = value.indexOf("=")
  if (separator <= 0) throw new Error(`${flag} expects name=value`)
  return [value.slice(0, separator), value.slice(separator + 1)]
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function usage(): string {
  return [
    "Usage: bun evals/report/final-run.ts --output-dir <dir>",
    "  --swe-official-json lightcc=lightcc__deepseek-v4-flash.swe20-fourway-20260602-eval-lightcc.json",
    "  --tbench-summary .light-cc/evals/<run>/terminal-bench/summary.json",
  ].join("\n")
}

function resolveMaybeRelative(summaryPath: string, path: string): string {
  return path.startsWith("/") ? path : resolve(dirname(summaryPath), path)
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function recordValue(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return asRecord(record?.[key])
}

function stringValue(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function numberValue(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nullableNumberValue(record: JsonRecord | undefined, key: string): number | null {
  return numberValue(record, key) ?? null
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function pushNumber(values: number[], value: number | undefined): void {
  if (typeof value === "number") values.push(value)
}

function sumNullable(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null
}

function roundNullable(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(6))
}

function roundMs(value: number): number {
  return Number(value.toFixed(3))
}

function roundPct(value: number): number {
  return Number(value.toFixed(2))
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : String(value)
}

function formatDuration(value: number | null): string {
  if (value === null) return "-"
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

function formatUsd(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(6)}`
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
