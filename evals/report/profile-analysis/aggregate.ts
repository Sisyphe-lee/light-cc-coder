import { buildOutcomeProfileSplits, isFailureLike, isResolvedLike, outcomeKey } from "./correlate"
import {
  EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
  type BenchmarkName,
  type CoderProfileSummary,
  type EvalProfileAnalysisResult,
  type EvalProfileRow,
  type EvalProfileSummary,
  type ItemProfileMatrixEntry,
  type OutlierRecord,
  type OutlierSeverity,
  type ProfileCoverageSummary,
} from "./types"
import { maxNullable, pct, percentile, ratio, round, sumNullable, uniqueSorted } from "./utils"

export function aggregateEvalProfileRows(rows: EvalProfileRow[], loadWarnings: string[] = []): EvalProfileAnalysisResult {
  const outliers = buildOutliers(rows)
  return {
    rows,
    summary: buildSummary(rows, loadWarnings),
    coderSummary: buildCoderSummary(rows),
    itemMatrix: buildItemMatrix(rows),
    outliers,
    outcomeSplits: buildOutcomeProfileSplits(rows),
  }
}

function buildSummary(rows: EvalProfileRow[], loadWarnings: string[]): EvalProfileSummary {
  const rowWarnings = rows.flatMap((row) => row.warnings.map((warning) => `${row.coderId}/${row.itemId}: ${warning}`))
  return {
    schemaVersion: EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    runIds: uniqueSorted(rows.map((row) => row.runId)),
    benchmarks: uniqueSorted(rows.map((row) => row.benchmark)) as BenchmarkName[],
    rowCount: rows.length,
    itemCount: new Set(rows.map((row) => `${row.benchmark}\0${row.itemId}`)).size,
    coderCount: new Set(rows.map((row) => row.coderId)).size,
    coverage: {
      wrapper: coverage(rows, (row) => row.commonProfile.wrapper.exists, (row) => row.commonProfile.wrapper.valid),
      provider: coverage(rows, (row) => row.commonProfile.provider.exists, (row) => row.commonProfile.provider.valid),
      internal: coverage(rows, (row) => Boolean(row.internalProfile?.exists), (row) => Boolean(row.internalProfile?.valid)),
    },
    outcomes: countBy(rows.map(outcomeKey)),
    warnings: {
      count: loadWarnings.length + rowWarnings.length,
      examples: [...loadWarnings, ...rowWarnings].slice(0, 20),
    },
  }
}

function buildCoderSummary(rows: EvalProfileRow[]): CoderProfileSummary[] {
  const groups = groupBy(rows, (row) => row.coderId)
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([coderId, group]) => {
    const resolved = group.filter(isResolvedLike).length
    const requestCount = sumNullable(group.map((row) => row.commonProfile.provider.requestCount))
    const estimatedUsd = sumNullable(group.map((row) => row.commonProfile.provider.estimatedUsd))
    const totalTokens = sumNullable(group.map((row) => row.commonProfile.provider.totalTokens))
    return {
      schemaVersion: EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
      coderId,
      coderDisplayName: group.find((row) => row.coderDisplayName)?.coderDisplayName ?? coderId,
      benchmarkRows: {
        swebench: group.filter((row) => row.benchmark === "swebench").length,
        "terminal-bench": group.filter((row) => row.benchmark === "terminal-bench").length,
      },
      rows: group.length,
      resolved,
      unresolved: group.filter((row) => row.outcome.officialOutcome === "unresolved").length,
      emptyPatch: group.filter((row) => row.outcome.officialOutcome === "empty_patch" || row.outcome.emptyPatch === true).length,
      errors: group.filter((row) => row.outcome.officialOutcome === "error").length,
      incomplete: group.filter((row) => row.outcome.officialOutcome === "incomplete").length,
      completed: group.filter((row) => row.outcome.completed === true).length,
      submitted: group.filter((row) => row.outcome.submitted === true).length,
      requestCount,
      providerErrors: sumNullable(group.map((row) => row.commonProfile.provider.errorCount)),
      totalProviderLatencyMs: sumNullable(group.map((row) => row.commonProfile.provider.totalLatencyMs)),
      totalWrapperDurationMs: sumNullable(group.map((row) => row.commonProfile.wrapper.durationMs)),
      totalTokens,
      inputTokens: sumNullable(group.map((row) => row.commonProfile.provider.inputTokens)),
      outputTokens: sumNullable(group.map((row) => row.commonProfile.provider.outputTokens)),
      reasoningTokens: sumNullable(group.map((row) => row.commonProfile.provider.reasoningTokens)),
      cacheReadInputTokens: sumNullable(group.map((row) => row.commonProfile.provider.cacheReadInputTokens)),
      cacheWriteInputTokens: sumNullable(group.map((row) => row.commonProfile.provider.cacheWriteInputTokens)),
      estimatedUsd,
      cacheHitRatio: ratio(
        sumNullable(group.map((row) => row.commonProfile.provider.cacheReadInputTokens)),
        sumNullable(group.flatMap((row) => [row.commonProfile.provider.cacheReadInputTokens, row.commonProfile.provider.cacheWriteInputTokens])),
      ),
      tokensPerResolved: ratio(totalTokens, resolved),
      requestsPerResolved: ratio(requestCount, resolved),
      costPerResolved: ratio(estimatedUsd, resolved),
      wrapperNonzeroExitCount: group.filter((row) => {
        const exitCode = row.commonProfile.wrapper.exitCode
        return (typeof exitCode === "number" && exitCode !== 0) || Boolean(row.commonProfile.wrapper.signal)
      }).length,
      wrapperCoveragePct: pct(group.filter((row) => row.commonProfile.wrapper.valid).length, group.length),
      providerCoveragePct: pct(group.filter((row) => row.commonProfile.provider.valid).length, group.length),
      internalCoveragePct: pct(group.filter((row) => row.internalProfile?.valid).length, group.length),
    }
  })
}

function buildItemMatrix(rows: EvalProfileRow[]): ItemProfileMatrixEntry[] {
  const groups = groupBy(rows, (row) => `${row.benchmark}\0${row.itemId}`)
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => {
    const benchmark = group[0].benchmark
    const itemId = group[0].itemId
    const resolvedRows = group.filter(isResolvedLike)
    const failedRows = group.filter(isFailureLike)
    const cheapestResolved = minBy(resolvedRows, (row) => row.commonProfile.provider.estimatedUsd)
    const fastestResolved = minBy(resolvedRows, (row) => row.commonProfile.wrapper.durationMs)
    const mostExpensiveFailure = maxBy(failedRows, (row) => row.commonProfile.provider.estimatedUsd)
    const lightcc = group.find((row) => row.coderId === "lightcc")
    const competitors = group.filter((row) => row.coderId !== "lightcc")
    return {
      schemaVersion: EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
      benchmark,
      itemId,
      rows: group.sort((left, right) => left.coderId.localeCompare(right.coderId)).map((row) => ({
        coderId: row.coderId,
        outcome: row.outcome.officialOutcome,
        tbenchReward: row.outcome.tbenchReward,
        wrapperDurationMs: row.commonProfile.wrapper.durationMs,
        requestCount: row.commonProfile.provider.requestCount,
        totalTokens: row.commonProfile.provider.totalTokens,
        estimatedUsd: row.commonProfile.provider.estimatedUsd,
        providerErrors: row.commonProfile.provider.errorCount,
      })),
      solvedCoders: resolvedRows.map((row) => row.coderId).sort(),
      cheapestResolvedCoder: cheapestResolved?.coderId ?? null,
      fastestResolvedCoder: fastestResolved?.coderId ?? null,
      mostExpensiveFailure: mostExpensiveFailure?.coderId ?? null,
      lightccVsBestCompetitor: {
        tokenGap: differenceFromBest(lightcc?.commonProfile.provider.totalTokens, competitors.map((row) => row.commonProfile.provider.totalTokens)),
        costGap: differenceFromBest(lightcc?.commonProfile.provider.estimatedUsd, competitors.map((row) => row.commonProfile.provider.estimatedUsd)),
        durationGapMs: differenceFromBest(lightcc?.commonProfile.wrapper.durationMs, competitors.map((row) => row.commonProfile.wrapper.durationMs)),
      },
      notes: buildItemNotes(group),
    }
  })
}

function buildOutliers(rows: EvalProfileRow[]): OutlierRecord[] {
  const thresholds = {
    totalTokensP95: percentile(rows.map((row) => row.commonProfile.provider.totalTokens), 0.95),
    totalTokensMedian: percentile(rows.map((row) => row.commonProfile.provider.totalTokens), 0.5),
    requestCountP95: percentile(rows.map((row) => row.commonProfile.provider.requestCount), 0.95),
    requestCountMedian: percentile(rows.map((row) => row.commonProfile.provider.requestCount), 0.5),
    providerLatencyP95: percentile(rows.map((row) => row.commonProfile.provider.totalLatencyMs), 0.95),
    wrapperDurationP95: percentile(rows.map((row) => row.commonProfile.wrapper.durationMs), 0.95),
    failureCostP75: percentile(rows.filter(isFailureLike).map((row) => row.commonProfile.provider.estimatedUsd), 0.75),
    failureTokensP75: percentile(rows.filter(isFailureLike).map((row) => row.commonProfile.provider.totalTokens), 0.75),
    failureRequestsP75: percentile(rows.filter(isFailureLike).map((row) => row.commonProfile.provider.requestCount), 0.75),
    toolErrorsP90: percentile(rows.map((row) => lightccToolErrorCount(row)), 0.9),
    contextTokensP95: percentile(rows.map((row) => row.internalProfile?.context.maxEstimatedTokens), 0.95),
    transcriptOverheadP90: percentile(rows.map((row) => transcriptOverhead(row)), 0.9),
  }
  const outliers: OutlierRecord[] = []
  for (const row of rows) {
    addNumericOutlier(outliers, row, "high_total_tokens", "warn", row.commonProfile.provider.totalTokens, maxNullable([
      thresholds.totalTokensP95,
      thresholds.totalTokensMedian === null ? null : thresholds.totalTokensMedian * 2,
    ]), [`totalTokens=${row.commonProfile.provider.totalTokens ?? "null"}`])
    addNumericOutlier(outliers, row, "high_request_count", "warn", row.commonProfile.provider.requestCount, maxNullable([
      thresholds.requestCountP95,
      thresholds.requestCountMedian === null ? null : thresholds.requestCountMedian * 2,
    ]), [`requestCount=${row.commonProfile.provider.requestCount ?? "null"}`])
    addNumericOutlier(outliers, row, "high_provider_latency", "warn", row.commonProfile.provider.totalLatencyMs, thresholds.providerLatencyP95, [
      `providerLatencyMs=${row.commonProfile.provider.totalLatencyMs ?? "null"}`,
    ])
    addNumericOutlier(outliers, row, "high_wrapper_duration", "warn", row.commonProfile.wrapper.durationMs, thresholds.wrapperDurationP95, [
      `wrapperDurationMs=${row.commonProfile.wrapper.durationMs ?? "null"}`,
    ])

    if (isFailureLike(row) && exceedsAny([
      [row.commonProfile.provider.estimatedUsd, thresholds.failureCostP75],
      [row.commonProfile.provider.totalTokens, thresholds.failureTokensP75],
      [row.commonProfile.provider.requestCount, thresholds.failureRequestsP75],
    ])) {
      outliers.push(makeOutlier(row, "high_cost_failure", "warn", row.commonProfile.provider.estimatedUsd, thresholds.failureCostP75, [
        `outcome=${outcomeKey(row)}`,
        `estimatedUsd=${row.commonProfile.provider.estimatedUsd ?? "null"}`,
        `totalTokens=${row.commonProfile.provider.totalTokens ?? "null"}`,
        `requestCount=${row.commonProfile.provider.requestCount ?? "null"}`,
      ]))
    }

    if ((row.commonProfile.provider.errorCount ?? 0) > 0) {
      outliers.push(makeOutlier(row, "provider_error", "critical", row.commonProfile.provider.errorCount, 0, [
        `providerErrors=${row.commonProfile.provider.errorCount}`,
        `retryableErrors=${row.commonProfile.provider.retryableErrorCount ?? "null"}`,
      ]))
    }
    const exitCode = row.commonProfile.wrapper.exitCode
    if ((typeof exitCode === "number" && exitCode !== 0) || row.commonProfile.wrapper.signal) {
      outliers.push(makeOutlier(row, "wrapper_nonzero_exit", "critical", exitCode ?? row.commonProfile.wrapper.signal, 0, [
        `exitCode=${exitCode ?? "null"}`,
        `signal=${row.commonProfile.wrapper.signal ?? "null"}`,
      ]))
    }
    if (row.outcome.officialOutcome === "empty_patch" || row.outcome.emptyPatch === true) {
      outliers.push(makeOutlier(row, "empty_patch", "warn", row.outcome.patchBytes, 1, [
        `patchBytes=${row.outcome.patchBytes ?? "null"}`,
        `patchLines=${row.outcome.patchLines ?? "null"}`,
      ]))
    }

    addNumericOutlier(outliers, row, "lightcc_tool_error_outlier", "warn", lightccToolErrorCount(row), thresholds.toolErrorsP90, [
      `toolErrorCount=${lightccToolErrorCount(row)}`,
    ], 0)
    if ((row.internalProfile?.runtime.timeoutCount ?? 0) > 0) {
      outliers.push(makeOutlier(row, "lightcc_bash_timeout", "critical", row.internalProfile?.runtime.timeoutCount ?? null, 0, [
        `runtimeTimeoutCount=${row.internalProfile?.runtime.timeoutCount ?? "null"}`,
      ]))
    }
    addNumericOutlier(outliers, row, "lightcc_context_outlier", "warn", row.internalProfile?.context.maxEstimatedTokens ?? null, thresholds.contextTokensP95, [
      `maxEstimatedTokens=${row.internalProfile?.context.maxEstimatedTokens ?? "null"}`,
    ])
    addNumericOutlier(outliers, row, "lightcc_transcript_overhead", "warn", transcriptOverhead(row), maxNullable([thresholds.transcriptOverheadP90, 0.2]), [
      `transcriptWriteDurationMs=${row.internalProfile?.transcriptWrite.totalDurationMs ?? "null"}`,
      `observedDurationMs=${row.internalProfile?.observedDurationMs ?? "null"}`,
    ])
  }
  return outliers.sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.kind.localeCompare(right.kind))
}

function coverage(rows: EvalProfileRow[], exists: (row: EvalProfileRow) => boolean, valid: (row: EvalProfileRow) => boolean): ProfileCoverageSummary {
  const validRows = rows.filter(valid).length
  const existingRows = rows.filter(exists).length
  return {
    rows: rows.length,
    valid: validRows,
    missing: rows.length - existingRows,
    invalid: existingRows - validRows,
    coveragePct: pct(validRows, rows.length),
  }
}

function buildItemNotes(group: EvalProfileRow[]): string[] {
  const notes: string[] = []
  const solved = group.filter(isResolvedLike).map((row) => row.coderId).sort()
  if (solved.length > 0) notes.push(`solvedBy=${solved.join(",")}`)
  const providerErrors = group.filter((row) => (row.commonProfile.provider.errorCount ?? 0) > 0).map((row) => row.coderId).sort()
  if (providerErrors.length > 0) notes.push(`providerErrors=${providerErrors.join(",")}`)
  const emptyPatch = group.filter((row) => row.outcome.emptyPatch === true).map((row) => row.coderId).sort()
  if (emptyPatch.length > 0) notes.push(`emptyPatch=${emptyPatch.join(",")}`)
  return notes
}

function addNumericOutlier(
  outliers: OutlierRecord[],
  row: EvalProfileRow,
  kind: string,
  severity: OutlierSeverity,
  value: number | null | undefined,
  threshold: number | null | undefined,
  evidence: string[],
  minimumExclusive = Number.NEGATIVE_INFINITY,
): void {
  if (typeof value !== "number" || typeof threshold !== "number") return
  if (value <= threshold || value <= minimumExclusive) return
  outliers.push(makeOutlier(row, kind, severity, value, threshold, evidence))
}

function makeOutlier(
  row: EvalProfileRow,
  kind: string,
  severity: OutlierSeverity,
  value: number | string | null,
  threshold: number | string | null,
  evidence: string[],
): OutlierRecord {
  return {
    schemaVersion: EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
    kind,
    severity,
    benchmark: row.benchmark,
    itemId: row.itemId,
    coderId: row.coderId,
    value: typeof value === "number" ? round(value) : value,
    threshold: typeof threshold === "number" ? round(threshold) : threshold,
    evidence,
    paths: row.paths,
  }
}

function exceedsAny(pairs: Array<[number | null | undefined, number | null | undefined]>): boolean {
  return pairs.some(([value, threshold]) => typeof value === "number" && typeof threshold === "number" && value > threshold)
}

function lightccToolErrorCount(row: EvalProfileRow): number | null {
  if (!row.internalProfile) return null
  return row.internalProfile.tools.reduce((total, tool) => total + tool.errorCount, 0)
}

function transcriptOverhead(row: EvalProfileRow): number | null {
  return ratio(row.internalProfile?.transcriptWrite.totalDurationMs, row.internalProfile?.observedDurationMs)
}

function differenceFromBest(value: number | null | undefined, candidates: Array<number | null | undefined>): number | null {
  if (typeof value !== "number") return null
  const best = candidates.filter((candidate): candidate is number => typeof candidate === "number").sort((left, right) => left - right)[0]
  return typeof best === "number" ? round(value - best) : null
}

function minBy<T>(items: T[], valueOf: (item: T) => number | null | undefined): T | null {
  return items.reduce<T | null>((best, item) => {
    const value = valueOf(item)
    if (typeof value !== "number") return best
    if (!best) return item
    const bestValue = valueOf(best)
    return typeof bestValue !== "number" || value < bestValue ? item : best
  }, null)
}

function maxBy<T>(items: T[], valueOf: (item: T) => number | null | undefined): T | null {
  return items.reduce<T | null>((best, item) => {
    const value = valueOf(item)
    if (typeof value !== "number") return best
    if (!best) return item
    const bestValue = valueOf(best)
    return typeof bestValue !== "number" || value > bestValue ? item : best
  }, null)
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function severityRank(severity: OutlierSeverity): number {
  if (severity === "critical") return 3
  if (severity === "warn") return 2
  return 1
}
