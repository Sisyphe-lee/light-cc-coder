import type { CoderProfileSummary, EvalProfileAnalysisResult, EvalProfileRow, OutlierRecord } from "./types"

export function renderProfileAnalysisMarkdown(result: EvalProfileAnalysisResult): string {
  const lines: string[] = []
  lines.push("# Eval Profile Analysis")
  lines.push("")
  lines.push("## 1. Coverage")
  lines.push("")
  lines.push(`- Rows: ${result.summary.rowCount}`)
  lines.push(`- Items: ${result.summary.itemCount}`)
  lines.push(`- Coders: ${result.summary.coderCount}`)
  lines.push(`- Benchmarks: ${result.summary.benchmarks.join(", ") || "-"}`)
  lines.push(`- Run IDs: ${result.summary.runIds.join(", ") || "-"}`)
  lines.push("")
  lines.push("| Profile | Valid | Missing | Invalid | Coverage |")
  lines.push("| --- | ---: | ---: | ---: | ---: |")
  lines.push(`| wrapper.profile.json | ${result.summary.coverage.wrapper.valid} | ${result.summary.coverage.wrapper.missing} | ${result.summary.coverage.wrapper.invalid} | ${fmtPct(result.summary.coverage.wrapper.coveragePct)} |`)
  lines.push(`| provider.profile.json | ${result.summary.coverage.provider.valid} | ${result.summary.coverage.provider.missing} | ${result.summary.coverage.provider.invalid} | ${fmtPct(result.summary.coverage.provider.coveragePct)} |`)
  lines.push(`| LightCC internal profile | ${result.summary.coverage.internal.valid} | ${result.summary.coverage.internal.missing} | ${result.summary.coverage.internal.invalid} | ${fmtPct(result.summary.coverage.internal.coveragePct)} |`)
  if (result.summary.warnings.count > 0) {
    lines.push("")
    lines.push(`Warnings: ${result.summary.warnings.count}`)
    for (const warning of result.summary.warnings.examples.slice(0, 8)) lines.push(`- ${warning}`)
  }

  lines.push("")
  lines.push("## 2. Official Outcomes")
  lines.push("")
  lines.push("| Outcome | Rows |")
  lines.push("| --- | ---: |")
  for (const [outcome, count] of Object.entries(result.summary.outcomes)) lines.push(`| ${outcome} | ${count} |`)
  lines.push("")
  lines.push("| Outcome | Rows | Requests | Tokens | Cost | Wrapper Time | Provider Latency |")
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const split of result.outcomeSplits) {
    lines.push(`| ${split.outcome} | ${split.rows} | ${fmtNumber(split.requestCount)} | ${fmtNumber(split.totalTokens)} | ${fmtUsd(split.estimatedUsd)} | ${fmtDuration(split.wrapperDurationMs)} | ${fmtDuration(split.providerLatencyMs)} |`)
  }

  lines.push("")
  lines.push("## 3. Public Cross-Coder Profiling")
  lines.push("")
  lines.push("公共横比只使用 official outcome、wrapper profile、provider profile 和 bounded artifact metadata。")
  lines.push("")
  lines.push("| Coder | Rows | Resolved | Requests | Tokens | Cost | Provider Errors | Wrapper Time | Nonzero Exit | Provider Cov | Wrapper Cov |")
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const coder of result.coderSummary) lines.push(renderCoderRow(coder))

  lines.push("")
  lines.push("## 4. Per-Task Matrix")
  lines.push("")
  lines.push("| Item | Solved Coders | Cheapest Resolved | Fastest Resolved | Most Expensive Failure | Notes |")
  lines.push("| --- | --- | --- | --- | --- | --- |")
  for (const item of result.itemMatrix.slice(0, 60)) {
    lines.push(`| ${escapeCell(item.itemId)} | ${escapeCell(item.solvedCoders.join(", ") || "-")} | ${item.cheapestResolvedCoder ?? "-"} | ${item.fastestResolvedCoder ?? "-"} | ${item.mostExpensiveFailure ?? "-"} | ${escapeCell(item.notes.join("; ") || "-")} |`)
  }
  if (result.itemMatrix.length > 60) lines.push(`| ... | ${result.itemMatrix.length - 60} more items | - | - | - | - |`)

  lines.push("")
  lines.push("## 5. Failure Cost Analysis")
  lines.push("")
  const expensiveFailures = result.outliers.filter((outlier) => outlier.kind === "high_cost_failure").slice(0, 20)
  if (expensiveFailures.length === 0) {
    lines.push("No high-cost failure outliers detected.")
  } else {
    lines.push("| Coder | Item | Value | Threshold | Evidence |")
    lines.push("| --- | --- | ---: | ---: | --- |")
    for (const outlier of expensiveFailures) lines.push(renderOutlierRow(outlier))
  }

  lines.push("")
  lines.push("## 6. Provider Behavior")
  lines.push("")
  lines.push("| Coder | Avg Tokens / Request | Cache Hit | Cost / Resolved | Requests / Resolved |")
  lines.push("| --- | ---: | ---: | ---: | ---: |")
  for (const coder of result.coderSummary) {
    const avgTokens = coder.requestCount && coder.totalTokens ? coder.totalTokens / coder.requestCount : null
    lines.push(`| ${coder.coderId} | ${fmtNumber(avgTokens)} | ${fmtRatio(coder.cacheHitRatio)} | ${fmtUsd(coder.costPerResolved)} | ${fmtNumber(coder.requestsPerResolved)} |`)
  }

  lines.push("")
  lines.push("## 7. Wrapper Behavior")
  lines.push("")
  lines.push("| Coder | Wrapper Time | Nonzero Exit | Wrapper Coverage |")
  lines.push("| --- | ---: | ---: | ---: |")
  for (const coder of result.coderSummary) {
    lines.push(`| ${coder.coderId} | ${fmtDuration(coder.totalWrapperDurationMs)} | ${coder.wrapperNonzeroExitCount} | ${fmtPct(coder.wrapperCoveragePct)} |`)
  }

  lines.push("")
  lines.push("## 8. LightCC Internal Diagnosis")
  lines.push("")
  const lightccRows = result.rows.filter((row) => row.coderId === "lightcc" && row.internalProfile)
  if (lightccRows.length === 0) {
    lines.push("No LightCC internal profile rows were associated.")
  } else {
    lines.push(renderLightccInternalSummary(lightccRows))
  }

  lines.push("")
  lines.push("## 9. Outliers")
  lines.push("")
  if (result.outliers.length === 0) {
    lines.push("No outliers detected by the first-pass rules.")
  } else {
    lines.push("| Severity | Kind | Coder | Item | Value | Threshold | Evidence |")
    lines.push("| --- | --- | --- | --- | ---: | ---: | --- |")
    for (const outlier of result.outliers.slice(0, 80)) lines.push(renderOutlierRowWithSeverity(outlier))
  }

  lines.push("")
  lines.push("## 10. Action Items")
  lines.push("")
  lines.push(...buildActionItems(result))
  lines.push("")
  return `${lines.join("\n")}\n`
}

function renderCoderRow(coder: CoderProfileSummary): string {
  return `| ${coder.coderId} | ${coder.rows} | ${coder.resolved} | ${fmtNumber(coder.requestCount)} | ${fmtNumber(coder.totalTokens)} | ${fmtUsd(coder.estimatedUsd)} | ${fmtNumber(coder.providerErrors)} | ${fmtDuration(coder.totalWrapperDurationMs)} | ${coder.wrapperNonzeroExitCount} | ${fmtPct(coder.providerCoveragePct)} | ${fmtPct(coder.wrapperCoveragePct)} |`
}

function renderLightccInternalSummary(rows: EvalProfileRow[]): string {
  const categoryCounts = new Map<string, { durationMs: number; spans: number }>()
  for (const row of rows) {
    for (const category of row.internalProfile?.categoryTotals ?? []) {
      const current = categoryCounts.get(category.category) ?? { durationMs: 0, spans: 0 }
      current.durationMs += category.totalDurationMs
      current.spans += category.spanCount
      categoryCounts.set(category.category, current)
    }
  }
  const toolRows = new Map<string, { count: number; errors: number; timeouts: number }>()
  for (const row of rows) {
    for (const tool of row.internalProfile?.tools ?? []) {
      const current = toolRows.get(tool.toolName) ?? { count: 0, errors: 0, timeouts: 0 }
      current.count += tool.count
      current.errors += tool.errorCount
      current.timeouts += tool.timeoutCount
      toolRows.set(tool.toolName, current)
    }
  }
  const lines: string[] = []
  lines.push("| Category | Duration | Spans |")
  lines.push("| --- | ---: | ---: |")
  for (const [category, total] of [...categoryCounts.entries()].sort((left, right) => right[1].durationMs - left[1].durationMs)) {
    lines.push(`| ${category} | ${fmtDuration(total.durationMs)} | ${total.spans} |`)
  }
  lines.push("")
  lines.push("| Tool | Calls | Errors | Timeouts |")
  lines.push("| --- | ---: | ---: | ---: |")
  for (const [tool, total] of [...toolRows.entries()].sort((left, right) => right[1].count - left[1].count).slice(0, 20)) {
    lines.push(`| ${tool} | ${total.count} | ${total.errors} | ${total.timeouts} |`)
  }
  return lines.join("\n")
}

function buildActionItems(result: EvalProfileAnalysisResult): string[] {
  const items: string[] = []
  const providerErrors = result.outliers.filter((outlier) => outlier.kind === "provider_error")
  const wrapperFailures = result.outliers.filter((outlier) => outlier.kind === "wrapper_nonzero_exit")
  const emptyPatches = result.outliers.filter((outlier) => outlier.kind === "empty_patch")
  const transcriptOverhead = result.outliers.filter((outlier) => outlier.kind === "lightcc_transcript_overhead")
  if (providerErrors.length > 0) items.push(`- Inspect provider retry/error behavior first: provider_error outliers=${providerErrors.length}.`)
  if (wrapperFailures.length > 0) items.push(`- Review wrapper runtime failures before model-level attribution: wrapper_nonzero_exit outliers=${wrapperFailures.length}.`)
  if (emptyPatches.length > 0) items.push(`- Add or tighten patch quality guards for empty patches: empty_patch outliers=${emptyPatches.length}.`)
  if (transcriptOverhead.length > 0) items.push(`- Investigate LightCC transcript write overhead: lightcc_transcript_overhead outliers=${transcriptOverhead.length}.`)
  if (items.length === 0) items.push("- No first-pass action item crossed the configured outlier thresholds.")
  return items
}

function renderOutlierRow(outlier: OutlierRecord): string {
  return `| ${outlier.coderId} | ${escapeCell(outlier.itemId)} | ${fmtValue(outlier.value)} | ${fmtValue(outlier.threshold)} | ${escapeCell(outlier.evidence.join("; "))} |`
}

function renderOutlierRowWithSeverity(outlier: OutlierRecord): string {
  return `| ${outlier.severity} | ${outlier.kind} | ${outlier.coderId} | ${escapeCell(outlier.itemId)} | ${fmtValue(outlier.value)} | ${fmtValue(outlier.threshold)} | ${escapeCell(outlier.evidence.join("; "))} |`
}

function fmtValue(value: number | string | null): string {
  if (typeof value === "number") return fmtNumber(value)
  return value ?? "-"
}

function fmtNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value)
}

function fmtDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  if (value < 1000) return `${fmtNumber(value)} ms`
  return `${fmtNumber(value / 1000)} s`
}

function fmtUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return `$${value.toFixed(6)}`
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return `${fmtNumber(value)}%`
}

function fmtRatio(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return `${fmtNumber(value * 100)}%`
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ")
}
