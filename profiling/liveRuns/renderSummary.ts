// Short human read-out for a live-runs aggregate. It states bounded timing facts
// and points at the per-run reports. It deliberately does NOT judge task quality,
// rank model capability, or prescribe automatic optimization (spec §6 / §8).

import type { LiveRunsSummary, Stats } from "./aggregate"

export function renderLiveRunsSummary(summary: LiveRunsSummary): string {
  const lines: string[] = []
  const identity = summary.scenario ? `scenario "${summary.scenario}"` : summary.promptFile ? `prompt-file ${summary.promptFile}` : "live runs"
  const { included, warmup, failed, skipped } = summary.counts

  lines.push(
    `Live profiling: ${identity} — ${included} included run(s), ${fmtMs(summary.wallClockMsTotal)} total wall-clock` +
      (warmup > 0 ? `, ${warmup} warmup` : "") +
      (failed > 0 ? `, ${failed} failed` : "") +
      (skipped > 0 ? `, ${skipped} skipped` : ""),
  )

  if (included === 0) {
    lines.push("  no included runs with profile data; see warnings and per-run reports")
    appendWarnings(lines, summary)
    return lines.join("\n")
  }

  // Bottleneck ranking by median category total.
  lines.push("  bottleneck ranking (median category total):")
  for (const entry of summary.categoryTotals.slice(0, 6)) {
    lines.push(`    ${entry.category.padEnd(12)} ${fmtStat(entry)}`)
  }

  // Provider — expected to dominate real wall-clock.
  const provider = summary.provider
  lines.push("  provider:")
  lines.push(`    TTFT          ${fmtStatOrNull(provider.firstTokenMs)}`)
  lines.push(`    stream        ${fmtStatOrNull(provider.streamMs)}`)
  lines.push(`    total         ${fmtStatOrNull(provider.totalDurationMs)}`)
  if (provider.inputTokens || provider.outputTokens) {
    lines.push(`    tokens in/out ${fmtStatOrNull(provider.inputTokens)} / ${fmtStatOrNull(provider.outputTokens)}`)
  }
  if (provider.cacheReadInputTokens || provider.cacheWriteInputTokens) {
    lines.push(`    cache rd/wr   ${fmtStatOrNull(provider.cacheReadInputTokens)} / ${fmtStatOrNull(provider.cacheWriteInputTokens)}`)
  }
  if (provider.retryCount && provider.retryCount.max > 0) {
    lines.push(`    retries       ${fmtStatOrNull(provider.retryCount)}`)
  }

  // Notable non-provider costs.
  const notable: string[] = []
  pushNotable(notable, "transcriptWrite", summary.transcriptWrite.totalDurationMs)
  pushNotable(notable, "context", summary.context.totalDurationMs)
  pushNotable(notable, "runtime/bash", summary.runtime.durationMs)
  if (summary.tools.length > 0) {
    const tool = summary.tools[0]
    notable.push(`tools(${tool.toolName}×${tool.count}) ${fmtStatOrNull(tool.durationMsP50)}`)
  }
  if (summary.compact.count > 0) notable.push(`compact×${summary.compact.count} ${fmtStatOrNull(summary.compact.durationMs)}`)
  if (notable.length > 0) {
    lines.push("  notable non-provider costs:")
    for (const item of notable) lines.push(`    ${item}`)
  }

  // Top bottleneck frequency across runs.
  if (summary.topBottleneckFrequency.length > 0) {
    const freq = summary.topBottleneckFrequency.map((entry) => `${entry.category}×${entry.count}`).join(", ")
    lines.push(`  top bottleneck frequency: ${freq}`)
  }

  appendWarnings(lines, summary)

  // Point at the raw bounded reports.
  if (summary.includedReportPaths.length > 0) {
    lines.push("  per-run reports:")
    for (const path of summary.includedReportPaths) lines.push(`    ${path}`)
  }

  return lines.join("\n")
}

function appendWarnings(lines: string[], summary: LiveRunsSummary): void {
  if (summary.warnings.length > 0) {
    lines.push("  warnings:")
    for (const warning of summary.warnings) lines.push(`    - ${warning}`)
  }
  for (const failure of summary.failures) {
    lines.push(`  ${failure.status} run #${failure.index}: ${failure.error ?? "no detail"}`)
  }
}

function pushNotable(notable: string[], label: string, stat: Stats | null): void {
  if (stat && stat.median > 0) notable.push(`${label} ${fmtStat(stat)}`)
}

function fmtStat(stat: Stats): string {
  return `median ${fmtMs(stat.median)} (min ${fmtMs(stat.min)}, max ${fmtMs(stat.max)}, IQR ${fmtMs(stat.iqr)})`
}

function fmtStatOrNull(stat: Stats | null): string {
  return stat ? fmtStat(stat) : "n/a"
}

function fmtMs(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2)
}
