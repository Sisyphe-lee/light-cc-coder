import type { ProfileReport } from "./types"

// Human-readable summary. Diagnostic only: it reports where time/cost went and a
// local bottleneck heuristic. It never claims task quality or prescribes fixes.
export function renderText(report: ProfileReport): string {
  const lines: string[] = []
  const ms = (value: number | null): string => (value === null ? "n/a" : `${value}ms`)
  const n = (value: number | null): string => (value === null ? "n/a" : String(value))

  lines.push(`Profile report (schema v${report.schemaVersion})`)
  lines.push(`  source: ${report.sourceTranscript || "(unknown)"}`)
  if (report.generatedAt) lines.push(`  generated: ${report.generatedAt}`)
  lines.push(
    `  session: ${report.session.sessionId ?? "(unknown)"}  turns=${report.session.turnCount}  steps=${report.session.stepCount}`,
  )
  lines.push(
    `  observed: ${report.summary.observedDurationMs}ms across ${report.summary.profileSpanCount} span(s); top bottleneck: ${report.summary.topBottleneck ?? "(none)"}`,
  )

  if (report.categoryTotals.length > 0) {
    lines.push("")
    lines.push("Category totals (inclusive):")
    for (const total of report.categoryTotals) {
      lines.push(`  ${pad(total.category, 12)} ${total.totalDurationMs}ms  (${total.spanCount} span)`)
    }
  }

  if (report.topSlowSpans.length > 0) {
    lines.push("")
    lines.push("Top slow spans:")
    for (const span of report.topSlowSpans) {
      lines.push(`  ${span.durationMs}ms  ${pad(span.category, 10)} ${span.name} [${span.status}]`)
    }
  }

  const p = report.provider
  lines.push("")
  lines.push("Provider:")
  lines.push(`  calls=${p.callCount}  total=${p.totalDurationMs}ms  retries=${p.retryCount}`)
  lines.push(`  first-token p50/max=${ms(p.firstTokenMsP50)}/${ms(p.firstTokenMsMax)}  stream p50/max=${ms(p.streamMsP50)}/${ms(p.streamMsMax)}`)
  lines.push(
    `  tokens in/out=${n(p.inputTokens)}/${n(p.outputTokens)}  cache read/write=${n(p.cacheReadInputTokens)}/${n(p.cacheWriteInputTokens)}`,
  )
  if (p.failureClasses.length > 0) {
    lines.push(`  failures: ${p.failureClasses.map((f) => `${f.class}=${f.count}`).join(", ")}`)
  }

  lines.push("")
  lines.push("Context:")
  lines.push(
    `  assemblies=${report.context.assembleCount}  total=${report.context.totalDurationMs}ms  maxEstimatedTokens=${n(report.context.maxEstimatedTokens)}`,
  )

  if (report.tools.length > 0) {
    lines.push("")
    lines.push("Tools:")
    for (const tool of report.tools) {
      lines.push(
        `  ${pad(tool.toolName, 14)} count=${tool.count}  p50/max=${ms(tool.durationMsP50)}/${ms(tool.durationMsMax)}  err=${tool.errorCount} denied=${tool.deniedCount} timeout=${tool.timeoutCount}`,
      )
    }
  }

  const r = report.runtime
  if (r.bashCount > 0) {
    lines.push("")
    lines.push("Runtime (bash):")
    lines.push(
      `  count=${r.bashCount}  p50/max=${ms(r.durationMsP50)}/${ms(r.durationMsMax)}  nonzeroExit=${r.nonzeroExitCount} timeout=${r.timeoutCount} truncated=${r.truncatedCount}`,
    )
  }

  if (report.approval.count > 0) {
    lines.push("")
    lines.push(
      `Approval: requests=${report.approval.count}  allow=${report.approval.allowCount}  deny=${report.approval.denyCount}`,
    )
  }

  if (report.mcp.serverStartupCount > 0 || report.mcp.toolCallCount > 0) {
    lines.push("")
    lines.push(
      `MCP: servers=${report.mcp.serverStartupCount}  ready=${report.mcp.readyCount}  failed=${report.mcp.failedCount}  toolCalls=${report.mcp.toolCallCount}`,
    )
  }

  if (report.compact.count > 0) {
    lines.push("")
    lines.push(
      `Compact: count=${report.compact.count}  failed=${report.compact.failedCount}  tokens pre/post=${n(report.compact.preCompactEstimatedTokens)}/${n(report.compact.postCompactEstimatedTokens)}`,
    )
  }

  const tw = report.transcriptWrite
  lines.push("")
  lines.push("Transcript write:")
  lines.push(
    `  writes=${tw.writeCount}  total=${ms(tw.totalDurationMs)}  max=${ms(tw.maxDurationMs)}  bytes=${n(tw.totalBytes)}`,
  )
  lines.push(
    `  profiler self-overhead: spanWrites=${tw.profilerSpanWriteCount}  ${ms(tw.profilerSpanWriteDurationMs)}`,
  )

  if (report.warnings.length > 0) {
    lines.push("")
    lines.push("Warnings:")
    for (const warning of report.warnings) lines.push(`  - ${warning}`)
  }

  return lines.join("\n")
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}
