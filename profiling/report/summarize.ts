import {
  PROFILE_REPORT_SCHEMA_VERSION,
  type CategoryTotal,
  type FailureClassCount,
  type ProfileReport,
  type SlowSpan,
  type ToolSummary,
} from "./types"

// The reducer consumes parsed JSONL events as opaque records and reads only the
// stable, documented profile/diagnostic fields. It never depends on light-cc-coder
// runtime types, and it must not call providers, run tools, or mutate input.

export type AnyEvent = Record<string, unknown>

export type SummarizeOptions = {
  sourceTranscript?: string
  generatedAt?: string
  topSlowSpanLimit?: number
}

type ProfileSpan = {
  spanId: string
  parentSpanId?: string
  name: string
  category: string
  status: string
  startMs: number
  durationMs: number
  attributes: Record<string, unknown>
}

export function summarizeProfile(events: AnyEvent[], options: SummarizeOptions = {}): ProfileReport {
  const warnings: string[] = []
  const spans: ProfileSpan[] = []
  let malformedSpanCount = 0

  let sessionId: string | null = null
  let cwd: string | null = null
  let turnCount = 0
  let stepCount = 0

  const bashObservations: AnyEvent[] = []
  const permissionDecisions: AnyEvent[] = []
  const approvalRequested: AnyEvent[] = []
  const approvalResponded: AnyEvent[] = []
  const providerRetries: AnyEvent[] = []
  const providerFailures: AnyEvent[] = []
  const contextSteps: AnyEvent[] = []
  const compactStarted: AnyEvent[] = []
  const compactEnded: AnyEvent[] = []
  const mcpStarted: AnyEvent[] = []
  const mcpReady: AnyEvent[] = []
  const mcpFailed: AnyEvent[] = []
  const toolCalls: AnyEvent[] = []

  for (const event of events) {
    if (!event || typeof event !== "object") continue
    const type = str(event.type)
    if (sessionId === null) sessionId = str(event.sessionId) ?? null
    switch (type) {
      case "profile.span": {
        const span = readSpan(event)
        if (span) spans.push(span)
        else malformedSpanCount += 1
        break
      }
      case "session.started":
        cwd = str(event.cwd) ?? cwd
        break
      case "turn.started":
        turnCount += 1
        break
      case "step.started":
        stepCount += 1
        break
      case "bash.observation":
        bashObservations.push(event)
        break
      case "permission.decision":
        permissionDecisions.push(event)
        break
      case "approval.requested":
        approvalRequested.push(event)
        break
      case "approval.responded":
        approvalResponded.push(event)
        break
      case "provider.retry":
        providerRetries.push(event)
        break
      case "provider.failure":
        providerFailures.push(event)
        break
      case "context.step":
        contextSteps.push(event)
        break
      case "compact.started":
        compactStarted.push(event)
        break
      case "compact.ended":
        compactEnded.push(event)
        break
      case "mcp.server.started":
        mcpStarted.push(event)
        break
      case "mcp.server.ready":
        mcpReady.push(event)
        break
      case "mcp.server.failed":
        mcpFailed.push(event)
        break
      case "tool.call":
        toolCalls.push(event)
        break
      default:
        break
    }
  }

  if (malformedSpanCount > 0) warnings.push(`${malformedSpanCount} malformed profile.span event(s) ignored`)
  if (spans.length === 0) {
    warnings.push("transcript contains no profile.span events; was it recorded with profiling enabled?")
  }

  const spanById = new Map(spans.map((span) => [span.spanId, span]))
  let danglingParents = 0
  for (const span of spans) {
    if (span.parentSpanId && !spanById.has(span.parentSpanId)) danglingParents += 1
  }
  if (danglingParents > 0) warnings.push(`${danglingParents} span(s) reference an unknown parentSpanId`)

  const transcriptAggregate = spans.find((span) => span.category === "transcript" && span.name === "transcript.write")
  const lifecycleSpans = spans.filter((span) => span !== transcriptAggregate)

  return {
    schemaVersion: PROFILE_REPORT_SCHEMA_VERSION,
    sourceTranscript: options.sourceTranscript ?? "",
    generatedAt: options.generatedAt ?? "",
    session: { sessionId, cwd, turnCount, stepCount },
    summary: {
      observedDurationMs: observedDuration(lifecycleSpans),
      profileSpanCount: spans.length,
      topBottleneck: topBottleneck(spans),
    },
    categoryTotals: categoryTotals(spans),
    topSlowSpans: topSlowSpans(spans, options.topSlowSpanLimit ?? 10),
    provider: providerSummary(spans, providerRetries, providerFailures),
    context: contextSummary(spans, contextSteps),
    tools: toolSummary(spans, permissionDecisions),
    approval: approvalSummary(spans, approvalRequested, approvalResponded),
    runtime: runtimeSummary(bashObservations),
    mcp: mcpSummary(mcpStarted, mcpReady, mcpFailed, toolCalls),
    compact: compactSummary(spans, compactStarted, compactEnded),
    transcriptWrite: transcriptWriteSummary(transcriptAggregate, warnings),
    warnings,
  }
}

function readSpan(event: AnyEvent): ProfileSpan | undefined {
  const spanId = str(event.spanId)
  const name = str(event.name)
  const category = str(event.category)
  const status = str(event.status)
  const startMs = num(event.startMs)
  const durationMs = num(event.durationMs)
  if (spanId === undefined || name === undefined || category === undefined) return undefined
  if (startMs === undefined || durationMs === undefined) return undefined
  const attributes =
    event.attributes && typeof event.attributes === "object" && !Array.isArray(event.attributes)
      ? (event.attributes as Record<string, unknown>)
      : {}
  return {
    spanId,
    parentSpanId: str(event.parentSpanId),
    name,
    category,
    status: status ?? "ok",
    startMs,
    durationMs,
    attributes,
  }
}

function observedDuration(spans: ProfileSpan[]): number {
  if (spans.length === 0) return 0
  let min = Infinity
  let max = -Infinity
  for (const span of spans) {
    if (span.startMs < min) min = span.startMs
    const end = span.startMs + span.durationMs
    if (end > max) max = end
  }
  return round(max - min)
}

function categoryTotals(spans: ProfileSpan[]): CategoryTotal[] {
  const totals = new Map<string, { totalDurationMs: number; spanCount: number }>()
  for (const span of spans) {
    const entry = totals.get(span.category) ?? { totalDurationMs: 0, spanCount: 0 }
    entry.totalDurationMs += span.durationMs
    entry.spanCount += 1
    totals.set(span.category, entry)
  }
  return [...totals.entries()]
    .map(([category, entry]) => ({ category, totalDurationMs: round(entry.totalDurationMs), spanCount: entry.spanCount }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
}

function topBottleneck(spans: ProfileSpan[]): string | null {
  const totals = categoryTotals(spans)
  return totals.length > 0 ? totals[0].category : null
}

function topSlowSpans(spans: ProfileSpan[], limit: number): SlowSpan[] {
  return [...spans]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .map((span) => ({
      spanId: span.spanId,
      name: span.name,
      category: span.category,
      status: span.status,
      durationMs: round(span.durationMs),
    }))
}

function providerSummary(spans: ProfileSpan[], retries: AnyEvent[], failures: AnyEvent[]) {
  const providerSpans = spans.filter((span) => span.category === "provider" && span.name === "provider.step")
  const firstTokens: number[] = []
  const streams: number[] = []
  let totalDurationMs = 0
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let cacheRead: number | null = null
  let cacheWrite: number | null = null
  for (const span of providerSpans) {
    totalDurationMs += span.durationMs
    streams.push(span.durationMs)
    const firstToken = num(span.attributes.firstTokenMs)
    if (firstToken !== undefined) firstTokens.push(firstToken)
    inputTokens = addOptional(inputTokens, num(span.attributes.inputTokens))
    outputTokens = addOptional(outputTokens, num(span.attributes.outputTokens))
    cacheRead = addOptional(cacheRead, num(span.attributes.cacheReadInputTokens))
    cacheWrite = addOptional(cacheWrite, num(span.attributes.cacheWriteInputTokens))
  }
  const failureClasses = new Map<string, number>()
  for (const failure of failures) {
    const cls = str(failure.classification) ?? "unknown"
    failureClasses.set(cls, (failureClasses.get(cls) ?? 0) + 1)
  }
  const failureClassList: FailureClassCount[] = [...failureClasses.entries()]
    .map(([cls, count]) => ({ class: cls, count }))
    .sort((a, b) => b.count - a.count)
  return {
    callCount: providerSpans.length,
    totalDurationMs: round(totalDurationMs),
    firstTokenMsP50: p50(firstTokens),
    firstTokenMsMax: max(firstTokens),
    streamMsP50: p50(streams),
    streamMsMax: max(streams),
    retryCount: retries.length,
    failureClasses: failureClassList,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
  }
}

function contextSummary(spans: ProfileSpan[], contextSteps: AnyEvent[]) {
  const contextSpans = spans.filter((span) => span.category === "context" && span.name === "context.assemble_step")
  let totalDurationMs = 0
  let maxEstimatedTokens: number | null = null
  for (const span of contextSpans) {
    totalDurationMs += span.durationMs
    maxEstimatedTokens = maxOptional(maxEstimatedTokens, num(span.attributes.estimatedTokens))
  }
  for (const step of contextSteps) {
    const snapshot = step.snapshot
    if (snapshot && typeof snapshot === "object") {
      maxEstimatedTokens = maxOptional(maxEstimatedTokens, num((snapshot as AnyEvent).estimatedTokens))
    }
  }
  return {
    assembleCount: contextSpans.length,
    totalDurationMs: round(totalDurationMs),
    maxEstimatedTokens,
  }
}

function toolSummary(spans: ProfileSpan[], permissionDecisions: AnyEvent[]): ToolSummary[] {
  const toolSpans = spans.filter((span) => span.category === "tool" && span.name === "tool.execute")
  const byTool = new Map<string, { durations: number[]; errorCount: number; timeoutCount: number }>()
  for (const span of toolSpans) {
    const toolName = str(span.attributes.toolName) ?? "unknown"
    const entry = byTool.get(toolName) ?? { durations: [], errorCount: 0, timeoutCount: 0 }
    entry.durations.push(span.durationMs)
    if (span.status === "error") entry.errorCount += 1
    if (span.status === "timeout") entry.timeoutCount += 1
    byTool.set(toolName, entry)
  }
  const deniedByTool = new Map<string, number>()
  for (const decision of permissionDecisions) {
    if (str(decision.decision) !== "deny") continue
    const toolName = str(decision.toolName) ?? "unknown"
    deniedByTool.set(toolName, (deniedByTool.get(toolName) ?? 0) + 1)
  }
  return [...byTool.entries()]
    .map(([toolName, entry]) => ({
      toolName,
      count: entry.durations.length,
      durationMsP50: p50(entry.durations),
      durationMsMax: max(entry.durations),
      errorCount: entry.errorCount,
      deniedCount: deniedByTool.get(toolName) ?? 0,
      timeoutCount: entry.timeoutCount,
    }))
    .sort((a, b) => b.count - a.count)
}

function approvalSummary(spans: ProfileSpan[], requested: AnyEvent[], responded: AnyEvent[]) {
  let allowCount = 0
  let denyCount = 0
  for (const event of responded) {
    if (str(event.decision) === "allow") allowCount += 1
    else if (str(event.decision) === "deny") denyCount += 1
  }
  const waits = spans.filter((span) => span.category === "approval" && span.name === "approval.wait").map((span) => span.durationMs)
  return {
    count: requested.length,
    allowCount,
    denyCount,
    waitMsTotal: waits.length > 0 ? round(waits.reduce((sum, value) => sum + value, 0)) : null,
    waitMsMax: max(waits),
  }
}

function runtimeSummary(observations: AnyEvent[]) {
  const durations: number[] = []
  let nonzeroExitCount = 0
  let timeoutCount = 0
  let truncatedCount = 0
  for (const event of observations) {
    const duration = num(event.durationMs)
    if (duration !== undefined) durations.push(duration)
    const exitCode = num(event.exitCode)
    if (exitCode !== undefined && exitCode !== 0) nonzeroExitCount += 1
    if (event.timedOut === true) timeoutCount += 1
    if (event.stdoutTruncated === true || event.stderrTruncated === true) truncatedCount += 1
  }
  return {
    bashCount: observations.length,
    durationMsP50: p50(durations),
    durationMsMax: max(durations),
    nonzeroExitCount,
    timeoutCount,
    truncatedCount,
  }
}

function mcpSummary(started: AnyEvent[], ready: AnyEvent[], failed: AnyEvent[], toolCalls: AnyEvent[]) {
  let toolCallCount = 0
  for (const event of toolCalls) {
    const call = event.call
    const name = call && typeof call === "object" ? str((call as AnyEvent).name) : undefined
    if (name && name.startsWith("mcp__")) toolCallCount += 1
  }
  return {
    serverStartupCount: started.length,
    readyCount: ready.length,
    failedCount: failed.length,
    toolCallCount,
  }
}

function compactSummary(spans: ProfileSpan[], started: AnyEvent[], ended: AnyEvent[]) {
  let failedCount = 0
  let preCompactEstimatedTokens: number | null = null
  let postCompactEstimatedTokens: number | null = null
  for (const event of ended) {
    if (str(event.status) === "failed") failedCount += 1
    preCompactEstimatedTokens = lastOptional(preCompactEstimatedTokens, num(event.preCompactEstimatedTokens))
    postCompactEstimatedTokens = lastOptional(postCompactEstimatedTokens, num(event.postCompactEstimatedTokens))
  }
  const runDurations = spans.filter((span) => span.category === "compact" && span.name === "compact.run").map((span) => span.durationMs)
  return {
    count: started.length,
    failedCount,
    durationMs: runDurations.length > 0 ? round(runDurations.reduce((sum, value) => sum + value, 0)) : null,
    preCompactEstimatedTokens,
    postCompactEstimatedTokens,
  }
}

function transcriptWriteSummary(aggregate: ProfileSpan | undefined, warnings: string[]) {
  if (!aggregate) {
    warnings.push("no transcript.write span; transcript write timings unavailable")
    return {
      writeCount: 0,
      totalDurationMs: null,
      maxDurationMs: null,
      totalBytes: null,
      profilerSpanWriteCount: 0,
      profilerSpanWriteDurationMs: null,
    }
  }
  const attrs = aggregate.attributes
  return {
    writeCount: num(attrs.writeCount) ?? 0,
    totalDurationMs: numOrNull(attrs.totalDurationMs),
    maxDurationMs: numOrNull(attrs.maxDurationMs),
    totalBytes: numOrNull(attrs.totalBytes),
    profilerSpanWriteCount: num(attrs.profilerSpanWriteCount) ?? 0,
    profilerSpanWriteDurationMs: numOrNull(attrs.profilerSpanWriteDurationMs),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numOrNull(value: unknown): number | null {
  const parsed = num(value)
  return parsed === undefined ? null : parsed
}

function addOptional(current: number | null, value: number | undefined): number | null {
  if (value === undefined) return current
  return (current ?? 0) + value
}

function maxOptional(current: number | null, value: number | undefined): number | null {
  if (value === undefined) return current
  if (current === null) return value
  return Math.max(current, value)
}

function lastOptional(current: number | null, value: number | undefined): number | null {
  return value === undefined ? current : value
}

function p50(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor((sorted.length - 1) / 2)
  return round(sorted[mid])
}

function max(values: number[]): number | null {
  if (values.length === 0) return null
  return round(Math.max(...values))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
