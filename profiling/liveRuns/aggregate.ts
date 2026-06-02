// Stage 2 (Regime B) pure aggregate over N single-run ProfileReport artifacts.
//
// This is a DEVELOPER artifact, not a benchmark, evaluation, leaderboard, or CI
// gate (see spec/phase-8-stage-2.md). It consumes the existing stable single-run
// ProfileReport contract (../report/types.ts) and produces a separately-versioned
// `live-runs.summary.json`. It MUST NOT mutate or redefine the single-run report
// schema.
//
// This module is pure: given run records (status + optional ProfileReport) it
// computes medians/IQRs and bottleneck frequency. It never spawns processes,
// reads files, or calls providers — that lives in ./runner.ts. Keeping the math
// pure is what makes it unit-testable without a real provider.

import type { ProfileReport } from "../report/types"

// Versioned independently from the single-run ProfileReport schema. Bump this if
// the aggregate shape changes; the single-run schemaVersion stays untouched.
export const LIVE_RUNS_SUMMARY_SCHEMA_VERSION = 1

export type LiveRunStatus = "ok" | "failed" | "skipped"

// One attempted live run. The runner builds these; tests synthesize them. A run is
// only included in aggregate statistics when status==="ok", it is not a warmup, and
// its report carries profile.span data.
export type LiveRunRecord = {
  index: number
  warmup: boolean
  status: LiveRunStatus
  wallClockMs: number | null
  transcriptPath: string | null
  reportPath: string | null
  report: ProfileReport | null
  // High-level, bounded error string for failed/skipped runs (e.g. "exited with
  // code 1"). Never raw stderr/stdout bodies.
  error: string | null
}

// Bounded echo of the run configuration (no credentials, no prompt text).
export type LiveRunConfigEcho = {
  runsRequested?: number
  warmupRequested?: number
  model?: string | null
  baseUrl?: string | null
  apiKeyEnv?: string | null
  permissionMode?: string | null
  osSandbox?: string | null
  maxSteps?: number | null
  cwd?: string | null
  fake?: boolean
}

export type LiveRunsAggregateInput = {
  scenario?: string | null
  promptFile?: string | null
  runs: LiveRunRecord[]
  generatedAt?: string
  config?: LiveRunConfigEcho
}

// Five-number-ish summary over the per-run values of one metric. `iqr` is the
// inter-quartile range computed with Tukey's hinges (see quartiles()).
export type Stats = {
  count: number
  median: number
  min: number
  max: number
  iqr: number
}

export type CategoryStat = Stats & { category: string }

export type ToolAggregate = {
  toolName: string
  // Total tool calls summed across included runs.
  count: number
  // Number of included runs in which this tool appeared at all.
  runCount: number
  // Distribution across runs of each run's per-tool p50 / max duration.
  durationMsP50: Stats | null
  durationMsMax: Stats | null
  errorCount: number
  deniedCount: number
  timeoutCount: number
}

export type ProviderAggregate = {
  firstTokenMs: Stats | null
  streamMs: Stats | null
  totalDurationMs: Stats | null
  retryCount: Stats | null
  inputTokens: Stats | null
  outputTokens: Stats | null
  cacheReadInputTokens: Stats | null
  cacheWriteInputTokens: Stats | null
}

export type ContextAggregate = {
  maxEstimatedTokens: Stats | null
  totalDurationMs: Stats | null
}

export type RuntimeAggregate = {
  bashCount: number
  durationMs: Stats | null
  nonzeroExitCount: number
  timeoutCount: number
  truncatedCount: number
}

export type CompactAggregate = {
  count: number
  failedCount: number
  durationMs: Stats | null
}

export type TranscriptWriteAggregate = {
  // Distribution and sum (across runs) of each run's total transcript-write time.
  totalDurationMs: Stats | null
  sumDurationMs: number | null
  totalBytes: Stats | null
  sumBytes: number | null
}

export type LiveRunEntry = {
  index: number
  warmup: boolean
  status: LiveRunStatus
  included: boolean
  wallClockMs: number | null
  observedDurationMs: number | null
  topBottleneck: string | null
  transcriptPath: string | null
  reportPath: string | null
  error: string | null
}

export type LiveRunsSummary = {
  schemaVersion: typeof LIVE_RUNS_SUMMARY_SCHEMA_VERSION
  kind: "live-runs.summary"
  generatedAt: string
  scenario: string | null
  promptFile: string | null
  config: LiveRunConfigEcho | null
  counts: {
    total: number
    included: number
    warmup: number
    skipped: number
    failed: number
    missingProfileData: number
    malformed: number
  }
  wallClockMsTotal: number
  runs: LiveRunEntry[]
  includedTranscriptPaths: string[]
  includedReportPaths: string[]
  failures: { index: number; status: LiveRunStatus; error: string | null }[]
  observedDurationMs: Stats | null
  categoryTotals: CategoryStat[]
  provider: ProviderAggregate
  context: ContextAggregate
  tools: ToolAggregate[]
  runtime: RuntimeAggregate
  compact: CompactAggregate
  transcriptWrite: TranscriptWriteAggregate
  topBottleneckFrequency: { category: string; count: number }[]
  warnings: string[]
}

export function aggregateLiveRuns(input: LiveRunsAggregateInput): LiveRunsSummary {
  const warnings: string[] = []
  const runs = Array.isArray(input.runs) ? input.runs : []

  const entries: LiveRunEntry[] = []
  const included: LiveRunRecord[] = []
  const failures: { index: number; status: LiveRunStatus; error: string | null }[] = []

  let warmupCount = 0
  let skippedCount = 0
  let failedCount = 0
  let missingProfileData = 0
  let malformed = 0

  for (const run of runs) {
    if (run.warmup) warmupCount += 1
    if (run.status === "skipped") {
      skippedCount += 1
      failures.push({ index: run.index, status: run.status, error: run.error })
    } else if (run.status === "failed") {
      failedCount += 1
      failures.push({ index: run.index, status: run.status, error: run.error })
    }

    const reportUsable = isUsableReport(run.report)
    const hasData = reportUsable && (run.report as ProfileReport).summary.profileSpanCount > 0
    const include = run.status === "ok" && !run.warmup && hasData

    if (run.status === "ok" && !run.warmup) {
      if (!reportUsable) {
        malformed += 1
        warnings.push(`run #${run.index} report was missing or malformed; excluded from statistics`)
      } else if (!hasData) {
        missingProfileData += 1
        warnings.push(`run #${run.index} produced no profile.span data; was profiling enabled? excluded from statistics`)
      }
    }

    if (include) included.push(run)

    entries.push({
      index: run.index,
      warmup: run.warmup,
      status: run.status,
      included: include,
      wallClockMs: run.wallClockMs,
      observedDurationMs: reportUsable ? (run.report as ProfileReport).summary.observedDurationMs : null,
      topBottleneck: reportUsable ? (run.report as ProfileReport).summary.topBottleneck : null,
      transcriptPath: run.transcriptPath,
      reportPath: run.reportPath,
      error: run.error,
    })
  }

  if (included.length === 0) {
    warnings.push("no included runs produced profile data; aggregate statistics are empty")
  }
  if (failedCount > 0) warnings.push(`${failedCount} run(s) failed; see failures[]`)
  if (skippedCount > 0) warnings.push(`${skippedCount} run(s) skipped; see failures[]`)

  const reports = included.map((run) => run.report as ProfileReport)

  const wallClockMsTotal = round(
    runs.reduce((sum, run) => (typeof run.wallClockMs === "number" && Number.isFinite(run.wallClockMs) ? sum + run.wallClockMs : sum), 0),
  )

  return {
    schemaVersion: LIVE_RUNS_SUMMARY_SCHEMA_VERSION,
    kind: "live-runs.summary",
    generatedAt: input.generatedAt ?? "",
    scenario: input.scenario ?? null,
    promptFile: input.promptFile ?? null,
    config: input.config ?? null,
    counts: {
      total: runs.length,
      included: included.length,
      warmup: warmupCount,
      skipped: skippedCount,
      failed: failedCount,
      missingProfileData,
      malformed,
    },
    wallClockMsTotal,
    runs: entries,
    includedTranscriptPaths: included.map((run) => run.transcriptPath).filter((path): path is string => typeof path === "string"),
    includedReportPaths: included.map((run) => run.reportPath).filter((path): path is string => typeof path === "string"),
    failures,
    observedDurationMs: computeStats(reports.map((report) => report.summary.observedDurationMs)),
    categoryTotals: categoryStats(reports),
    provider: providerAggregate(reports),
    context: contextAggregate(reports),
    tools: toolAggregates(reports),
    runtime: runtimeAggregate(reports),
    compact: compactAggregate(reports),
    transcriptWrite: transcriptWriteAggregate(reports),
    topBottleneckFrequency: bottleneckFrequency(reports),
    warnings,
  }
}

// --- Per-section aggregation -----------------------------------------------

function categoryStats(reports: ProfileReport[]): CategoryStat[] {
  const categories = new Set<string>()
  for (const report of reports) {
    for (const entry of report.categoryTotals) categories.add(entry.category)
  }
  const result: CategoryStat[] = []
  for (const category of categories) {
    // A category absent from a run contributed 0 duration that run; include it as 0
    // so the median reflects every included run, not only the runs that hit it.
    const values = reports.map((report) => report.categoryTotals.find((entry) => entry.category === category)?.totalDurationMs ?? 0)
    const stats = computeStats(values)
    if (stats) result.push({ category, ...stats })
  }
  return result.sort((a, b) => b.median - a.median || a.category.localeCompare(b.category))
}

function providerAggregate(reports: ProfileReport[]): ProviderAggregate {
  return {
    firstTokenMs: computeStats(collectNumbers(reports, (report) => report.provider.firstTokenMsP50)),
    streamMs: computeStats(collectNumbers(reports, (report) => report.provider.streamMsP50)),
    totalDurationMs: computeStats(collectNumbers(reports, (report) => report.provider.totalDurationMs)),
    retryCount: computeStats(collectNumbers(reports, (report) => report.provider.retryCount)),
    inputTokens: computeStats(collectNumbers(reports, (report) => report.provider.inputTokens)),
    outputTokens: computeStats(collectNumbers(reports, (report) => report.provider.outputTokens)),
    cacheReadInputTokens: computeStats(collectNumbers(reports, (report) => report.provider.cacheReadInputTokens)),
    cacheWriteInputTokens: computeStats(collectNumbers(reports, (report) => report.provider.cacheWriteInputTokens)),
  }
}

function contextAggregate(reports: ProfileReport[]): ContextAggregate {
  return {
    maxEstimatedTokens: computeStats(collectNumbers(reports, (report) => report.context.maxEstimatedTokens)),
    totalDurationMs: computeStats(collectNumbers(reports, (report) => report.context.totalDurationMs)),
  }
}

function toolAggregates(reports: ProfileReport[]): ToolAggregate[] {
  const names = new Set<string>()
  for (const report of reports) {
    for (const tool of report.tools) names.add(tool.toolName)
  }
  const result: ToolAggregate[] = []
  for (const toolName of names) {
    let count = 0
    let runCount = 0
    let errorCount = 0
    let deniedCount = 0
    let timeoutCount = 0
    const p50s: number[] = []
    const maxes: number[] = []
    for (const report of reports) {
      const tool = report.tools.find((entry) => entry.toolName === toolName)
      if (!tool) continue
      runCount += 1
      count += tool.count
      errorCount += tool.errorCount
      deniedCount += tool.deniedCount
      timeoutCount += tool.timeoutCount
      if (typeof tool.durationMsP50 === "number") p50s.push(tool.durationMsP50)
      if (typeof tool.durationMsMax === "number") maxes.push(tool.durationMsMax)
    }
    result.push({
      toolName,
      count,
      runCount,
      durationMsP50: computeStats(p50s),
      durationMsMax: computeStats(maxes),
      errorCount,
      deniedCount,
      timeoutCount,
    })
  }
  return result.sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName))
}

function runtimeAggregate(reports: ProfileReport[]): RuntimeAggregate {
  let bashCount = 0
  let nonzeroExitCount = 0
  let timeoutCount = 0
  let truncatedCount = 0
  for (const report of reports) {
    bashCount += report.runtime.bashCount
    nonzeroExitCount += report.runtime.nonzeroExitCount
    timeoutCount += report.runtime.timeoutCount
    truncatedCount += report.runtime.truncatedCount
  }
  return {
    bashCount,
    durationMs: computeStats(collectNumbers(reports, (report) => report.runtime.durationMsP50)),
    nonzeroExitCount,
    timeoutCount,
    truncatedCount,
  }
}

function compactAggregate(reports: ProfileReport[]): CompactAggregate {
  let count = 0
  let failedCount = 0
  for (const report of reports) {
    count += report.compact.count
    failedCount += report.compact.failedCount
  }
  return {
    count,
    failedCount,
    durationMs: computeStats(collectNumbers(reports, (report) => report.compact.durationMs)),
  }
}

function transcriptWriteAggregate(reports: ProfileReport[]): TranscriptWriteAggregate {
  const durations = collectNumbers(reports, (report) => report.transcriptWrite.totalDurationMs)
  const bytes = collectNumbers(reports, (report) => report.transcriptWrite.totalBytes)
  return {
    totalDurationMs: computeStats(durations),
    sumDurationMs: durations.length > 0 ? round(durations.reduce((sum, value) => sum + value, 0)) : null,
    totalBytes: computeStats(bytes),
    sumBytes: bytes.length > 0 ? round(bytes.reduce((sum, value) => sum + value, 0)) : null,
  }
}

function bottleneckFrequency(reports: ProfileReport[]): { category: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const report of reports) {
    const bottleneck = report.summary.topBottleneck
    if (typeof bottleneck === "string" && bottleneck.length > 0) {
      counts.set(bottleneck, (counts.get(bottleneck) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
}

// --- Statistics primitives -------------------------------------------------

function collectNumbers(reports: ProfileReport[], pick: (report: ProfileReport) => number | null): number[] {
  const values: number[] = []
  for (const report of reports) {
    const value = pick(report)
    if (typeof value === "number" && Number.isFinite(value)) values.push(value)
  }
  return values
}

export function computeStats(values: number[]): Stats | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const { q1, q3 } = quartiles(sorted)
  return {
    count: sorted.length,
    median: round(medianOf(sorted)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    iqr: round(q3 - q1),
  }
}

function medianOf(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// Tukey's hinges: split the sorted sample at the median; for odd n the median
// element is excluded from both halves. Q1/Q3 are the medians of the halves.
function quartiles(sorted: number[]): { q1: number; q3: number } {
  const n = sorted.length
  if (n === 1) return { q1: sorted[0], q3: sorted[0] }
  const half = Math.floor(n / 2)
  const lower = sorted.slice(0, half)
  const upper = n % 2 === 0 ? sorted.slice(half) : sorted.slice(half + 1)
  return { q1: medianOf(lower), q3: medianOf(upper) }
}

function isUsableReport(report: ProfileReport | null): report is ProfileReport {
  return (
    !!report &&
    typeof report === "object" &&
    report.schemaVersion === 1 &&
    !!report.summary &&
    typeof report.summary === "object" &&
    typeof report.summary.profileSpanCount === "number" &&
    Array.isArray(report.categoryTotals) &&
    Array.isArray(report.tools) &&
    !!report.provider &&
    !!report.context &&
    !!report.runtime &&
    !!report.compact &&
    !!report.transcriptWrite
  )
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
