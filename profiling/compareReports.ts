// Developer-only comparison between two Stage 0 ProfileReport JSON objects.
//
// This is a developer artifact, NOT a product CLI surface and NOT a benchmark.
// It catches obvious harness performance/shape regressions between a baseline
// report and a current report. It consumes only the stable ProfileReport fields
// (see ./report/types.ts); it never parses raw transcripts. See ../README.md and
// spec/phase-8-stage-1.md for the contract.
//
// Two kinds of checks:
//   - strict invariant checks: compared exactly, because FakeProvider scripts make
//     the deterministic harness path produce a fixed internal shape. A mismatch is
//     a `fail`.
//   - performance checks: coarse ratio-plus-absolute-delta thresholds with a
//     `minComparableMs` floor, because deterministic model output does NOT make
//     fsync, shell startup, MCP process startup, or profiler overhead deterministic.
//
// topSlowSpans is diagnostic only and never gates.

import type { ProfileReport, SlowSpan, ToolSummary } from "./report/types"

export type Severity = "pass" | "warn" | "fail" | "info"

export type ComparisonCheck = {
  metric: string
  severity: Severity
  baseline: number | string | null
  current: number | string | null
  ratio?: number | null
  deltaMs?: number | null
  threshold?: string
  reason: string
}

export type ProfileComparison = {
  schemaVersion: 1
  status: "pass" | "warn" | "fail"
  checks: ComparisonCheck[]
  summary: {
    failed: number
    warned: number
    passed: number
    topRegressions: ComparisonCheck[]
  }
  // Diagnostic only: the current report's slowest spans, surfaced when a regression
  // is reported. Never used to gate (span ids and helper timings are too noisy).
  diagnostics?: {
    topSlowSpans: SlowSpan[]
  }
}

// Coarse duration threshold (spec/phase-8-stage-1.md §8). A duration metric fails
// only if baseline >= minComparableMs AND current >= baseline*failRatio AND
// current-baseline >= minFailDeltaMs. Warn uses the analogous warn ratio/delta.
export type DurationThreshold = {
  minComparableMs: number
  warnRatio: number
  failRatio: number
  minWarnDeltaMs: number
  minFailDeltaMs: number
}

// Token/context size growth uses count deltas, not time thresholds (spec §8). It
// only warns; it never fails, since context size is a cost signal, not a hard
// harness invariant.
export type TokenGrowthThreshold = {
  warnRatio: number
  minWarnDeltaTokens: number
}

export type CompareThresholds = {
  duration: DurationThreshold
  // `runtime` and `transcriptWrite` are noisier (shell startup, fsync), so they
  // get a wider failRatio per spec §8.
  runtime: DurationThreshold
  transcriptWrite: DurationThreshold
  tokenGrowth: TokenGrowthThreshold
}

export const DEFAULT_DURATION_THRESHOLD: DurationThreshold = {
  minComparableMs: 25,
  warnRatio: 1.5,
  failRatio: 2.0,
  minWarnDeltaMs: 50,
  minFailDeltaMs: 100,
}

export const DEFAULT_NOISY_THRESHOLD: DurationThreshold = {
  ...DEFAULT_DURATION_THRESHOLD,
  failRatio: 3.0,
}

export const DEFAULT_TOKEN_GROWTH_THRESHOLD: TokenGrowthThreshold = {
  warnRatio: 1.25,
  minWarnDeltaTokens: 500,
}

export const DEFAULT_COMPARE_THRESHOLDS: CompareThresholds = {
  duration: DEFAULT_DURATION_THRESHOLD,
  runtime: DEFAULT_NOISY_THRESHOLD,
  transcriptWrite: DEFAULT_NOISY_THRESHOLD,
  tokenGrowth: DEFAULT_TOKEN_GROWTH_THRESHOLD,
}

export type CompareThresholdsInput = {
  duration?: Partial<DurationThreshold>
  runtime?: Partial<DurationThreshold>
  transcriptWrite?: Partial<DurationThreshold>
  tokenGrowth?: Partial<TokenGrowthThreshold>
}

export type CompareReportsInput = {
  baseline: ProfileReport
  current: ProfileReport
  thresholds?: CompareThresholdsInput
}

const SUPPORTED_SCHEMA_VERSION = 1

export function compareReports(input: CompareReportsInput): ProfileComparison {
  const thresholds = resolveThresholds(input.thresholds)

  // Malformed or unsupported reports produce a failed comparison with clear
  // reasons, not a thrown-only diagnostic (spec §5.1).
  const baselineError = validateReportShape(input.baseline, "baseline")
  const currentError = validateReportShape(input.current, "current")
  if (baselineError || currentError) {
    return finalize(
      [
        {
          metric: "schemaVersion",
          severity: "fail",
          baseline: schemaTag(input.baseline),
          current: schemaTag(input.current),
          reason: [baselineError, currentError].filter(Boolean).join("; "),
        },
      ],
      undefined,
    )
  }

  const b = input.baseline
  const c = input.current
  const checks: ComparisonCheck[] = []

  // --- Strict invariant checks (exact equality; mismatch => fail). ---
  checks.push(strictNumber("session.turnCount", b.session.turnCount, c.session.turnCount))
  checks.push(strictNumber("session.stepCount", b.session.stepCount, c.session.stepCount))
  checks.push(strictNumber("provider.callCount", b.provider.callCount, c.provider.callCount))
  checks.push(strictNumber("context.assembleCount", b.context.assembleCount, c.context.assembleCount))
  checks.push(strictNumber("runtime.bashCount", b.runtime.bashCount, c.runtime.bashCount))
  checks.push(strictNumber("compact.count", b.compact.count, c.compact.count))
  checks.push(strictNumber("mcp.toolCallCount", b.mcp.toolCallCount, c.mcp.toolCallCount))

  // Provider usage counters are exact in FakeProvider scenarios when scripted.
  // Only emit a check when at least one side carries a counter, so scenarios
  // without scripted usage stay quiet.
  for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"] as const) {
    const usage = strictUsageCounter(`provider.${key}`, b.provider[key], c.provider[key])
    if (usage) checks.push(usage)
  }

  // Tool counts by toolName.
  checks.push(...toolCountChecks(b.tools, c.tools))

  // Missing profile data: a current report with no spans is a regression when the
  // baseline had data; either side missing makes the comparison untrustworthy.
  checks.push(missingProfileDataCheck(b, c))

  // --- Performance checks (coarse ratio + absolute delta). ---
  pushMaybe(checks, durationCheck("summary.observedDurationMs", b.summary.observedDurationMs, c.summary.observedDurationMs, thresholds.duration))
  pushAll(checks, categoryTotalChecks(b, c, thresholds.duration))
  pushMaybe(checks, durationCheck("provider.totalDurationMs", b.provider.totalDurationMs, c.provider.totalDurationMs, thresholds.duration))
  pushMaybe(checks, durationCheck("provider.firstTokenMsP50", b.provider.firstTokenMsP50, c.provider.firstTokenMsP50, thresholds.duration))
  pushMaybe(checks, durationCheck("provider.streamMsP50", b.provider.streamMsP50, c.provider.streamMsP50, thresholds.duration))
  pushMaybe(checks, durationCheck("context.totalDurationMs", b.context.totalDurationMs, c.context.totalDurationMs, thresholds.duration))
  pushAll(checks, toolDurationChecks(b.tools, c.tools, thresholds.duration))
  pushMaybe(checks, durationCheck("runtime.durationMsP50", b.runtime.durationMsP50, c.runtime.durationMsP50, thresholds.runtime))
  pushMaybe(checks, durationCheck("runtime.durationMsMax", b.runtime.durationMsMax, c.runtime.durationMsMax, thresholds.runtime))
  pushMaybe(checks, durationCheck("compact.durationMs", b.compact.durationMs, c.compact.durationMs, thresholds.duration))
  pushMaybe(
    checks,
    durationCheck("transcriptWrite.totalDurationMs", b.transcriptWrite.totalDurationMs, c.transcriptWrite.totalDurationMs, thresholds.transcriptWrite),
  )
  pushMaybe(
    checks,
    durationCheck("transcriptWrite.maxDurationMs", b.transcriptWrite.maxDurationMs, c.transcriptWrite.maxDurationMs, thresholds.transcriptWrite),
  )
  pushMaybe(
    checks,
    durationCheck(
      "transcriptWrite.profilerSpanWriteDurationMs",
      b.transcriptWrite.profilerSpanWriteDurationMs,
      c.transcriptWrite.profilerSpanWriteDurationMs,
      thresholds.transcriptWrite,
    ),
  )

  // Token/context growth (warn-only, count delta).
  pushMaybe(checks, tokenGrowthCheck("context.maxEstimatedTokens", b.context.maxEstimatedTokens, c.context.maxEstimatedTokens, thresholds.tokenGrowth))

  return finalize(checks, c.topSlowSpans)
}

// --- Check builders --------------------------------------------------------

function strictNumber(metric: string, baseline: number, current: number): ComparisonCheck {
  if (baseline === current) {
    return { metric, severity: "pass", baseline, current, reason: `matches baseline (${baseline})` }
  }
  return {
    metric,
    severity: "fail",
    baseline,
    current,
    reason: `deterministic invariant changed: expected ${baseline}, got ${current}`,
  }
}

function strictUsageCounter(metric: string, baseline: number | null, current: number | null): ComparisonCheck | null {
  if (baseline === null && current === null) return null
  if (baseline === null || current === null) {
    return {
      metric,
      severity: "fail",
      baseline,
      current,
      reason: `usage counter presence changed: baseline=${fmt(baseline)}, current=${fmt(current)}`,
    }
  }
  if (baseline === current) {
    return { metric, severity: "pass", baseline, current, reason: `matches baseline (${baseline})` }
  }
  return {
    metric,
    severity: "fail",
    baseline,
    current,
    reason: `scripted usage counter changed: expected ${baseline}, got ${current}`,
  }
}

function toolCountChecks(baseline: ToolSummary[], current: ToolSummary[]): ComparisonCheck[] {
  const baseMap = new Map(baseline.map((tool) => [tool.toolName, tool.count]))
  const currentMap = new Map(current.map((tool) => [tool.toolName, tool.count]))
  const names = [...new Set([...baseMap.keys(), ...currentMap.keys()])].sort()
  return names.map((name) => {
    const baseCount = baseMap.get(name) ?? 0
    const currentCount = currentMap.get(name) ?? 0
    if (baseCount === currentCount) {
      return { metric: `tools.${name}.count`, severity: "pass" as const, baseline: baseCount, current: currentCount, reason: `matches baseline (${baseCount})` }
    }
    return {
      metric: `tools.${name}.count`,
      severity: "fail" as const,
      baseline: baseCount,
      current: currentCount,
      reason: `tool call count changed for ${name}: expected ${baseCount}, got ${currentCount}`,
    }
  })
}

function missingProfileDataCheck(baseline: ProfileReport, current: ProfileReport): ComparisonCheck {
  const baselineHas = baseline.summary.profileSpanCount > 0
  const currentHas = current.summary.profileSpanCount > 0
  const metric = "profileData.present"
  if (baselineHas && !currentHas) {
    return {
      metric,
      severity: "fail",
      baseline: baseline.summary.profileSpanCount,
      current: current.summary.profileSpanCount,
      reason: "current report has no profile.span data; was profiling enabled for this run?",
    }
  }
  if (!baselineHas && currentHas) {
    return {
      metric,
      severity: "warn",
      baseline: baseline.summary.profileSpanCount,
      current: current.summary.profileSpanCount,
      reason: "baseline report has no profile.span data; comparison baseline is unreliable",
    }
  }
  if (!baselineHas && !currentHas) {
    return {
      metric,
      severity: "warn",
      baseline: baseline.summary.profileSpanCount,
      current: current.summary.profileSpanCount,
      reason: "neither report contains profile.span data; duration comparison is not meaningful",
    }
  }
  return {
    metric,
    severity: "pass",
    baseline: baseline.summary.profileSpanCount,
    current: current.summary.profileSpanCount,
    reason: "both reports contain profile.span data",
  }
}

function categoryTotalChecks(baseline: ProfileReport, current: ProfileReport, threshold: DurationThreshold): ComparisonCheck[] {
  const baseMap = new Map(baseline.categoryTotals.map((entry) => [entry.category, entry.totalDurationMs]))
  const currentMap = new Map(current.categoryTotals.map((entry) => [entry.category, entry.totalDurationMs]))
  const categories = [...new Set([...baseMap.keys(), ...currentMap.keys()])].sort()
  const checks: ComparisonCheck[] = []
  for (const category of categories) {
    const baseValue = baseMap.has(category) ? (baseMap.get(category) as number) : null
    const currentValue = currentMap.has(category) ? (currentMap.get(category) as number) : null
    pushMaybe(checks, durationCheck(`categoryTotals.${category}.totalDurationMs`, baseValue, currentValue, threshold))
  }
  return checks
}

function toolDurationChecks(baseline: ToolSummary[], current: ToolSummary[], threshold: DurationThreshold): ComparisonCheck[] {
  const currentMap = new Map(current.map((tool) => [tool.toolName, tool]))
  const checks: ComparisonCheck[] = []
  for (const baseTool of baseline) {
    const currentTool = currentMap.get(baseTool.toolName)
    if (!currentTool) continue // disappearance is caught by the strict tool-count check.
    pushMaybe(checks, durationCheck(`tools.${baseTool.toolName}.durationMsP50`, baseTool.durationMsP50, currentTool.durationMsP50, threshold))
    pushMaybe(checks, durationCheck(`tools.${baseTool.toolName}.durationMsMax`, baseTool.durationMsMax, currentTool.durationMsMax, threshold))
  }
  return checks
}

// Returns null when there is genuinely nothing to compare (both sides null).
function durationCheck(metric: string, baseline: number | null, current: number | null, threshold: DurationThreshold): ComparisonCheck | null {
  const label = thresholdLabel(threshold)
  if (baseline === null && current === null) return null
  if (baseline === null || current === null) {
    return {
      metric,
      severity: "info",
      baseline,
      current,
      threshold: label,
      reason: "metric present on only one side; not gated here",
    }
  }
  const deltaMs = round(current - baseline)
  const ratio = baseline > 0 ? round(current / baseline) : null
  if (baseline < threshold.minComparableMs) {
    return {
      metric,
      severity: "info",
      baseline,
      current,
      ratio,
      deltaMs,
      threshold: label,
      reason: `baseline ${baseline}ms below minComparableMs ${threshold.minComparableMs}ms; not gated`,
    }
  }
  if (current >= baseline * threshold.failRatio && deltaMs >= threshold.minFailDeltaMs) {
    return {
      metric,
      severity: "fail",
      baseline,
      current,
      ratio,
      deltaMs,
      threshold: label,
      reason: `regressed: ${current}ms >= ${threshold.failRatio}x baseline ${baseline}ms (delta +${deltaMs}ms)`,
    }
  }
  if (current >= baseline * threshold.warnRatio && deltaMs >= threshold.minWarnDeltaMs) {
    return {
      metric,
      severity: "warn",
      baseline,
      current,
      ratio,
      deltaMs,
      threshold: label,
      reason: `slower: ${current}ms >= ${threshold.warnRatio}x baseline ${baseline}ms (delta +${deltaMs}ms)`,
    }
  }
  return {
    metric,
    severity: "pass",
    baseline,
    current,
    ratio,
    deltaMs,
    threshold: label,
    reason: `within threshold (delta ${deltaMs >= 0 ? "+" : ""}${deltaMs}ms)`,
  }
}

function tokenGrowthCheck(metric: string, baseline: number | null, current: number | null, threshold: TokenGrowthThreshold): ComparisonCheck | null {
  if (baseline === null && current === null) return null
  if (baseline === null || current === null) {
    return { metric, severity: "info", baseline, current, reason: "token estimate present on only one side; not gated" }
  }
  const delta = current - baseline
  const ratio = baseline > 0 ? round(current / baseline) : null
  const label = `growth warnRatio=${threshold.warnRatio} minDelta=${threshold.minWarnDeltaTokens}`
  if (current > baseline * threshold.warnRatio && delta >= threshold.minWarnDeltaTokens) {
    return {
      metric,
      severity: "warn",
      baseline,
      current,
      ratio,
      threshold: label,
      reason: `context grew: ${current} tokens > ${threshold.warnRatio}x baseline ${baseline} (delta +${delta})`,
    }
  }
  return { metric, severity: "pass", baseline, current, ratio, threshold: label, reason: `within growth threshold (delta ${delta >= 0 ? "+" : ""}${delta})` }
}

// --- Assembly --------------------------------------------------------------

function finalize(checks: ComparisonCheck[], topSlowSpans: SlowSpan[] | undefined): ProfileComparison {
  const failed = checks.filter((check) => check.severity === "fail").length
  const warned = checks.filter((check) => check.severity === "warn").length
  const passed = checks.filter((check) => check.severity === "pass").length
  const status: ProfileComparison["status"] = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass"
  const severityRank: Record<Severity, number> = { fail: 0, warn: 1, info: 2, pass: 3 }
  const topRegressions = checks
    .filter((check) => check.severity === "fail" || check.severity === "warn")
    .sort((a, b) => {
      if (severityRank[a.severity] !== severityRank[b.severity]) return severityRank[a.severity] - severityRank[b.severity]
      return (b.ratio ?? 0) - (a.ratio ?? 0)
    })
    .slice(0, 5)

  const comparison: ProfileComparison = {
    schemaVersion: 1,
    status,
    checks,
    summary: { failed, warned, passed, topRegressions },
  }
  if (status !== "pass" && topSlowSpans && topSlowSpans.length > 0) {
    comparison.diagnostics = { topSlowSpans: topSlowSpans.slice(0, 5) }
  }
  return comparison
}

function resolveThresholds(input?: CompareThresholdsInput): CompareThresholds {
  return {
    duration: { ...DEFAULT_DURATION_THRESHOLD, ...input?.duration },
    runtime: { ...DEFAULT_NOISY_THRESHOLD, ...input?.runtime },
    transcriptWrite: { ...DEFAULT_NOISY_THRESHOLD, ...input?.transcriptWrite },
    tokenGrowth: { ...DEFAULT_TOKEN_GROWTH_THRESHOLD, ...input?.tokenGrowth },
  }
}

// Defensive shape validation. Returns a human reason string when the value is not
// a usable schemaVersion:1 ProfileReport, otherwise null.
function validateReportShape(value: unknown, side: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${side} report is not an object`
  }
  const report = value as Record<string, unknown>
  if (report.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return `${side} report has unsupported schemaVersion ${fmt(report.schemaVersion as never)} (expected ${SUPPORTED_SCHEMA_VERSION})`
  }
  for (const key of ["session", "summary", "provider", "context", "runtime", "compact", "mcp", "transcriptWrite"]) {
    if (!report[key] || typeof report[key] !== "object") return `${side} report is missing object field "${key}"`
  }
  if (!Array.isArray(report.tools)) return `${side} report is missing array field "tools"`
  if (!Array.isArray(report.categoryTotals)) return `${side} report is missing array field "categoryTotals"`
  return null
}

function schemaTag(value: unknown): number | string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).schemaVersion
    if (typeof version === "number" || typeof version === "string") return version
    return "missing"
  }
  return "invalid"
}

function pushMaybe(checks: ComparisonCheck[], check: ComparisonCheck | null): void {
  if (check) checks.push(check)
}

function pushAll(checks: ComparisonCheck[], next: ComparisonCheck[]): void {
  for (const check of next) checks.push(check)
}

function thresholdLabel(threshold: DurationThreshold): string {
  return `minComparable=${threshold.minComparableMs}ms warn=${threshold.warnRatio}x/+${threshold.minWarnDeltaMs}ms fail=${threshold.failRatio}x/+${threshold.minFailDeltaMs}ms`
}

function fmt(value: number | string | null): string {
  return value === null ? "null" : String(value)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// Short developer-facing text rendering. Lists failing/warning checks first, then
// surfaces diagnostic top slow spans when present. Keep this terse — it is a quick
// regression readout, not a full report.
export function renderComparison(comparison: ProfileComparison): string {
  const lines: string[] = []
  const { failed, warned, passed } = comparison.summary
  lines.push(`Profile comparison: ${comparison.status.toUpperCase()} (${failed} failed, ${warned} warned, ${passed} passed)`)

  const gating = comparison.checks.filter((check) => check.severity === "fail" || check.severity === "warn")
  if (gating.length === 0) {
    lines.push("  no regressions above coarse thresholds")
  } else {
    for (const check of gating) {
      const tag = check.severity === "fail" ? "FAIL" : "WARN"
      lines.push(`  [${tag}] ${check.metric}: ${check.reason}`)
    }
  }

  if (comparison.diagnostics?.topSlowSpans.length) {
    lines.push("  top slow spans (diagnostic, not gated):")
    for (const span of comparison.diagnostics.topSlowSpans) {
      lines.push(`    - ${span.name} [${span.category}] ${span.durationMs}ms`)
    }
  }
  return lines.join("\n")
}
