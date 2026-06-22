export const EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION = 1

export type BenchmarkName = "swebench" | "terminal-bench"

export type OfficialOutcome = "resolved" | "unresolved" | "empty_patch" | "error" | "incomplete"

export type OutcomeSummary = {
  officialOutcome: OfficialOutcome | null
  tbenchReward: number | null
  completed: boolean | null
  submitted: boolean | null
  status: string | null
  patchBytes: number | null
  patchLines: number | null
  patchSha256: string | null
  changedFiles: string[]
  emptyPatch: boolean | null
}

export type ArtifactRefSummary = {
  kind: string
  path: string
  bytes: number | null
  sha256: string | null
}

export type WrapperProfileSummary = {
  exists: boolean
  valid: boolean
  schemaVersion: number | null
  wrapperId: string | null
  runtime: string | null
  executablePath: string | null
  cwd: string | null
  argCount: number | null
  argsSha256: string | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  warningCount: number
  artifactCount: number
  hasPrompt: boolean
  hasTranscript: boolean
  hasPatch: boolean
  hasSummary: boolean
  hasStdout: boolean
  hasStderr: boolean
  missingEnvNames: string[]
}

export type ProviderProfileSummary = {
  exists: boolean
  valid: boolean
  model: string | null
  requestCount: number | null
  successCount: number | null
  errorCount: number | null
  retryableErrorCount: number | null
  totalLatencyMs: number | null
  averageLatencyMs: number | null
  averageFirstTokenMs: number | null
  latencyMsP50: number | null
  latencyMsP90: number | null
  firstTokenMsP50: number | null
  firstTokenMsP90: number | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
  reasoningTokens: number | null
  estimatedUsd: number | null
  costSource: string | null
}

export type ArtifactSummary = {
  refs: ArtifactRefSummary[]
  totalBytes: number | null
  promptBytes: number | null
  transcriptBytes: number | null
  patchBytes: number | null
  stdoutBytes: number | null
  stderrBytes: number | null
}

export type CommonDerivedMetrics = {
  cacheHitRatio: number | null
  outputTokenRatio: number | null
  averageInputTokensPerRequest: number | null
  averageOutputTokensPerRequest: number | null
  wrapperVsProviderOverheadMs: number | null
  wrapperVsProviderOverheadRatio: number | null
  providerErrorRate: number | null
}

export type CommonProfileSummary = {
  wrapper: WrapperProfileSummary
  provider: ProviderProfileSummary
  artifacts: ArtifactSummary
  derived: CommonDerivedMetrics
}

export type LightccInternalCategoryTotal = {
  category: string
  totalDurationMs: number
  spanCount: number
  shareOfObserved: number | null
}

export type LightccInternalProviderSummary = {
  callCount: number | null
  totalDurationMs: number | null
  firstTokenMsP50: number | null
  firstTokenMsMax: number | null
  streamMsP50: number | null
  streamMsMax: number | null
  retryCount: number | null
  failureClasses: Array<{ class: string; count: number }>
  inputTokens: number | null
  outputTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
}

export type LightccInternalContextSummary = {
  assembleCount: number | null
  totalDurationMs: number | null
  maxEstimatedTokens: number | null
}

export type LightccInternalToolSummary = {
  toolName: string
  count: number
  durationMsP50: number | null
  durationMsMax: number | null
  errorCount: number
  deniedCount: number
  timeoutCount: number
}

export type LightccInternalRuntimeSummary = {
  bashCount: number | null
  durationMsP50: number | null
  durationMsMax: number | null
  nonzeroExitCount: number | null
  timeoutCount: number | null
  truncatedCount: number | null
}

export type LightccInternalApprovalSummary = {
  count: number | null
  allowCount: number | null
  denyCount: number | null
  waitMsTotal: number | null
  waitMsMax: number | null
}

export type LightccInternalMcpSummary = {
  serverStartupCount: number | null
  readyCount: number | null
  failedCount: number | null
  toolCallCount: number | null
}

export type LightccInternalCompactSummary = {
  count: number | null
  failedCount: number | null
  durationMs: number | null
  preCompactEstimatedTokens: number | null
  postCompactEstimatedTokens: number | null
}

export type LightccInternalTranscriptWriteSummary = {
  writeCount: number | null
  totalDurationMs: number | null
  maxDurationMs: number | null
  totalBytes: number | null
  profilerSpanWriteCount: number | null
  profilerSpanWriteDurationMs: number | null
}

export type LightccSlowSpanSummary = {
  spanId: string | null
  name: string
  category: string
  status: string
  durationMs: number
}

export type InternalProfileSummary = {
  kind: "lightcc-profile-report"
  exists: boolean
  valid: boolean
  observedDurationMs: number | null
  profileSpanCount: number | null
  topBottleneck: string | null
  categoryTotals: LightccInternalCategoryTotal[]
  provider: LightccInternalProviderSummary
  context: LightccInternalContextSummary
  tools: LightccInternalToolSummary[]
  runtime: LightccInternalRuntimeSummary
  approval: LightccInternalApprovalSummary
  mcp: LightccInternalMcpSummary
  compact: LightccInternalCompactSummary
  transcriptWrite: LightccInternalTranscriptWriteSummary
  topSlowSpans: LightccSlowSpanSummary[]
  warnings: string[]
}

export type ArtifactPathSummary = {
  summaryJson: string | null
  metricsJson: string | null
  providerProfile: string | null
  wrapperProfile: string | null
  internalProfile: string | null
  patch: string | null
  transcript: string | null
}

export type EvalProfileRow = {
  schemaVersion: typeof EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION
  benchmark: BenchmarkName
  runId: string
  itemId: string
  coderId: string
  coderDisplayName: string | null
  outcome: OutcomeSummary
  commonProfile: CommonProfileSummary
  internalProfile: InternalProfileSummary | null
  paths: ArtifactPathSummary
  warnings: string[]
}

export type ProfileCoverageSummary = {
  rows: number
  valid: number
  missing: number
  invalid: number
  coveragePct: number
}

export type EvalProfileSummary = {
  schemaVersion: typeof EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION
  generatedAt: string
  runIds: string[]
  benchmarks: BenchmarkName[]
  rowCount: number
  itemCount: number
  coderCount: number
  coverage: {
    wrapper: ProfileCoverageSummary
    provider: ProfileCoverageSummary
    internal: ProfileCoverageSummary
  }
  outcomes: Record<string, number>
  warnings: {
    count: number
    examples: string[]
  }
}

export type CoderProfileSummary = {
  schemaVersion: typeof EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION
  coderId: string
  coderDisplayName: string | null
  benchmarkRows: Record<BenchmarkName, number>
  rows: number
  resolved: number
  unresolved: number
  emptyPatch: number
  errors: number
  incomplete: number
  completed: number
  submitted: number
  requestCount: number | null
  providerErrors: number | null
  totalProviderLatencyMs: number | null
  totalWrapperDurationMs: number | null
  totalTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
  estimatedUsd: number | null
  cacheHitRatio: number | null
  tokensPerResolved: number | null
  requestsPerResolved: number | null
  costPerResolved: number | null
  wrapperNonzeroExitCount: number
  wrapperCoveragePct: number
  providerCoveragePct: number
  internalCoveragePct: number
}

export type ItemProfileMatrixEntry = {
  schemaVersion: typeof EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION
  benchmark: BenchmarkName
  itemId: string
  rows: Array<{
    coderId: string
    outcome: OfficialOutcome | null
    tbenchReward: number | null
    wrapperDurationMs: number | null
    requestCount: number | null
    totalTokens: number | null
    estimatedUsd: number | null
    providerErrors: number | null
  }>
  solvedCoders: string[]
  cheapestResolvedCoder: string | null
  fastestResolvedCoder: string | null
  mostExpensiveFailure: string | null
  lightccVsBestCompetitor: {
    tokenGap: number | null
    costGap: number | null
    durationGapMs: number | null
  }
  notes: string[]
}

export type OutlierSeverity = "info" | "warn" | "critical"

export type OutlierRecord = {
  schemaVersion: typeof EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION
  kind: string
  severity: OutlierSeverity
  benchmark: BenchmarkName
  itemId: string
  coderId: string
  value: number | string | null
  threshold: number | string | null
  evidence: string[]
  paths: ArtifactPathSummary
}

export type OutcomeProfileSplit = {
  outcome: string
  rows: number
  requestCount: number | null
  totalTokens: number | null
  estimatedUsd: number | null
  wrapperDurationMs: number | null
  providerLatencyMs: number | null
}

export type EvalProfileAnalysisResult = {
  rows: EvalProfileRow[]
  summary: EvalProfileSummary
  coderSummary: CoderProfileSummary[]
  itemMatrix: ItemProfileMatrixEntry[]
  outliers: OutlierRecord[]
  outcomeSplits: OutcomeProfileSplit[]
}
