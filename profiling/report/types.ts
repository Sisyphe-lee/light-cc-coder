// Stable, versioned profile report contract. This type is intentionally
// self-contained: it does not import light-cc-coder runtime types, so other
// harnesses that emit compatible bounded `profile.span` events can reuse this
// reducer and report shape. See ../README.md for the input/output contract.

export const PROFILE_REPORT_SCHEMA_VERSION = 1

export type CategoryTotal = {
  category: string
  totalDurationMs: number
  spanCount: number
}

export type SlowSpan = {
  spanId: string
  name: string
  category: string
  status: string
  durationMs: number
}

export type FailureClassCount = {
  class: string
  count: number
}

export type ProviderSummary = {
  callCount: number
  totalDurationMs: number
  firstTokenMsP50: number | null
  firstTokenMsMax: number | null
  streamMsP50: number | null
  streamMsMax: number | null
  retryCount: number
  failureClasses: FailureClassCount[]
  inputTokens: number | null
  outputTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
}

export type ContextSummary = {
  assembleCount: number
  totalDurationMs: number
  maxEstimatedTokens: number | null
}

export type ToolSummary = {
  toolName: string
  count: number
  durationMsP50: number | null
  durationMsMax: number | null
  errorCount: number
  deniedCount: number
  timeoutCount: number
}

export type ApprovalSummary = {
  count: number
  allowCount: number
  denyCount: number
  waitMsTotal: number | null
  waitMsMax: number | null
}

export type RuntimeSummary = {
  bashCount: number
  durationMsP50: number | null
  durationMsMax: number | null
  nonzeroExitCount: number
  timeoutCount: number
  truncatedCount: number
}

export type McpSummary = {
  serverStartupCount: number
  readyCount: number
  failedCount: number
  toolCallCount: number
}

export type CompactSummary = {
  count: number
  failedCount: number
  durationMs: number | null
  preCompactEstimatedTokens: number | null
  postCompactEstimatedTokens: number | null
}

export type TranscriptWriteSummary = {
  writeCount: number
  totalDurationMs: number | null
  maxDurationMs: number | null
  totalBytes: number | null
  profilerSpanWriteCount: number
  profilerSpanWriteDurationMs: number | null
}

export type ProfileReport = {
  schemaVersion: typeof PROFILE_REPORT_SCHEMA_VERSION
  sourceTranscript: string
  generatedAt: string
  session: {
    sessionId: string | null
    cwd: string | null
    turnCount: number
    stepCount: number
  }
  summary: {
    observedDurationMs: number
    profileSpanCount: number
    topBottleneck: string | null
  }
  categoryTotals: CategoryTotal[]
  topSlowSpans: SlowSpan[]
  provider: ProviderSummary
  context: ContextSummary
  tools: ToolSummary[]
  approval: ApprovalSummary
  runtime: RuntimeSummary
  mcp: McpSummary
  compact: CompactSummary
  transcriptWrite: TranscriptWriteSummary
  warnings: string[]
}
