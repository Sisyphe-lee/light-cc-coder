#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

type JsonRecord = Record<string, unknown>

type OfficialOutcome = "resolved" | "unresolved" | "empty_patch" | "error" | "incomplete"

const DEEPSEEK_PRICING_USD_PER_1M: Record<
  string,
  { inputCacheHitPer1M: number; inputCacheMissPer1M: number; outputPer1M: number }
> = {
  "deepseek-v4-pro": {
    inputCacheHitPer1M: 0.003625,
    inputCacheMissPer1M: 0.435,
    outputPer1M: 0.87,
  },
  "deepseek-v4-flash": {
    inputCacheHitPer1M: 0.0028,
    inputCacheMissPer1M: 0.14,
    outputPer1M: 0.28,
  },
}

const DEEPSEEK_PRICING_SOURCE =
  "DeepSeek API pricing, checked 2026-06-01; cost uses actual cache hit/miss tokens when provider usage is present."

type SweBenchAnalysisOptions = {
  runId: string
  runRoot: string
  outputDir: string
  officialJsons: Record<string, string>
  manualAttributionsPath: string | null
}

type OfficialCoderResult = {
  coderId: string
  sourcePath: string
  total: number
  submitted: number
  completed: number
  resolved: number
  unresolved: number
  emptyPatch: number
  errors: number
  outcomeByInstance: Record<string, OfficialOutcome>
}

type AnalysisRow = {
  coderId: string
  coderDisplayName: string
  instanceId: string
  repo: string | null
  baseCommit: string | null
  runId: string | null
  officialOutcome: OfficialOutcome
  completed: boolean
  submitted: boolean
  status: string | null
  patchBytes: number | null
  patchLines: number | null
  patchSha256: string | null
  changedFiles: string[]
  emptyPatch: boolean
  wrapper: WrapperProfileSummary
  provider: ProviderProfileSummary
  lightccInternal: LightccInternalSummary | null
  transcriptSignals: TranscriptSignalSummary
  failureAttribution: FailureAttribution
  artifactPaths: ArtifactPaths
}

type WrapperProfileSummary = {
  exists: boolean
  schemaVersion: number | null
  wrapperId: string | null
  runtime: string | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  warningCount: number
  artifactCount: number
  hasPrompt: boolean
  hasTranscript: boolean
  hasPatch: boolean
  hasSummary: boolean
  missingEnvNames: string[]
}

type ProviderProfileSummary = {
  exists: boolean
  model: string | null
  requestCount: number | null
  successCount: number | null
  errorCount: number | null
  retryableErrorCount: number | null
  totalLatencyMs: number | null
  averageLatencyMs: number | null
  averageFirstTokenMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
  reasoningTokens: number | null
  estimatedUsd: number | null
  costSource: string | null
}

type ProviderCostEstimate = {
  estimatedUsd: number
  costSource: string
}

type LightccInternalSummary = {
  exists: boolean
  observedDurationMs: number | null
  profileSpanCount: number | null
  topBottleneck: string | null
  providerCallCount: number | null
  providerTotalDurationMs: number | null
  contextAssembleCount: number | null
  contextTotalDurationMs: number | null
  maxEstimatedTokens: number | null
  bashCount: number | null
  runtimeDurationMsMax: number | null
  runtimeNonzeroExitCount: number | null
  toolErrorCount: number | null
  toolTimeoutCount: number | null
  toolDeniedCount: number | null
  transcriptWriteCount: number | null
  transcriptWriteDurationMs: number | null
  topSlowSpans: Array<{
    name: string
    category: string
    durationMs: number | null
  }>
}

type ArtifactPaths = {
  summaryJson: string | null
  metricsJson: string | null
  providerProfile: string | null
  wrapperProfile: string | null
  internalProfile: string | null
  patch: string | null
  transcript: string | null
}

type TranscriptSignalSummary = {
  exists: boolean
  bytes: number | null
  truncated: boolean
  lineCount: number | null
  jsonEventCount: number | null
  turnEndedReasons: Record<string, number>
  stepEndedReasons: Record<string, number>
  providerFailureCount: number
  compactFailureCount: number
  toolErrorCount: number
  lastTurnReason: string | null
  textSignals: string[]
}

type FailureConfidence = "none" | "low" | "medium" | "high"

type FailureAttributionCategory =
  | "resolved"
  | "empty_patch"
  | "wrapper_or_runtime_error"
  | "provider_error"
  | "incomplete_or_missing_artifact"
  | "auxiliary_only_patch"
  | "overbroad_patch"
  | "high_cost_search_miss"
  | "low_effort_or_early_stop"
  | "lightcc_competitor_gap"
  | "competitor_solved_gap"
  | "patch_failed_hidden_tests"

type FailureAttribution = {
  category: FailureAttributionCategory
  confidence: FailureConfidence
  failureReason: string
  evidence: string[]
  nextAction: string
}

type FailureAttributionRecord = {
  coderId: string
  coderDisplayName: string
  instanceId: string
  officialOutcome: OfficialOutcome
  failureAttribution: FailureAttribution
  artifactPaths: ArtifactPaths
}

type ManualFailureAttributionRecord = {
  coderId: string
  instanceId: string
  failureReason: string
  evidence: string[]
  nextAction: string
  confidence: string
  reviewer: string | null
}

type ManualFailureAttributionFile = {
  schemaVersion: 1
  source: string
  rows: ManualFailureAttributionRecord[]
}

type CoderSummary = {
  coderId: string
  coderDisplayName: string
  rows: number
  resolved: number
  unresolved: number
  emptyPatch: number
  errors: number
  incomplete: number
  requestCount: number
  providerErrors: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  wrapperDurationMs: number
  wrapperNonzeroExitCount: number
  estimatedUsd: number | null
  tokensPerResolved: number | null
  requestsPerResolved: number | null
  costPerResolved: number | null
  medianTokens: number | null
  failureCategories: Record<string, number>
}

type InstanceMatrixEntry = {
  instanceId: string
  repo: string | null
  outcomes: Record<string, InstanceCoderCell>
  solvedCoders: string[]
  lightccOutcome: OfficialOutcome | null
  bestResolvedCompetitor: {
    coderId: string
    totalTokens: number | null
    requestCount: number | null
    wrapperDurationMs: number | null
  } | null
  note: string
}

type InstanceCoderCell = {
  outcome: OfficialOutcome
  totalTokens: number | null
  requestCount: number | null
  wrapperDurationMs: number | null
  estimatedUsd: number | null
  patchLines: number | null
  emptyPatch: boolean
  providerErrors: number | null
  wrapperExitCode: number | null
  failureCategory: FailureAttributionCategory
  failureReason: string
  failureConfidence: FailureConfidence
  nextAction: string
}

type PriorityCase = {
  instanceId: string
  category:
    | "high_priority_gap"
    | "cheap_competitor_win"
    | "high_cost_unresolved"
    | "empty_patch_or_no_submission"
    | "runtime_or_wrapper_issue"
    | "expensive_success"
    | "lightcc_strength"
    | "all_failed"
  priorityScore: number
  lightccOutcome: OfficialOutcome | null
  solvedCompetitors: string[]
  bestCompetitor: string | null
  evidence: string
  nextArtifactPaths: ArtifactPaths | null
}

type ActionPriorityConfidence = "low" | "medium" | "high"

type ActionPriorityClass = "lightcc_improvement" | "evaluation_system" | "external_coder_issue"

type ActionPriority = {
  rank: number
  classRank: number
  improvementClass: ActionPriorityClass
  improvementClassLabel: string
  title: string
  targetArea: string
  implementationModules: string[]
  whyValuable: string
  evidence: string[]
  affectedInstances: string[]
  affectedCoders: string[]
  expectedImpact: string
  nextAction: string
  confidence: ActionPriorityConfidence
}

type CoverageReport = {
  expectedRows: number
  actualRows: number
  officialJsons: number
  summaryJsons: number
  providerProfiles: number
  wrapperProfiles: number
  lightccInternalProfiles: number
  missing: Array<{ coderId: string; instanceId: string; kind: string; path: string | null }>
}

type SweBenchAnalysisReport = {
  schemaVersion: 1
  runId: string
  generatedAt: string
  runRoot: string
  outputDir: string
  coderOrder: string[]
  coverage: CoverageReport
  coderSummary: CoderSummary[]
  instanceMatrix: InstanceMatrixEntry[]
  priorities: PriorityCase[]
  actionPriorities: ActionPriority[]
  failureAttributions: FailureAttributionRecord[]
  manualFailureAttributions: ManualFailureAttributionRecord[]
  rows: AnalysisRow[]
  notes: string[]
}

const DEFAULT_RUN_ID = "swe20-fourway-20260602"
const DEFAULT_RUN_ROOT = ".light-cc/evals/swe20-fourway-20260602"
const CODER_ORDER = ["lightcc", "aider", "openhands", "opencode"]
const ACTION_PRIORITY_CLASSES: ActionPriorityClass[] = ["lightcc_improvement", "evaluation_system", "external_coder_issue"]
const ACTION_PRIORITY_CLASS_LABELS: Record<ActionPriorityClass, string> = {
  lightcc_improvement: "直接改进 LightCC",
  evaluation_system: "评测系统问题",
  external_coder_issue: "其他 coder 问题",
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = await parseArgs(argv)
    const report = await buildSweBenchAnalysis(options)
    await writeSweBenchAnalysis(report)
    console.log(`SWE-bench analysis written: ${report.outputDir}`)
    console.log(`Dashboard: ${join(report.outputDir, "swebench-dashboard.html")}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export async function buildSweBenchAnalysis(options: SweBenchAnalysisOptions): Promise<SweBenchAnalysisReport> {
  const official = await readOfficialResults(options.officialJsons)
  const rawRows = await readMatrixRows(options.runRoot, official)
  const coderOrder = sortedCoders([...new Set([...Object.keys(official), ...rawRows.map((row) => row.coderId)])])
  const preliminaryMatrix = buildInstanceMatrix(rawRows, coderOrder)
  const rows = await addFailureAttributions(rawRows, preliminaryMatrix)
  const coverage = buildCoverage(official, rows, options.officialJsons)
  const coderSummary = buildCoderSummary(rows, coderOrder)
  const instanceMatrix = buildInstanceMatrix(rows, coderOrder)
  const priorities = buildPriorities(instanceMatrix, rows)
  const failureAttributions = buildFailureAttributionRecords(rows)
  const manualFailureAttributions = await readManualFailureAttributions(options.manualAttributionsPath)
  const actionPriorities = buildActionPriorities(manualFailureAttributions, failureAttributions, instanceMatrix, rows)
  return {
    schemaVersion: 1,
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    runRoot: options.runRoot,
    outputDir: options.outputDir,
    coderOrder,
    coverage,
    coderSummary,
    instanceMatrix,
    priorities,
    actionPriorities,
    failureAttributions,
    manualFailureAttributions,
    rows,
    notes: [
      "公共横比主要使用 wrapper.profile.json 与 provider.profile.json；成本优先使用 SWE-bench summary/result cost，缺失时用 provider profile usage 和同一 pricing 补算。",
      "LightCC internal profile.report.json 只用于 LightCC 自诊断，不参与外部 coder 横比。",
      "报告不内嵌 prompt、transcript、stdout/stderr 或 patch 正文，只记录 bounded metadata 与 artifact 路径。",
    ],
  }
}

async function readOfficialResults(paths: Record<string, string>): Promise<Record<string, OfficialCoderResult>> {
  const results: Record<string, OfficialCoderResult> = {}
  for (const [coderId, path] of Object.entries(paths).sort(([left], [right]) => left.localeCompare(right))) {
    const resolvedPath = resolve(path)
    const data = asRecord(JSON.parse(await readFile(resolvedPath, "utf8")))
    if (!data) throw new Error(`Official SWE result is not an object: ${path}`)
    const resolvedIds = arrayStrings(data.resolved_ids)
    const unresolvedIds = arrayStrings(data.unresolved_ids)
    const emptyPatchIds = arrayStrings(data.empty_patch_ids)
    const errorIds = arrayStrings(data.error_ids)
    const incompleteIds = arrayStrings(data.incomplete_ids)
    const submittedIds = arrayStrings(data.submitted_ids)
    const completedIds = arrayStrings(data.completed_ids)
    const outcomeByInstance: Record<string, OfficialOutcome> = {}
    for (const id of unresolvedIds) outcomeByInstance[id] = "unresolved"
    for (const id of resolvedIds) outcomeByInstance[id] = "resolved"
    for (const id of emptyPatchIds) outcomeByInstance[id] = "empty_patch"
    for (const id of errorIds) outcomeByInstance[id] = "error"
    for (const id of incompleteIds) {
      if (!outcomeByInstance[id]) outcomeByInstance[id] = "incomplete"
    }
    results[coderId] = {
      coderId,
      sourcePath: resolvedPath,
      total: numberValue(data, "total_instances") ?? submittedIds.length,
      submitted: submittedIds.length,
      completed: completedIds.length,
      resolved: resolvedIds.length,
      unresolved: unresolvedIds.length,
      emptyPatch: emptyPatchIds.length,
      errors: errorIds.length,
      outcomeByInstance,
    }
  }
  return results
}

async function readMatrixRows(runRoot: string, official: Record<string, OfficialCoderResult>): Promise<AnalysisRow[]> {
  const jobsDir = join(runRoot, "matrix", "jobs")
  const entries = await readdir(jobsDir, { withFileTypes: true })
  const summaryPaths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(jobsDir, entry.name, "report", "summary.json"))
    .filter((path) => existsSync(path))
    .sort()
  const rows: AnalysisRow[] = []
  for (const summaryPath of summaryPaths) {
    rows.push(...await readRowsFromSummary(summaryPath, official))
  }
  return rows.sort((left, right) => {
    const coderDelta = coderRank(left.coderId) - coderRank(right.coderId)
    return coderDelta || left.instanceId.localeCompare(right.instanceId)
  })
}

async function readRowsFromSummary(summaryPath: string, official: Record<string, OfficialCoderResult>): Promise<AnalysisRow[]> {
  const summary = asRecord(JSON.parse(await readFile(summaryPath, "utf8")))
  if (!summary) throw new Error(`SWE summary is not an object: ${summaryPath}`)
  const coder = recordValue(summary, "coder")
  const coderId = stringValue(coder, "id") ?? "unknown"
  const coderDisplayName = stringValue(coder, "displayName") ?? coderId
  const runId = stringValue(summary, "runId")
  const providerProfilePath = join(reportDirFromSummaryPath(summaryPath), "provider.profile.json")
  const provider = await readProviderProfile(providerProfilePath)
  const results = arrayRecords(summary.results)
  const rows: AnalysisRow[] = []
  for (const result of results) {
    const instanceId = stringValue(result, "instanceId") ?? stringValue(recordValue(result, "prediction"), "instance_id")
    if (!instanceId) continue
    const artifactDir = stringValue(result, "artifactDir")
    const metricsPath = artifactDir ? join(artifactDir, "metrics.json") : null
    const instancePath = artifactDir ? join(artifactDir, "instance.json") : null
    const metrics = metricsPath && existsSync(metricsPath) ? asRecord(JSON.parse(await readFile(metricsPath, "utf8"))) : undefined
    const instance = instancePath && existsSync(instancePath) ? asRecord(JSON.parse(await readFile(instancePath, "utf8"))) : undefined
    const wrapperProfilePath =
      stringValue(metrics, "wrapperProfilePath") ??
      stringValue(result, "wrapperProfilePath") ??
      (artifactDir ? join(artifactDir, "agent", "wrapper.profile.json") : null)
    const internalProfilePath =
      stringValue(metrics, "profileReportPath") ??
      stringValue(result, "profileReportPath") ??
      (artifactDir ? join(artifactDir, "agent", "profile.report.json") : null)
    const wrapper = await readWrapperProfile(wrapperProfilePath)
    const internalProfile = await readLightccInternalProfile(internalProfilePath)
    const providerForRow = withCostFallback(provider, result, summary, results.length)
    const officialOutcome = official[coderId]?.outcomeByInstance[instanceId] ?? inferOutcome(result, metrics)
    const artifactPaths: ArtifactPaths = {
      summaryJson: summaryPath,
      metricsJson: metricsPath,
      providerProfile: existsSync(providerProfilePath) ? providerProfilePath : null,
      wrapperProfile: wrapperProfilePath && existsSync(wrapperProfilePath) ? wrapperProfilePath : null,
      internalProfile: internalProfilePath && existsSync(internalProfilePath) ? internalProfilePath : null,
      patch: stringValue(result, "patchPath") ?? (artifactDir ? join(artifactDir, "patch.diff") : null),
      transcript: stringValue(result, "transcriptPath") ?? (artifactDir ? join(artifactDir, "agent", "transcript.jsonl") : null),
    }
    rows.push({
      coderId,
      coderDisplayName,
      instanceId,
      repo: stringValue(instance, "repo") ?? null,
      baseCommit: stringValue(instance, "base_commit") ?? null,
      runId: runId ?? null,
      officialOutcome,
      completed: officialOutcome === "resolved" || officialOutcome === "unresolved" || officialOutcome === "empty_patch",
      submitted: officialOutcome !== "incomplete",
      status: stringValue(metrics, "status") ?? stringValue(result, "status") ?? null,
      patchBytes: nullableNumberValue(metrics, "patchBytes") ?? nullableNumberValue(result, "patchBytes"),
      patchLines: nullableNumberValue(metrics, "patchLines") ?? nullableNumberValue(result, "patchLines"),
      patchSha256: stringValue(metrics, "patchSha256") ?? stringValue(result, "patchSha256") ?? null,
      changedFiles: arrayStrings(metrics?.changedFiles ?? result.changedFiles),
      emptyPatch: booleanValue(metrics, "emptyPatch") ?? booleanValue(result, "emptyPatch") ?? officialOutcome === "empty_patch",
      wrapper,
      provider: providerForRow,
      lightccInternal: internalProfile,
      transcriptSignals: emptyTranscriptSignals(),
      failureAttribution: pendingFailureAttribution(officialOutcome),
      artifactPaths,
    })
  }
  return rows
}

async function readWrapperProfile(path: string | null): Promise<WrapperProfileSummary> {
  if (!path || !existsSync(path)) return emptyWrapperProfile()
  const profile = asRecord(JSON.parse(await readFile(path, "utf8")))
  if (!profile) return emptyWrapperProfile()
  const wrapper = recordValue(profile, "wrapper")
  const process = recordValue(profile, "process")
  const environment = recordValue(profile, "environment")
  const artifacts = arrayRecords(profile.artifacts)
  const kinds = new Set(artifacts.map((artifact) => stringValue(artifact, "kind")).filter((kind): kind is string => Boolean(kind)))
  return {
    exists: true,
    schemaVersion: nullableNumberValue(profile, "schemaVersion"),
    wrapperId: stringValue(wrapper, "id") ?? null,
    runtime: stringValue(wrapper, "runtime") ?? null,
    durationMs: nullableNumberValue(process, "durationMs"),
    exitCode: nullableNumberValue(process, "exitCode"),
    signal: stringValue(process, "signal") ?? null,
    warningCount: arrayStrings(profile.warnings).length,
    artifactCount: artifacts.length,
    hasPrompt: kinds.has("prompt"),
    hasTranscript: kinds.has("transcript"),
    hasPatch: kinds.has("patch"),
    hasSummary: kinds.has("summary"),
    missingEnvNames: arrayStrings(environment?.missingNames),
  }
}

function withCostFallback(
  provider: ProviderProfileSummary,
  result: JsonRecord,
  summary: JsonRecord,
  resultCount: number,
): ProviderProfileSummary {
  const resultCost = costEstimateFromRecord(recordValue(result, "cost"), "swebench result cost")
  const summaryCost = resultCount === 1
    ? costEstimateFromRecord(recordValue(summary, "cost"), "swebench summary cost")
    : null
  const providerCost = isNumber(provider.estimatedUsd)
    ? {
        estimatedUsd: provider.estimatedUsd,
        costSource: provider.costSource ?? "provider.profile.json cost",
      }
    : null
  const usageCost = resultCount === 1 ? estimateCostFromProviderUsage(provider) : null
  const selected = resultCost ?? summaryCost ?? providerCost ?? usageCost
  if (!selected) return provider
  return {
    ...provider,
    estimatedUsd: selected.estimatedUsd,
    costSource: selected.costSource,
  }
}

function costEstimateFromRecord(cost: JsonRecord | undefined, fallbackSource: string): ProviderCostEstimate | null {
  const totalUsd = nullableNumberValue(cost, "totalUsd") ?? nullableNumberValue(cost, "estimatedUsd")
  if (!isNumber(totalUsd)) return null
  const pricing = recordValue(cost, "pricing")
  return {
    estimatedUsd: totalUsd,
    costSource: stringValue(pricing, "source") ?? stringValue(cost, "source") ?? fallbackSource,
  }
}

function estimateCostFromProviderUsage(provider: ProviderProfileSummary): ProviderCostEstimate | null {
  const model = normalizeModelName(provider.model)
  if (!model) return null
  const pricing = DEEPSEEK_PRICING_USD_PER_1M[model]
  if (!pricing || !isNumber(provider.inputTokens) || !isNumber(provider.outputTokens)) return null
  const cacheHitTokens = provider.cacheReadInputTokens ?? 0
  const cacheMissTokens = provider.cacheWriteInputTokens ?? Math.max(0, provider.inputTokens - cacheHitTokens)
  const inputCacheHitUsd = (cacheHitTokens / 1_000_000) * pricing.inputCacheHitPer1M
  const inputCacheMissUsd = (cacheMissTokens / 1_000_000) * pricing.inputCacheMissPer1M
  const outputUsd = (provider.outputTokens / 1_000_000) * pricing.outputPer1M
  return {
    estimatedUsd: roundUsd(inputCacheHitUsd + inputCacheMissUsd + outputUsd),
    costSource: `${DEEPSEEK_PRICING_SOURCE} Estimated by swebench-analysis.ts from provider.profile.json totals for ${model}.`,
  }
}

function normalizeModelName(model: string | null): string | null {
  if (!model) return null
  return model.replace(/^light-cc-coder\//, "").replace(/^(lightcc|aider|openhands|opencode)\//, "").toLowerCase()
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8))
}

async function readProviderProfile(path: string): Promise<ProviderProfileSummary> {
  if (!existsSync(path)) return emptyProviderProfile()
  const profile = asRecord(JSON.parse(await readFile(path, "utf8")))
  if (!profile) return emptyProviderProfile()
  const proxy = recordValue(profile, "proxy")
  const requests = arrayRecords(profile.requests)
  const totals = recordValue(profile, "totals")
  const usage = recordValue(totals, "usage")
  const cost = recordValue(totals, "cost")
  return {
    exists: true,
    model: stringValue(proxy, "model") ?? stringValue(requests[0], "model") ?? null,
    requestCount: nullableNumberValue(totals, "requestCount"),
    successCount: nullableNumberValue(totals, "successCount"),
    errorCount: nullableNumberValue(totals, "errorCount"),
    retryableErrorCount: nullableNumberValue(totals, "retryableErrorCount"),
    totalLatencyMs: nullableNumberValue(totals, "totalLatencyMs"),
    averageLatencyMs: nullableNumberValue(totals, "averageLatencyMs"),
    averageFirstTokenMs: nullableNumberValue(totals, "averageFirstTokenMs"),
    inputTokens: nullableNumberValue(usage, "inputTokens"),
    outputTokens: nullableNumberValue(usage, "outputTokens"),
    totalTokens: nullableNumberValue(usage, "totalTokens"),
    cacheReadInputTokens: nullableNumberValue(usage, "cacheReadInputTokens"),
    cacheWriteInputTokens: nullableNumberValue(usage, "cacheWriteInputTokens"),
    reasoningTokens: nullableNumberValue(usage, "reasoningTokens"),
    estimatedUsd: nullableNumberValue(cost, "estimatedUsd"),
    costSource: stringValue(cost, "source") ?? null,
  }
}

async function readLightccInternalProfile(path: string | null): Promise<LightccInternalSummary | null> {
  if (!path || !existsSync(path)) return null
  const profile = asRecord(JSON.parse(await readFile(path, "utf8")))
  if (!profile) return null
  const summary = recordValue(profile, "summary")
  const provider = recordValue(profile, "provider")
  const context = recordValue(profile, "context")
  const runtime = recordValue(profile, "runtime")
  const transcriptWrite = recordValue(profile, "transcriptWrite")
  const tools = arrayRecords(profile.tools)
  return {
    exists: true,
    observedDurationMs: nullableNumberValue(summary, "observedDurationMs") ?? nullableNumberValue(profile, "observedDurationMs"),
    profileSpanCount: nullableNumberValue(summary, "profileSpanCount") ?? nullableNumberValue(profile, "profileSpanCount"),
    topBottleneck: stringValue(summary, "topBottleneck") ?? stringValue(profile, "topBottleneck") ?? null,
    providerCallCount: nullableNumberValue(provider, "callCount"),
    providerTotalDurationMs: nullableNumberValue(provider, "totalDurationMs"),
    contextAssembleCount: nullableNumberValue(context, "assembleCount"),
    contextTotalDurationMs: nullableNumberValue(context, "totalDurationMs"),
    maxEstimatedTokens: nullableNumberValue(context, "maxEstimatedTokens"),
    bashCount: nullableNumberValue(runtime, "bashCount"),
    runtimeDurationMsMax: nullableNumberValue(runtime, "durationMsMax"),
    runtimeNonzeroExitCount: nullableNumberValue(runtime, "nonzeroExitCount"),
    toolErrorCount: nullableSum(tools.map((tool) => nullableNumberValue(tool, "errorCount"))),
    toolTimeoutCount: nullableSum(tools.map((tool) => nullableNumberValue(tool, "timeoutCount"))),
    toolDeniedCount: nullableSum(tools.map((tool) => nullableNumberValue(tool, "deniedCount"))),
    transcriptWriteCount: nullableNumberValue(transcriptWrite, "writeCount"),
    transcriptWriteDurationMs: nullableNumberValue(transcriptWrite, "totalDurationMs"),
    topSlowSpans: arrayRecords(profile.topSlowSpans).slice(0, 5).map((span) => ({
      name: stringValue(span, "name") ?? "unknown",
      category: stringValue(span, "category") ?? "unknown",
      durationMs: nullableNumberValue(span, "durationMs"),
    })),
  }
}

async function addFailureAttributions(rows: AnalysisRow[], matrix: InstanceMatrixEntry[]): Promise<AnalysisRow[]> {
  const matrixByInstance = new Map(matrix.map((entry) => [entry.instanceId, entry]))
  return Promise.all(rows.map(async (row) => {
    const transcriptSignals = await readTranscriptSignals(row.artifactPaths.transcript)
    return {
      ...row,
      transcriptSignals,
      failureAttribution: classifyFailureAttribution(row, matrixByInstance.get(row.instanceId) ?? null, transcriptSignals),
    }
  }))
}

async function readTranscriptSignals(path: string | null): Promise<TranscriptSignalSummary> {
  if (!path || !existsSync(path)) return emptyTranscriptSignals()
  const { text, bytes, truncated } = await readBoundedText(path, 800_000)
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith("[..."))
  const turnEndedReasons: Record<string, number> = {}
  const stepEndedReasons: Record<string, number> = {}
  let jsonEventCount = 0
  let providerFailureCount = 0
  let compactFailureCount = 0
  let toolErrorCount = 0
  let lastTurnReason: string | null = null

  for (const line of lines) {
    const event = parseJsonLine(line)
    if (!event) continue
    jsonEventCount += 1
    const type = stringValue(event, "type") ?? stringValue(event, "kind") ?? ""
    const reason = stringValue(event, "reason")
    if (type === "turn.ended") {
      const key = reason ?? "unknown"
      turnEndedReasons[key] = (turnEndedReasons[key] ?? 0) + 1
      lastTurnReason = key
    }
    if (type === "step.ended") {
      const key = reason ?? "unknown"
      stepEndedReasons[key] = (stepEndedReasons[key] ?? 0) + 1
    }
    if (type === "provider.failure" || /provider.*failure/.test(type)) providerFailureCount += 1
    if (type === "compact.ended" && stringValue(event, "status") === "failed") compactFailureCount += 1
    if (/tool|action|observation/.test(type)) {
      const observation = recordValue(event, "observation")
      const isError = booleanValue(observation, "is_error") ?? booleanValue(event, "is_error")
      if (isError || stringValue(event, "status") === "error" || stringValue(event, "status") === "failed") toolErrorCount += 1
    }
  }

  return {
    exists: true,
    bytes,
    truncated,
    lineCount: lines.length,
    jsonEventCount,
    turnEndedReasons,
    stepEndedReasons,
    providerFailureCount,
    compactFailureCount,
    toolErrorCount,
    lastTurnReason,
    textSignals: classifyTranscriptTextSignals(tailText(text, 120_000)),
  }
}

async function readBoundedText(path: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(path, "r")
  try {
    const stats = await handle.stat()
    if (stats.size <= maxBytes) {
      return { text: await handle.readFile("utf8"), bytes: stats.size, truncated: false }
    }
    const headBytes = Math.floor(maxBytes / 2)
    const tailBytes = maxBytes - headBytes
    const head = Buffer.alloc(headBytes)
    const tail = Buffer.alloc(tailBytes)
    const headRead = await handle.read(head, 0, headBytes, 0)
    const tailRead = await handle.read(tail, 0, tailBytes, Math.max(0, stats.size - tailBytes))
    return {
      text: `${head.toString("utf8", 0, headRead.bytesRead)}\n[...transcript truncated...]\n${tail.toString("utf8", 0, tailRead.bytesRead)}`,
      bytes: stats.size,
      truncated: true,
    }
  } finally {
    await handle.close()
  }
}

function classifyTranscriptTextSignals(text: string): string[] {
  const lower = text.toLowerCase()
  const signals: string[] = []
  if (/\b(max_steps|max steps|maximum iterations|iteration limit|max iterations)\b/.test(lower)) signals.push("step_limit_or_iteration_limit")
  if (/\b(time[ -]?out|timed out|deadline|etimedout)\b/.test(lower)) signals.push("timeout_text")
  if (/\b(no changes|no file changes|no files changed|empty patch|patch is empty)\b/.test(lower)) signals.push("no_changes_text")
  if (/\b(finish with message|goodbye|task completed|fixed the)\b/.test(lower)) signals.push("agent_reported_completion")
  return [...new Set(signals)]
}

function tailText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

function parseJsonLine(line: string): JsonRecord | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

function classifyFailureAttribution(
  row: AnalysisRow,
  matrix: InstanceMatrixEntry | null,
  transcriptSignals: TranscriptSignalSummary,
): FailureAttribution {
  const evidence = baseFailureEvidence(row, matrix, transcriptSignals)
  const solvedByOthers = matrix?.solvedCoders.filter((coderId) => coderId !== row.coderId) ?? []
  const codeFiles = row.changedFiles.filter((path) => !isAuxiliaryOrScratchFile(path))
  const hasAuxiliaryFiles = row.changedFiles.some(isAuxiliaryOrScratchFile)

  if (row.officialOutcome === "resolved") {
    return {
      category: "resolved",
      confidence: "none",
      failureReason: "官方 evaluator 已 resolved，本行无失败归因。",
      evidence,
      nextAction: "作为同题对照样本，用它的 patch、changed files 和 token/profile 指标辅助分析失败行。",
    }
  }

  if (!row.artifactPaths.summaryJson || !row.artifactPaths.metricsJson || !row.artifactPaths.wrapperProfile) {
    return attribution(
      "incomplete_or_missing_artifact",
      "high",
      "关键 artifact 不完整，当前无法可靠判断模型 patch 质量。",
      evidence,
      "先补齐 summary.json、metrics.json、wrapper.profile.json，再重新生成归因报告。",
    )
  }

  if (row.wrapper.exitCode !== null && row.wrapper.exitCode !== 0) {
    return attribution(
      "wrapper_or_runtime_error",
      "high",
      "wrapper 进程非零退出，失败首先应按运行时或适配器问题处理。",
      evidence,
      "优先查看 wrapper.profile.json 与 agent stdout/stderr，确认命令、环境和 patch 收集流程是否正常。",
    )
  }

  if ((row.provider.errorCount ?? 0) > 0 || transcriptSignals.providerFailureCount > 0) {
    return attribution(
      "provider_error",
      "high",
      "provider 请求出现错误，模型过程可能被 API/网络/上游服务中断或污染。",
      evidence,
      "先检查 provider.profile.json 的错误与重试记录，再决定是否重跑该题或调整 provider 代理。",
    )
  }

  if (row.officialOutcome === "empty_patch" || row.emptyPatch || (row.patchLines ?? 0) === 0 || row.changedFiles.length === 0) {
    return attribution(
      "empty_patch",
      "high",
      "官方结果或本地 metrics 显示没有有效 patch。",
      evidence,
      "查看 transcript 末尾和 patch 收集命令：确认 coder 是否实际编辑了文件，以及 wrapper 是否从正确 workspace 抽取 git diff。",
    )
  }

  if (codeFiles.length === 0) {
    return attribution(
      "auxiliary_only_patch",
      "high",
      "patch 只修改了辅助/临时文件，没有改到可解释的产品代码。",
      [...evidence, `auxiliaryFiles=${row.changedFiles.join(", ")}`],
      "检查 adapter 是否引入了无关文件；重新审阅 prompt/工作目录，确保 coder 修改 issue 对应源码。",
    )
  }

  if ((row.patchLines ?? 0) >= 250 || row.changedFiles.length >= 4) {
    return attribution(
      "overbroad_patch",
      "medium",
      "patch 修改面偏大但官方未通过，疑似过度修改或引入副作用。",
      hasAuxiliaryFiles ? [...evidence, "patch includes auxiliary/scratch files"] : evidence,
      "先和同题 resolved patch 做 diff 粒度对比，收敛到最小相关文件和最小行为变更。",
    )
  }

  if ((row.provider.totalTokens ?? 0) >= 500_000 || (row.provider.requestCount ?? 0) >= 40 || (row.lightccInternal?.maxEstimatedTokens ?? 0) >= 30_000) {
    return attribution(
      "high_cost_search_miss",
      "medium",
      "高 token/多请求搜索后仍未通过，疑似定位或验证循环没有收敛到正确补丁。",
      hasAuxiliaryFiles ? [...evidence, "patch includes auxiliary/scratch files"] : evidence,
      "优先阅读 transcript 的后半段和最终 patch；对比同题 resolved coder 的 changed files，找出搜索方向偏差。",
    )
  }

  if ((row.provider.requestCount ?? Number.MAX_SAFE_INTEGER) <= 1 || (row.provider.totalTokens ?? Number.MAX_SAFE_INTEGER) <= 20_000) {
    return attribution(
      "low_effort_or_early_stop",
      "medium",
      "请求/token 很低但未通过，疑似过早停止、未充分验证，或 coder 只做了浅层修改。",
      evidence,
      "检查 transcript 结束原因和 adapter 配置；必要时增加最小探索/验证步骤或修正 headless coder 参数。",
    )
  }

  if (row.coderId === "lightcc" && solvedByOthers.length > 0) {
    return attribution(
      "lightcc_competitor_gap",
      "medium",
      "LightCC 流程正常并生成 patch，但同题有竞品 resolved，说明主要是解题策略或 patch 质量差距。",
      evidence,
      "把 LightCC patch 与最佳 resolved 竞品 patch 逐文件对比；回看 LightCC transcript 中最终假设与验证命令。",
    )
  }

  if (solvedByOthers.length > 0) {
    return attribution(
      "competitor_solved_gap",
      "medium",
      "该 coder 未通过，但同题有其他 coder resolved，说明失败更可能是 patch 质量或定位差异。",
      evidence,
      "用 resolved coder 的 changed files 作为对照，检查本 patch 是否改错文件、漏掉边界条件或缺少最小验证。",
    )
  }

  return attribution(
    "patch_failed_hidden_tests",
    "low",
    "流程正常且生成了 patch，但官方 hidden tests 未通过；当前 artifacts 不包含具体 hidden test 失败细节。",
    hasAuxiliaryFiles ? [...evidence, "patch includes auxiliary/scratch files"] : evidence,
    "围绕 problem statement 重放可见复现，审阅 patch 行为边界；若同题全员失败，优先人工分析 issue 语义而非运行链路。",
  )
}

function baseFailureEvidence(row: AnalysisRow, matrix: InstanceMatrixEntry | null, transcriptSignals: TranscriptSignalSummary): string[] {
  const evidence = [
    `outcome=${row.officialOutcome}`,
    `status=${row.status ?? "unknown"}`,
    `patchLines=${row.patchLines ?? "unknown"}`,
    `changedFiles=${row.changedFiles.length}`,
    `wrapperExit=${row.wrapper.exitCode ?? "unknown"}`,
    `providerErrors=${row.provider.errorCount ?? 0}`,
    `requests=${row.provider.requestCount ?? "unknown"}`,
    `tokens=${row.provider.totalTokens ?? "unknown"}`,
  ]
  const solvedByOthers = matrix?.solvedCoders.filter((coderId) => coderId !== row.coderId) ?? []
  if (solvedByOthers.length > 0) evidence.push(`sameInstanceResolvedBy=${solvedByOthers.join(",")}`)
  if (matrix?.bestResolvedCompetitor) evidence.push(`bestResolvedCompetitor=${matrix.bestResolvedCompetitor.coderId}`)
  if (row.changedFiles.length > 0) evidence.push(`files=${row.changedFiles.slice(0, 4).join(",")}${row.changedFiles.length > 4 ? ",..." : ""}`)
  if (row.lightccInternal) {
    evidence.push(`internalBottleneck=${row.lightccInternal.topBottleneck ?? "unknown"}`)
    evidence.push(`maxContext=${row.lightccInternal.maxEstimatedTokens ?? "unknown"}`)
    evidence.push(`internalToolErrors=${row.lightccInternal.toolErrorCount ?? 0}`)
    evidence.push(`bashNonzero=${row.lightccInternal.runtimeNonzeroExitCount ?? 0}`)
  }
  if (transcriptSignals.exists) {
    evidence.push(`transcriptLines=${transcriptSignals.lineCount ?? "unknown"}${transcriptSignals.truncated ? "+" : ""}`)
    if (transcriptSignals.lastTurnReason) evidence.push(`lastTurn=${transcriptSignals.lastTurnReason}`)
    if (transcriptSignals.textSignals.length > 0) evidence.push(`transcriptSignals=${transcriptSignals.textSignals.join(",")}`)
  }
  return evidence
}

function attribution(
  category: FailureAttributionCategory,
  confidence: FailureConfidence,
  failureReason: string,
  evidence: string[],
  nextAction: string,
): FailureAttribution {
  return { category, confidence, failureReason, evidence: evidence.slice(0, 14), nextAction }
}

function isAuxiliaryOrScratchFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1)
  if (normalized === ".gitignore" || normalized === ".gitmodules") return true
  if (normalized.startsWith(".") && !normalized.includes("/")) return true
  if (/^(_?test|test_|repro|scratch)/i.test(basename)) return true
  if (/\.(log|tmp|bak|pyc)$/.test(basename)) return true
  return false
}

function buildFailureAttributionRecords(rows: AnalysisRow[]): FailureAttributionRecord[] {
  return rows
    .filter((row) => row.failureAttribution.category !== "resolved")
    .sort((left, right) => {
      const coderDelta = coderRank(left.coderId) - coderRank(right.coderId)
      return coderDelta || left.instanceId.localeCompare(right.instanceId)
    })
    .map((row) => ({
      coderId: row.coderId,
      coderDisplayName: row.coderDisplayName,
      instanceId: row.instanceId,
      officialOutcome: row.officialOutcome,
      failureAttribution: row.failureAttribution,
      artifactPaths: row.artifactPaths,
    }))
}

async function readManualFailureAttributions(path: string | null): Promise<ManualFailureAttributionRecord[]> {
  if (!path || !existsSync(path)) return []
  const data = asRecord(JSON.parse(await readFile(path, "utf8")))
  if (!data) throw new Error(`Manual failure attribution file is not an object: ${path}`)
  const rows = arrayRecords(data.rows)
  return rows.map((row) => ({
    coderId: stringValue(row, "coderId") ?? "",
    instanceId: stringValue(row, "instanceId") ?? "",
    failureReason: stringValue(row, "failureReason") ?? stringValue(row, "failure_reason") ?? "",
    evidence: normalizeManualEvidence(row.evidence),
    nextAction: stringValue(row, "nextAction") ?? stringValue(row, "next_action") ?? "",
    confidence: normalizeManualConfidence(row.confidence),
    reviewer: stringValue(row, "reviewer") ?? null,
  })).filter((row) => row.coderId && row.instanceId && row.failureReason)
}

function normalizeManualEvidence(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean)
  if (typeof value === "string") return value.split(";").map((item) => item.trim()).filter(Boolean)
  return []
}

function normalizeManualConfidence(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "string") return value
  return "unknown"
}

function buildCoverage(
  official: Record<string, OfficialCoderResult>,
  rows: AnalysisRow[],
  officialJsons: Record<string, string>,
): CoverageReport {
  const officialInstances = new Set<string>()
  for (const result of Object.values(official)) {
    for (const instanceId of Object.keys(result.outcomeByInstance)) officialInstances.add(instanceId)
  }
  const expectedRows = Object.keys(official).length * officialInstances.size
  const missing: CoverageReport["missing"] = []
  for (const row of rows) {
    if (!row.artifactPaths.providerProfile) missing.push({ coderId: row.coderId, instanceId: row.instanceId, kind: "provider.profile.json", path: null })
    if (!row.artifactPaths.wrapperProfile) missing.push({ coderId: row.coderId, instanceId: row.instanceId, kind: "wrapper.profile.json", path: null })
    if (row.coderId === "lightcc" && !row.artifactPaths.internalProfile) {
      missing.push({ coderId: row.coderId, instanceId: row.instanceId, kind: "profile.report.json", path: null })
    }
  }
  const rowKeys = new Set(rows.map((row) => `${row.coderId}\0${row.instanceId}`))
  for (const coderId of Object.keys(official)) {
    for (const instanceId of officialInstances) {
      if (!rowKeys.has(`${coderId}\0${instanceId}`)) missing.push({ coderId, instanceId, kind: "matrix row", path: null })
    }
  }
  return {
    expectedRows,
    actualRows: rows.length,
    officialJsons: Object.keys(officialJsons).length,
    summaryJsons: new Set(rows.map((row) => row.artifactPaths.summaryJson).filter(Boolean)).size,
    providerProfiles: rows.filter((row) => row.artifactPaths.providerProfile).length,
    wrapperProfiles: rows.filter((row) => row.artifactPaths.wrapperProfile).length,
    lightccInternalProfiles: rows.filter((row) => row.artifactPaths.internalProfile).length,
    missing,
  }
}

function buildCoderSummary(rows: AnalysisRow[], coderOrder: string[]): CoderSummary[] {
  return coderOrder.map((coderId) => {
    const coderRows = rows.filter((row) => row.coderId === coderId)
    const resolved = countOutcome(coderRows, "resolved")
    const estimatedCosts = coderRows.map((row) => row.provider.estimatedUsd).filter(isNumber)
    const totalCost = estimatedCosts.length > 0 ? sum(estimatedCosts) : null
    const totalTokens = sum(coderRows.map((row) => row.provider.totalTokens).filter(isNumber))
    const requestCount = sum(coderRows.map((row) => row.provider.requestCount).filter(isNumber))
    return {
      coderId,
      coderDisplayName: coderRows[0]?.coderDisplayName ?? coderId,
      rows: coderRows.length,
      resolved,
      unresolved: countOutcome(coderRows, "unresolved"),
      emptyPatch: countOutcome(coderRows, "empty_patch"),
      errors: countOutcome(coderRows, "error"),
      incomplete: countOutcome(coderRows, "incomplete"),
      requestCount,
      providerErrors: sum(coderRows.map((row) => row.provider.errorCount).filter(isNumber)),
      totalTokens,
      inputTokens: sum(coderRows.map((row) => row.provider.inputTokens).filter(isNumber)),
      outputTokens: sum(coderRows.map((row) => row.provider.outputTokens).filter(isNumber)),
      reasoningTokens: sum(coderRows.map((row) => row.provider.reasoningTokens).filter(isNumber)),
      cacheReadInputTokens: sum(coderRows.map((row) => row.provider.cacheReadInputTokens).filter(isNumber)),
      cacheWriteInputTokens: sum(coderRows.map((row) => row.provider.cacheWriteInputTokens).filter(isNumber)),
      wrapperDurationMs: sum(coderRows.map((row) => row.wrapper.durationMs).filter(isNumber)),
      wrapperNonzeroExitCount: coderRows.filter((row) => row.wrapper.exitCode !== null && row.wrapper.exitCode !== 0).length,
      estimatedUsd: roundNullable(totalCost),
      tokensPerResolved: resolved > 0 ? round(totalTokens / resolved, 3) : null,
      requestsPerResolved: resolved > 0 ? round(requestCount / resolved, 3) : null,
      costPerResolved: resolved > 0 && totalCost !== null ? round(totalCost / resolved, 6) : null,
      medianTokens: median(coderRows.map((row) => row.provider.totalTokens).filter(isNumber)),
      failureCategories: countFailureCategories(coderRows),
    }
  })
}

function buildInstanceMatrix(rows: AnalysisRow[], coderOrder: string[]): InstanceMatrixEntry[] {
  const byInstance = groupBy(rows, (row) => row.instanceId)
  return [...byInstance.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([instanceId, instanceRows]) => {
    const outcomes: Record<string, InstanceCoderCell> = {}
    for (const row of instanceRows) {
      outcomes[row.coderId] = {
        outcome: row.officialOutcome,
        totalTokens: row.provider.totalTokens,
        requestCount: row.provider.requestCount,
        wrapperDurationMs: row.wrapper.durationMs,
        estimatedUsd: row.provider.estimatedUsd,
        patchLines: row.patchLines,
        emptyPatch: row.emptyPatch,
        providerErrors: row.provider.errorCount,
        wrapperExitCode: row.wrapper.exitCode,
        failureCategory: row.failureAttribution.category,
        failureReason: row.failureAttribution.failureReason,
        failureConfidence: row.failureAttribution.confidence,
        nextAction: row.failureAttribution.nextAction,
      }
    }
    const solvedCoders = coderOrder.filter((coderId) => outcomes[coderId]?.outcome === "resolved")
    const lightcc = outcomes.lightcc
    const bestResolvedCompetitor = bestCompetitor(outcomes)
    return {
      instanceId,
      repo: instanceRows.find((row) => row.repo)?.repo ?? null,
      outcomes,
      solvedCoders,
      lightccOutcome: lightcc?.outcome ?? null,
      bestResolvedCompetitor,
      note: instanceNote(lightcc, solvedCoders, bestResolvedCompetitor),
    }
  })
}

function buildPriorities(matrix: InstanceMatrixEntry[], rows: AnalysisRow[]): PriorityCase[] {
  const rowsByKey = new Map(rows.map((row) => [`${row.coderId}\0${row.instanceId}`, row]))
  const priorities: PriorityCase[] = []
  for (const entry of matrix) {
    const lightccRow = rowsByKey.get(`lightcc\0${entry.instanceId}`) ?? null
    const lightcc = entry.outcomes.lightcc
    const solvedCompetitors = entry.solvedCoders.filter((coderId) => coderId !== "lightcc")
    const best = entry.bestResolvedCompetitor
    if (!lightcc) continue
    if (lightcc.providerErrors && lightcc.providerErrors > 0 || lightcc.wrapperExitCode !== null && lightcc.wrapperExitCode !== 0) {
      priorities.push(priority(entry, "runtime_or_wrapper_issue", 85, `providerErrors=${lightcc.providerErrors ?? 0}, wrapperExit=${lightcc.wrapperExitCode ?? "null"}`, lightccRow))
    }
    if (lightcc.outcome === "empty_patch" || lightcc.emptyPatch) {
      priorities.push(priority(entry, "empty_patch_or_no_submission", 84, `LightCC empty patch; solved competitors=${solvedCompetitors.join(", ") || "none"}`, lightccRow))
    }
    if (lightcc.outcome !== "resolved" && solvedCompetitors.length >= 2) {
      priorities.push(priority(entry, "high_priority_gap", 100, `LightCC=${lightcc.outcome}, solved competitors=${solvedCompetitors.join(", ")}`, lightccRow))
    }
    if (lightcc.outcome !== "resolved" && best?.totalTokens && lightcc.totalTokens && best.totalTokens < lightcc.totalTokens) {
      const lightccTokens = lightcc.totalTokens
      const bestTokens = best.totalTokens
      const evidence = `LightCC failed with ${lightccTokens} tokens; ${best.coderId} solved with ${bestTokens} tokens`
      priorities.push(priority(entry, "cheap_competitor_win", 90, evidence, lightccRow))
    }
    if (lightcc.outcome !== "resolved" && (lightcc.totalTokens ?? 0) >= 150_000) {
      priorities.push(priority(entry, "high_cost_unresolved", 78, `LightCC unresolved with ${lightcc.totalTokens} tokens`, lightccRow))
    }
    if (lightcc.outcome === "resolved" && best?.totalTokens && lightcc.totalTokens && lightcc.totalTokens > best.totalTokens * 1.5) {
      priorities.push(priority(entry, "expensive_success", 62, `LightCC solved with ${lightcc.totalTokens} tokens; ${best.coderId} solved with ${best.totalTokens}`, lightccRow))
    }
    if (lightcc.outcome === "resolved" && solvedCompetitors.length <= 1) {
      priorities.push(priority(entry, "lightcc_strength", 35, `LightCC solved; solved competitors=${solvedCompetitors.join(", ") || "none"}`, lightccRow))
    }
    if (entry.solvedCoders.length === 0) {
      priorities.push(priority(entry, "all_failed", 20, "All coders failed this instance", lightccRow))
    }
  }
  return dedupePriorities(priorities).sort((left, right) => right.priorityScore - left.priorityScore || left.instanceId.localeCompare(right.instanceId))
}

function priority(entry: InstanceMatrixEntry, category: PriorityCase["category"], priorityScore: number, evidence: string, lightccRow: AnalysisRow | null): PriorityCase {
  return {
    instanceId: entry.instanceId,
    category,
    priorityScore,
    lightccOutcome: entry.lightccOutcome,
    solvedCompetitors: entry.solvedCoders.filter((coderId) => coderId !== "lightcc"),
    bestCompetitor: entry.bestResolvedCompetitor?.coderId ?? null,
    evidence,
    nextArtifactPaths: lightccRow?.artifactPaths ?? null,
  }
}

function dedupePriorities(priorities: PriorityCase[]): PriorityCase[] {
  const seen = new Set<string>()
  const result: PriorityCase[] = []
  for (const item of priorities) {
    const key = `${item.instanceId}\0${item.category}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

type ActionPriorityBuildContext = {
  matrixByInstance: Map<string, InstanceMatrixEntry>
}

type ActionPriorityDefinition = {
  improvementClass: ActionPriorityClass
  priorityScore: number
  title: string
  targetArea: string
  implementationModules: string[]
  whyValuable: string
  expectedImpact: string
  nextAction: string
  confidence: ActionPriorityConfidence
  manualMatches: (item: ManualFailureAttributionRecord, context: ActionPriorityBuildContext) => boolean
  failureMatches: (item: FailureAttributionRecord, context: ActionPriorityBuildContext) => boolean
  rowMatches: (row: AnalysisRow, context: ActionPriorityBuildContext) => boolean
}

type ActionPrioritySupport = {
  instanceIds: Set<string>
  coderIds: Set<string>
  evidence: Set<string>
  manualCount: number
  ruleCount: number
  rowCount: number
}

function buildActionPriorities(
  manualFailureAttributions: ManualFailureAttributionRecord[],
  failureAttributions: FailureAttributionRecord[],
  matrix: InstanceMatrixEntry[],
  rows: AnalysisRow[],
): ActionPriority[] {
  const context: ActionPriorityBuildContext = {
    matrixByInstance: new Map(matrix.map((entry) => [entry.instanceId, entry])),
  }
  return actionPriorityDefinitions()
    .map((definition, index) => {
      const support = emptyActionSupport()
      for (const item of manualFailureAttributions) {
        if (!definition.manualMatches(item, context)) continue
        addActionSupport(support, "manual", item.coderId, item.instanceId, manualActionEvidence(item))
      }
      for (const item of failureAttributions) {
        if (!definition.failureMatches(item, context)) continue
        addActionSupport(support, "rule", item.coderId, item.instanceId, failureActionEvidence(item))
      }
      for (const row of rows) {
        if (!definition.rowMatches(row, context)) continue
        addActionSupport(support, "row", row.coderId, row.instanceId, rowActionEvidence(row, context))
      }
      if (support.instanceIds.size === 0) return null
      const supportScore = Math.min(support.manualCount * 7 + support.ruleCount * 3 + support.rowCount, 80)
      return {
        index,
        score: definition.priorityScore + supportScore,
        item: {
          rank: 0,
          classRank: 0,
          improvementClass: definition.improvementClass,
          improvementClassLabel: ACTION_PRIORITY_CLASS_LABELS[definition.improvementClass],
          title: definition.title,
          targetArea: definition.targetArea,
          implementationModules: definition.implementationModules,
          whyValuable: `${definition.whyValuable} 证据覆盖 ${support.instanceIds.size} 个 instance、${support.coderIds.size} 个 coder。`,
          evidence: actionPriorityEvidence(support),
          affectedInstances: [...support.instanceIds].sort(),
          affectedCoders: sortedCoders([...support.coderIds]),
          expectedImpact: definition.expectedImpact,
          nextAction: definition.nextAction,
          confidence: definition.confidence,
        },
      }
    })
    .filter((entry): entry is { index: number; score: number; item: ActionPriority } => Boolean(entry))
    .sort((left, right) => actionPriorityClassRank(left.item.improvementClass) - actionPriorityClassRank(right.item.improvementClass) || right.score - left.score || left.index - right.index)
    .map((entry, index, entries) => ({
      ...entry.item,
      rank: index + 1,
      classRank: entries.slice(0, index + 1).filter((candidate) => candidate.item.improvementClass === entry.item.improvementClass).length,
    }))
}

function actionPriorityDefinitions(): ActionPriorityDefinition[] {
  return [
    {
      improvementClass: "lightcc_improvement",
      priorityScore: 800,
      title: "LightCC 高成本搜索后仍未通过：增加中途收敛/无进展检测",
      targetArea: "LightCC agent loop / budget policy",
      implementationModules: [
        "src/loop/runTurn.ts",
        "src/loop/executeStep.ts",
        "src/engine/ContextAssembler.ts",
        "src/context/contextBudget.ts",
        "src/profiling/profiler.ts",
      ],
      whyValuable: "LightCC 的 official unresolved 高 token 样本说明失败已经发生，成本只是诊断信号：搜索和验证循环消耗很多预算但没有形成正确补丁。",
      expectedImpact: "缩短失败题尾部消耗，把预算转向最小复现、评测后 resolved patch 对照或重新定位，提高 tokens/resolved 效率。",
      nextAction: "为 LightCC 加阶段性收敛检查：多轮无新增有效 diff、验证连续失败、context 过大或 provider 预算超阈值时，转入最小复现优先流程、记录复盘对照线索或提前失败。",
      confidence: "medium",
      manualMatches: (item) => {
        const text = manualAttributionText(item)
        return item.coderId === "lightcc" && containsAny(text, [
          "高成本",
          "未收敛",
          "verificationfailed",
          "runtimenonzero",
          "totaltokens",
          "大量搜索",
          "验证均未",
        ])
      },
      failureMatches: (item) => item.coderId === "lightcc" && item.failureAttribution.category === "high_cost_search_miss",
      rowMatches: (row) =>
        row.coderId === "lightcc" &&
        row.officialOutcome !== "resolved" &&
        ((row.provider.totalTokens ?? 0) >= 150_000 ||
          (row.provider.requestCount ?? 0) >= 20 ||
          (row.lightccInternal?.runtimeNonzeroExitCount ?? 0) >= 5),
    },
    {
      improvementClass: "lightcc_improvement",
      priorityScore: 700,
      title: "失败复盘引入 resolved patch 对照，运行时强化最小复现优先流程",
      targetArea: "LightCC SWE task strategy / validation workflow",
      implementationModules: [
        "src/loop/runTurn.ts",
        "src/tools/builtins/bash.ts",
        "src/context/toolArtifacts.ts",
        "src/engine/SessionEngine.ts",
      ],
      whyValuable: "LightCC 失败里多次出现需求语义漏解、半截修复和覆盖面不足；同题 resolved coder 只用于评测后的失败复盘定位，不进入正式 evaluator 运行时上下文。",
      expectedImpact: "把 LightCC post-run 失败分析从泛化搜索转向可验证语义差距；正式运行时则优先提升先构造最小复现、再扩展实现的任务质量。",
      nextAction: "评测后对同题有 resolved coder 的失败样本，自动列出 resolved changed files、失败 patch changed files 和最小复现建议；正式运行时只要求先写复现断言再扩展实现。",
      confidence: "medium",
      manualMatches: (item, context) => {
        if (item.coderId !== "lightcc") return false
        const text = manualAttributionText(item)
        const semanticMiss = containsAny(text, [
          "需求语义漏解",
          "实现不完整",
          "覆盖面不足",
          "修复不完整",
          "漏掉",
          "半截",
          "方向接近",
          "api 调用形态错误",
          "hidden contract",
          "语义",
        ])
        return semanticMiss && (hasResolvedPeer(item.instanceId, item.coderId, context) || containsAny(text, [
          "sameinstanceresolved",
          "resolved 对照",
          "resolved coder",
          "同题 resolved",
          "成功补丁",
        ]))
      },
      failureMatches: (item) =>
        item.coderId === "lightcc" &&
        (item.failureAttribution.category === "lightcc_competitor_gap" ||
          item.failureAttribution.evidence.some((evidence) => evidence.startsWith("sameInstanceResolvedBy="))),
      rowMatches: (row, context) =>
        row.coderId === "lightcc" &&
        row.officialOutcome !== "resolved" &&
        !row.emptyPatch &&
        (row.patchLines ?? 0) > 0 &&
        hasResolvedPeer(row.instanceId, row.coderId, context),
    },
    {
      improvementClass: "lightcc_improvement",
      priorityScore: 600,
      title: "给 LightCC generated parser table / CDS parsetab 加完整性检查",
      targetArea: "LightCC generated artifact validation",
      implementationModules: [
        "src/tools/builtins/applyPatch.ts",
        "src/tools/builtins/bash.ts",
        "src/workspace/WorkspaceFs.ts",
        "src/context/toolArtifacts.ts",
      ],
      whyValuable: "LightCC 在 CDS grammar/parsetab 类题目里出现源码改了但生成表截断、污染或未同步的隐性失败。",
      expectedImpact: "把 parser table 损坏从 hidden-test failure 提前变成可解释的本地 guard，降低 generated file 类回归风险。",
      nextAction: "对涉及 generated parser table 的 patch 增加完整性校验：grammar 与 parsetab 同步、表非空、包含预期 symbols，并要求运行局部 parser 回归。",
      confidence: "high",
      manualMatches: (item) => item.coderId === "lightcc" && containsAny(manualAttributionText(item), [
        "cds_parsetab",
        "parser table",
        "parsetab",
        "grammar",
        "generated file",
        "生成表",
        "parser",
      ]),
      failureMatches: (item) => item.coderId === "lightcc" && containsAny(failureAttributionText(item), [
        "cds_parsetab",
        "parser table",
        "parsetab",
        "grammar",
        "generated file",
      ]),
      rowMatches: (row) =>
        row.coderId === "lightcc" &&
        row.officialOutcome !== "resolved" &&
        row.changedFiles.some((path) =>
          path.includes("cds_parsetab") ||
          path.endsWith("astropy/units/format/cds.py"),
        ),
    },
    {
      improvementClass: "evaluation_system",
      priorityScore: 1000,
      title: "修复 OpenHands empty patch / commit 后 diff 收集",
      targetArea: "OpenHands runner / patch collection",
      implementationModules: [
        "evals/adapters/coders/registry.ts",
        "evals/swebench/run.ts",
        "evals/wrapper-profile",
      ],
      whyValuable: "这是评测链路高置信度问题：agent 可能已经做过正确编辑，但最终评测收到空 patch。",
      expectedImpact: "把本可提交的编辑恢复为有效 diff，直接减少 empty_patch，并避免高 token no-op 样本污染横评结果。",
      nextAction: "禁止 OpenHands agent 在任务内 git commit，或在 patch 提取时收集 base..HEAD 的提交 diff；同时给 empty patch + transcript commit 行为加回归测试。",
      confidence: "high",
      manualMatches: (item) => {
        const text = manualAttributionText(item)
        return item.coderId === "openhands" &&
          containsAny(text, ["empty patch", "empty_patch", "空补丁", "无补丁"]) &&
          containsAny(text, ["commit", "git add", "git commit", "提交到 git", "未提交 diff", "harness 收集"])
      },
      failureMatches: (item, context) =>
        item.coderId === "openhands" &&
        item.failureAttribution.category === "empty_patch" &&
        hasResolvedPeer(item.instanceId, item.coderId, context),
      rowMatches: (row, context) =>
        row.coderId === "openhands" &&
        (row.officialOutcome === "empty_patch" || row.emptyPatch) &&
        ((row.provider.totalTokens ?? 0) >= 500_000 || hasResolvedPeer(row.instanceId, row.coderId, context)),
    },
    {
      improvementClass: "evaluation_system",
      priorityScore: 900,
      title: "增加评测 patch 质量 guard",
      targetArea: "Eval adapter post-run validation / patch gate",
      implementationModules: [
        "evals/swebench/run.ts",
        "evals/adapters/coders/registry.ts",
        "evals/report/swebench-analysis.ts",
      ],
      whyValuable: "空 patch、只改辅助文件、临时测试文件和 .gitignore 噪声是低成本可拦截的评测输入污染。",
      expectedImpact: "在 evaluator 前快速标记无效提交，减少无意义评测、提示重跑或修正 adapter，并让最终矩阵更可信。",
      nextAction: "在 patch 收集后增加 guard：空 patch、auxiliary-only、临时文件-only、只改 .gitignore、patch 行数异常时写明失败原因并保留 artifact 指针。",
      confidence: "high",
      manualMatches: (item) => containsAny(manualAttributionText(item), [
        ".gitignore",
        "辅助文件",
        "临时",
        "_test_script",
        "scratch",
        "空补丁",
        "no-op",
        "无关",
      ]),
      failureMatches: (item) => item.failureAttribution.category === "empty_patch" || item.failureAttribution.category === "auxiliary_only_patch",
      rowMatches: (row) =>
        row.officialOutcome === "empty_patch" ||
        row.emptyPatch ||
        auxiliaryOnlyPatch(row) ||
        row.changedFiles.some(isAuxiliaryOrScratchFile),
    },
    {
      improvementClass: "evaluation_system",
      priorityScore: 500,
      title: "增加评测 diff scope / 文件重写风险 guard",
      targetArea: "Eval patch review heuristics / risk scoring",
      implementationModules: [
        "evals/swebench/run.ts",
        "evals/report/swebench-analysis.ts",
      ],
      whyValuable: "修改面过宽、改到既有核心流程或夹带无关文件时，hidden-test 失败更难定位且会影响评测解释。",
      expectedImpact: "提前标出需要人工审阅或重跑的高风险 patch，促使 agent 收敛到最小相关文件和最小行为变更。",
      nextAction: "为 patch 加 scope score：changedFiles、patchLines、是否改核心路径、是否夹带辅助文件；超阈值时要求解释每个文件的必要性并生成最小化 diff。",
      confidence: "medium",
      manualMatches: (item) => containsAny(manualAttributionText(item), [
        "风险扩散",
        "过度",
        "overbroad",
        "回退非必要",
        "重写",
        "改了既有",
        "文件重写",
      ]),
      failureMatches: (item) => item.failureAttribution.category === "overbroad_patch",
      rowMatches: (row) =>
        row.officialOutcome !== "resolved" &&
        ((row.patchLines ?? 0) >= 250 || row.changedFiles.length >= 4),
    },
    {
      improvementClass: "external_coder_issue",
      priorityScore: 800,
      title: "标记 Aider 辅助文件噪声和 auxiliary-only patch",
      targetArea: "Aider result interpretation",
      implementationModules: [
        "evals/report/swebench-analysis.ts",
        "evals/adapters/coders/registry.ts",
      ],
      whyValuable: "Aider 多次夹带 .gitignore 或只修改辅助文件，这类失败不能归因到 LightCC。",
      expectedImpact: "把竞品自身的 patch hygiene 问题从 LightCC 短板分析里剥离，只作为横评噪声和对照样本记录。",
      nextAction: "在报告中保留这些 coder-specific 标记；做 LightCC 复盘时不要把它们计入 LightCC 改进项，只用于解释竞品失败质量。",
      confidence: "high",
      manualMatches: (item) => item.coderId !== "lightcc" && containsAny(manualAttributionText(item), [
        ".gitignore",
        "辅助文件",
        "auxiliary",
        "无关文件",
        "只改了辅助文件",
      ]),
      failureMatches: (item) => item.coderId !== "lightcc" && item.failureAttribution.category === "auxiliary_only_patch",
      rowMatches: (row) => row.coderId !== "lightcc" && auxiliaryOnlyPatch(row),
    },
    {
      improvementClass: "external_coder_issue",
      priorityScore: 700,
      title: "标记其他 coder 的语义漏解和半截修复",
      targetArea: "Competitor failure interpretation",
      implementationModules: [
        "evals/report/swebench-analysis.ts",
      ],
      whyValuable: "其他 coder 的需求语义漏解、半截修复和 API 调用形态错误只说明竞品自身失败，不能当作 LightCC 问题。",
      expectedImpact: "复盘时把外部 coder 的失败原因与 LightCC 短板分离，避免把竞品噪声误转成 LightCC 工程改动。",
      nextAction: "在横评里继续保留这些失败归因，但在 LightCC road map 中只吸收 resolved 对照，不把外部 coder 失败本身列为待办。",
      confidence: "medium",
      manualMatches: (item) => item.coderId !== "lightcc" && containsAny(manualAttributionText(item), [
        "需求语义漏解",
        "实现不完整",
        "修复不完整",
        "半截",
        "漏掉",
        "api 调用形态错误",
        "覆盖面不足",
      ]),
      failureMatches: (item) =>
        item.coderId !== "lightcc" &&
        (item.failureAttribution.category === "competitor_solved_gap" ||
          item.failureAttribution.category === "patch_failed_hidden_tests"),
      rowMatches: (row, context) =>
        row.coderId !== "lightcc" &&
        row.officialOutcome !== "resolved" &&
        !row.emptyPatch &&
        (row.patchLines ?? 0) > 0 &&
        hasResolvedPeer(row.instanceId, row.coderId, context),
    },
  ]
}

function actionPriorityClassRank(value: ActionPriorityClass): number {
  const index = ACTION_PRIORITY_CLASSES.indexOf(value)
  return index === -1 ? ACTION_PRIORITY_CLASSES.length : index
}

function emptyActionSupport(): ActionPrioritySupport {
  return {
    instanceIds: new Set(),
    coderIds: new Set(),
    evidence: new Set(),
    manualCount: 0,
    ruleCount: 0,
    rowCount: 0,
  }
}

function addActionSupport(
  support: ActionPrioritySupport,
  source: "manual" | "rule" | "row",
  coderId: string,
  instanceId: string,
  evidence: string,
): void {
  if (!coderId || !instanceId) return
  support.instanceIds.add(instanceId)
  support.coderIds.add(coderId)
  if (source === "manual") support.manualCount += 1
  else if (source === "rule") support.ruleCount += 1
  else support.rowCount += 1
  if (support.evidence.size < 8) support.evidence.add(shortEvidence(`${source} ${coderId}/${instanceId}: ${evidence}`))
}

function actionPriorityEvidence(support: ActionPrioritySupport): string[] {
  return [
    `support=${support.manualCount} manual, ${support.ruleCount} rule, ${support.rowCount} row signals`,
    ...support.evidence,
  ]
}

function manualActionEvidence(item: ManualFailureAttributionRecord): string {
  const evidence = item.evidence.slice(0, 3).join("; ")
  return [item.failureReason, evidence].filter(Boolean).join("; ")
}

function failureActionEvidence(item: FailureAttributionRecord): string {
  const failure = item.failureAttribution
  return `${failure.category}/${failure.confidence}; ${failure.evidence.slice(0, 4).join("; ")}`
}

function rowActionEvidence(row: AnalysisRow, context: ActionPriorityBuildContext): string {
  const solvedPeers = context.matrixByInstance.get(row.instanceId)?.solvedCoders.filter((coderId) => coderId !== row.coderId) ?? []
  const parts = [
    `outcome=${row.officialOutcome}`,
    `patchLines=${row.patchLines ?? "unknown"}`,
    `files=${row.changedFiles.slice(0, 3).join(",") || "-"}`,
    `tokens=${row.provider.totalTokens ?? "unknown"}`,
  ]
  if (solvedPeers.length > 0) parts.push(`sameInstanceResolvedBy=${solvedPeers.join(",")}`)
  return parts.join("; ")
}

function manualAttributionText(item: ManualFailureAttributionRecord): string {
  return [item.failureReason, item.nextAction, ...item.evidence].join(" ").toLowerCase()
}

function failureAttributionText(item: FailureAttributionRecord): string {
  return [
    item.failureAttribution.category,
    item.failureAttribution.failureReason,
    item.failureAttribution.nextAction,
    ...item.failureAttribution.evidence,
  ].join(" ").toLowerCase()
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()))
}

function hasResolvedPeer(instanceId: string, coderId: string, context: ActionPriorityBuildContext): boolean {
  return (context.matrixByInstance.get(instanceId)?.solvedCoders ?? []).some((solvedCoderId) => solvedCoderId !== coderId)
}

function auxiliaryOnlyPatch(row: AnalysisRow): boolean {
  return row.changedFiles.length > 0 && row.changedFiles.every(isAuxiliaryOrScratchFile)
}

function shortEvidence(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

async function writeSweBenchAnalysis(report: SweBenchAnalysisReport): Promise<void> {
  await mkdir(report.outputDir, { recursive: true })
  await writeFile(join(report.outputDir, "swebench-analysis.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-analysis.rows.jsonl"), `${report.rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-coder-summary.json"), `${JSON.stringify(report.coderSummary, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-instance-matrix.json"), `${JSON.stringify(report.instanceMatrix, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-optimization-priorities.json"), `${JSON.stringify(report.priorities, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-action-priorities.json"), `${JSON.stringify(report.actionPriorities, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-failure-attributions.json"), `${JSON.stringify(report.failureAttributions, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-coverage.json"), `${JSON.stringify(report.coverage, null, 2)}\n`, "utf8")
  await writeFile(join(report.outputDir, "swebench-analysis.zh-CN.md"), renderMarkdown(report), "utf8")
  await writeFile(join(report.outputDir, "swebench-dashboard.html"), renderDashboard(report), "utf8")
}

function renderMarkdown(report: SweBenchAnalysisReport): string {
  const lightccInternal = lightccInternalAggregate(report)
  const lines = [
    "# SWE-bench 四路结果分析",
    "",
    `Run ID: \`${report.runId}\``,
    `Generated: \`${report.generatedAt}\``,
    "",
    "## 结论摘要",
    "",
    `- 当前事实表覆盖 ${report.coverage.actualRows}/${report.coverage.expectedRows} 个 coder × instance。`,
    `- 公共 profiling 覆盖：provider=${report.coverage.providerProfiles}，wrapper=${report.coverage.wrapperProfiles}；LightCC internal=${report.coverage.lightccInternalProfiles}。`,
    "- 优先用官方结果定位能力差距，用公共 provider/wrapper profile 定位成本、速度、稳定性差距，再用 LightCC internal profile 做根因诊断。",
    "",
    "## 四路总览",
    "",
    "| Coder | Resolved | Unresolved | Empty Patch | Errors | Requests | Cost | Cost/Resolved | Tokens | Cache R/W | Wrapper Time | Tokens/Resolved | Internal Bottleneck | Internal Provider | Internal Transcript | Max Context | Internal Bash / Nonzero |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|",
  ]
  for (const item of report.coderSummary) {
    const internalCells = item.coderId === "lightcc"
      ? [
          lightccInternal.bottleneckSummary,
          formatDuration(lightccInternal.providerMs),
          formatDuration(lightccInternal.transcriptMs),
          formatNumber(lightccInternal.maxContextTokens),
          `${formatNumber(lightccInternal.bashCount)} / ${formatNumber(lightccInternal.nonzeroExitCount)}`,
        ]
      : ["-", "-", "-", "-", "-"]
    lines.push(`| ${item.coderId} | ${item.resolved}/${item.rows} | ${item.unresolved} | ${item.emptyPatch} | ${item.errors} | ${item.requestCount} | ${formatUsd(item.estimatedUsd)} | ${formatUsd(item.costPerResolved)} | ${item.totalTokens} | ${formatCacheRatio(item.cacheReadInputTokens, item.cacheWriteInputTokens)} | ${formatDuration(item.wrapperDurationMs)} | ${formatNumber(item.tokensPerResolved)} | ${internalCells.join(" | ")} |`)
  }
  lines.push(
    "",
    "列说明：`Resolved/Unresolved/Empty Patch/Errors` 是官方 evaluator 结果计数；`Requests` 是 provider API 请求总数；`Cost` 是美元估算成本，优先使用 SWE-bench summary/result 中已写入的 cost，其次用 provider profile token usage 和同一 DeepSeek 价格表补算；`Tokens` 是 provider 报告的总 token；`Cache R/W` 是 provider 输入 token 的缓存命中 / 新写入数量，并在括号中显示 read 占比；`Wrapper Time` 是 wrapper 进程耗时总和；`Tokens/Resolved` 是总 token 除以 resolved 数。`Internal Bottleneck` 是 LightCC 内部耗时最大的类别分布；`Internal Provider` 是 LightCC 内部 provider span 总耗时；`Internal Transcript` 是 transcript 写入总耗时；`Max Context` 是 LightCC 单次上下文组装的最大估算 token；`Internal Bash / Nonzero` 是 LightCC bash 调用总数 / 非零退出总数。Internal 列只对 LightCC 有值，其他 coder 显示 `-`。",
  )
  lines.push(...renderHarnessStructureSummary(report, lightccInternal))
  lines.push("", "## LightCC 优化优先级", "")
  lines.push("| Priority | Instance | Category | LightCC | Competitors | Evidence |")
  lines.push("|---:|---|---|---|---|---|")
  for (const item of report.priorities.slice(0, 16)) {
    lines.push(`| ${item.priorityScore} | ${item.instanceId} | ${item.category} | ${item.lightccOutcome ?? "-"} | ${item.solvedCompetitors.join(", ") || "-"} | ${item.evidence} |`)
  }
  lines.push(
    "",
    "列说明：`Priority` 是排序分数；`Instance` 是 SWE-bench 题目 ID；`Category` 是自动归类的优化类型；`LightCC` 是官方结果；`Competitors` 是解出该题的其他 coder；`Evidence` 是入选该优先级的关键证据。",
  )
  lines.push("", "## 失败归因", "")
  lines.push("| Coder | Instance | Outcome | Category | Confidence | Failure Reason | Evidence | Next Action |")
  lines.push("|---|---|---|---|---|---|---|---|")
  for (const item of report.failureAttributions) {
    const failure = item.failureAttribution
    lines.push(`| ${item.coderId} | ${item.instanceId} | ${item.officialOutcome} | ${failure.category} | ${failure.confidence} | ${escapeMarkdownTableCell(failure.failureReason)} | ${escapeMarkdownTableCell(failure.evidence.join("; "))} | ${escapeMarkdownTableCell(failure.nextAction)} |`)
  }
  lines.push(
    "",
    "列说明：`Category` 是规则化归因类型；`Confidence` 是证据置信度，empty patch、wrapper/provider 这类直接证据为 high，hidden-test 未通过这类缺少测试细节的归因为 low/medium；`Failure Reason` 是一句话根因假设；`Evidence` 只记录 bounded metadata 和诊断信号，不内嵌 prompt、transcript 或 patch 正文；`Next Action` 是下一步人工或脚本分析建议。",
  )
  if (report.manualFailureAttributions.length > 0) {
    lines.push("", "## 子智能体人工归因 Overlay", "")
    lines.push("| Reviewer | Coder | Instance | Confidence | Manual Failure Reason | Evidence | Manual Next Action |")
    lines.push("|---|---|---|---|---|---|---|")
    for (const item of report.manualFailureAttributions) {
      lines.push(`| ${item.reviewer ?? "-"} | ${item.coderId} | ${item.instanceId} | ${item.confidence} | ${escapeMarkdownTableCell(item.failureReason)} | ${escapeMarkdownTableCell(item.evidence.join("; "))} | ${escapeMarkdownTableCell(item.nextAction)} |`)
    }
    lines.push(
      "",
      "列说明：人工归因由并行子智能体按 instance 分片读取 artifacts 后汇总，通常比规则层更贴近 patch 语义；它仍然只使用本地 artifacts，不声称知道 hidden tests 的具体断言。",
    )
  }
  lines.push("", "## 高价值改动与证据", "")
  for (const improvementClass of ACTION_PRIORITY_CLASSES) {
    const items = report.actionPriorities.filter((item) => item.improvementClass === improvementClass)
    if (items.length === 0) continue
    lines.push(`### ${ACTION_PRIORITY_CLASS_LABELS[improvementClass]}`, "")
    lines.push("| Class Rank | Overall Rank | Change | Target Area | 改进模块 | Affected | Confidence | Evidence | Expected Impact | Next Action |")
    lines.push("|---:|---:|---|---|---|---|---|---|---|---|")
    for (const item of items) {
      const affected = `${item.affectedInstances.join(", ") || "-"} / ${item.affectedCoders.join(", ") || "-"}`
      lines.push(`| ${item.classRank} | ${item.rank} | ${escapeMarkdownTableCell(item.title)} | ${escapeMarkdownTableCell(item.targetArea)} | ${escapeMarkdownTableCell(item.implementationModules.join("; "))} | ${escapeMarkdownTableCell(affected)} | ${item.confidence} | ${escapeMarkdownTableCell(item.evidence.join("; "))} | ${escapeMarkdownTableCell(item.expectedImpact)} | ${escapeMarkdownTableCell(item.nextAction)} |`)
    }
    lines.push("")
  }
  if (report.actionPriorities.length === 0) lines.push("暂无。", "")
  lines.push(
    "列说明：该模块把人工 overlay、规则归因、逐题矩阵和逐行 profile 聚合成面向执行决策的改动建议。三类含义分别是：`直接改进 LightCC` 是我们需要进入 LightCC road map 的短板；`评测系统问题` 是修完后能降低评测链路对结果影响的问题；`其他 coder 问题` 只用于说明竞品自身失败或横评噪声，与 LightCC 改进无直接关系。`改进模块` 指建议落地的代码模块；LightCC 自身改进优先指向 `src/...` harness 模块，评测/竞品解释类则指向 `evals/...`。`Affected` 同时列 instance 和 coder；`Evidence` 是计数摘要与少量代表性证据，不内嵌 patch/transcript 正文。",
  )
  lines.push("", "## 逐题矩阵", "")
  lines.push(`| Instance | ${report.coderOrder.join(" | ")} | Note |`)
  lines.push(`|---|${report.coderOrder.map(() => "---").join("|")}|---|`)
  for (const item of report.instanceMatrix) {
    const cells = report.coderOrder.map((coderId) => item.outcomes[coderId]?.outcome ?? "-")
    lines.push(`| ${item.instanceId} | ${cells.join(" | ")} | ${item.note} |`)
  }
  lines.push(
    "",
    "列说明：`Instance` 是题目 ID；各 coder 列是官方 outcome；`Note` 是基于四路 outcome 和 token 的自动摘要，例如 LightCC gap、All failed、LightCC solved but expensive。",
  )
  lines.push(
    "",
    "## 逐题 Profiling 横比字段说明",
    "",
    "- `Coder`：本行对应的 coder/wrapper。",
    "- `Outcome`：官方 evaluator 最终判定；它是结果，不解释具体失败原因。",
    "- `Requests`：该题 provider API 请求次数；请求多但未 resolved，通常提示循环策略、重试或停止条件值得检查。",
    "- `Total Tokens`：该题 provider 总 token 消耗，适合比较同题谁更省。",
    "- `Input / Output`：输入 token / 模型输出 token；Input 高多与上下文和 prompt 有关，Output 高多与生成长度和推理过程有关。",
    "- `Cache R/W`：缓存命中的输入 token / 未命中或新写入缓存的输入 token。",
    "- `Reasoning`：provider 报告的 reasoning token；未报告时显示 `-`。",
    "- `Avg Latency`：provider 请求平均端到端耗时；`First Token`：平均首 token 延迟。",
    "- `Wrapper`：wrapper 进程总耗时；`Exit`：wrapper 退出码，0 表示 wrapper 正常结束。",
    "- `Patch`：patch 行数；`Changed Files`：patch 涉及文件。",
    "- `Internal Bottleneck`：LightCC 内部耗时最大的 span 类别。",
    "- `Internal Max Context`：LightCC 单次上下文组装的最大估算 token。",
    "- `Internal Provider`：LightCC 内部 provider span 总耗时。",
    "- `Internal Transcript`：LightCC transcript 写入耗时。",
    "- `Internal Bash / Nonzero`：LightCC bash 调用次数 / 非零退出次数；非零退出不等同于官方 evaluator 失败。",
    "- `Signals`：自动诊断标签，例如 lowest tokens、highest tokens、fastest wrapper、LightCC gap、expensive success。",
  )
  lines.push("", "## Safety", "")
  for (const note of report.notes) lines.push(`- ${note}`)
  return `${lines.join("\n")}\n`
}

function lightccInternalRows(report: SweBenchAnalysisReport): AnalysisRow[] {
  return report.rows
    .filter((row) => row.coderId === "lightcc" && row.lightccInternal)
    .sort((left, right) => {
      const outcomeDelta = outcomeSort(left.officialOutcome) - outcomeSort(right.officialOutcome)
      return outcomeDelta || (right.provider.totalTokens ?? 0) - (left.provider.totalTokens ?? 0)
    })
}

function lightccInternalAggregate(report: SweBenchAnalysisReport): {
  bottleneckSummary: string
  providerMs: number | null
  transcriptMs: number | null
  maxContextTokens: number | null
  bashCount: number | null
  nonzeroExitCount: number | null
} {
  const rows = lightccInternalRows(report)
  const bottlenecks = new Map<string, number>()
  let providerMs = 0
  let transcriptMs = 0
  let maxContextTokens: number | null = null
  let bashCount = 0
  let nonzeroExitCount = 0
  for (const row of rows) {
    const profile = row.lightccInternal
    if (!profile) continue
    const bottleneck = profile.topBottleneck ?? "unknown"
    bottlenecks.set(bottleneck, (bottlenecks.get(bottleneck) ?? 0) + 1)
    providerMs += profile.providerTotalDurationMs ?? 0
    transcriptMs += profile.transcriptWriteDurationMs ?? 0
    bashCount += profile.bashCount ?? 0
    nonzeroExitCount += profile.runtimeNonzeroExitCount ?? 0
    const contextTokens = profile.maxEstimatedTokens
    if (contextTokens !== null && (maxContextTokens === null || contextTokens > maxContextTokens)) maxContextTokens = contextTokens
  }
  return {
    bottleneckSummary: [...bottlenecks.entries()].map(([name, count]) => `${name}=${count}`).join(", ") || "-",
    providerMs: rows.length > 0 ? providerMs : null,
    transcriptMs: rows.length > 0 ? transcriptMs : null,
    maxContextTokens,
    bashCount: rows.length > 0 ? bashCount : null,
    nonzeroExitCount: rows.length > 0 ? nonzeroExitCount : null,
  }
}

function outcomeSort(outcome: OfficialOutcome): number {
  if (outcome === "unresolved") return 0
  if (outcome === "empty_patch") return 1
  if (outcome === "error") return 2
  if (outcome === "incomplete") return 3
  return 4
}

function renderHarnessStructureSummary(
  report: SweBenchAnalysisReport,
  lightccInternal: ReturnType<typeof lightccInternalAggregate>,
): string[] {
  const lines: string[] = ["", "## Harness 结构评价与改进方向", ""]
  const lightcc = coderSummaryFor(report, "lightcc")
  const aider = coderSummaryFor(report, "aider")
  const openhands = coderSummaryFor(report, "openhands")
  const opencode = coderSummaryFor(report, "opencode")
  const directActionCount = report.actionPriorities.filter((item) => item.improvementClass === "lightcc_improvement").length
  const evalActionCount = report.actionPriorities.filter((item) => item.improvementClass === "evaluation_system").length
  const externalActionCount = report.actionPriorities.filter((item) => item.improvementClass === "external_coder_issue").length
  const lightccFailureRows = report.rows.filter((row) => row.coderId === "lightcc" && row.officialOutcome !== "resolved")
  const openhandsEmptyRows = report.rows.filter((row) => row.coderId === "openhands" && row.officialOutcome === "empty_patch")
  const openhandsEmptyTokens = sum(openhandsEmptyRows.map((row) => row.provider.totalTokens).filter(isNumber))
  const noteCounts = countMatrixNotes(report)
  const highCostPriorityCount = report.priorities.filter((item) => item.category === "high_cost_unresolved").length
  const lightccGapPriorityCount = report.priorities.filter((item) => item.category === "high_priority_gap").length
  const patchGuard = report.actionPriorities.find((item) => item.title === "增加评测 patch 质量 guard")
  const noProgressAction = report.actionPriorities.find((item) => item.title === "LightCC 高成本搜索后仍未通过：增加中途收敛/无进展检测")
  const reproAction = report.actionPriorities.find((item) => item.title === "失败复盘引入 resolved patch 对照，运行时强化最小复现优先流程")
  const parserGuard = report.actionPriorities.find((item) => item.title === "给 LightCC generated parser table / CDS parsetab 加完整性检查")

  lines.push(
    "这次结果说明，当前 harness 已经是一个可复盘的测量系统：它能稳定跑出四路官方 outcome，能把每个 coder 的 provider/profile/wrapper 产物汇总到同一张事实表，也能把 LightCC internal profile 与公共横比隔离开。但它还不是一个足够强的闭环系统：patch 收集、patch 质量 gate、LightCC 运行时收敛判断、以及评测后失败复盘，还没有把这些数据直接转化成自动防错或运行时策略。",
    "",
    "### 结构评价",
    "",
    "| 结构层 | 当前做法 | 数据证据 | 评价 |",
    "|---|---|---|---|",
  )
  lines.push(
    `| Adapter 契约 | \`evals/adapters/coders/types.ts\` 定义统一 \`CoderAdapter\`，\`loader.ts\` 校验 schema、target、模板变量和 secret env，\`registry.ts\` 管理 LightCC/Aider/OpenHands/OpenCode。 | 本轮 ${report.coderOrder.length} 个 coder 产出 ${report.coverage.actualRows}/${report.coverage.expectedRows} 行；官方 JSON=${report.coverage.officialJsons}。 | 结构清晰，适合横评；下一步要把 coder-specific 风险写入 adapter 元数据，例如 OpenHands commit diff、Aider 辅助文件噪声。 |`,
    `| SWE runner 与 artifact | \`evals/swebench/run.ts\` 负责安全 taskset、repo checkout、agent command、patch.diff、metrics.json、wrapper.profile.json 和 evaluator 调用。 | provider profiles=${report.coverage.providerProfiles}，wrapper profiles=${report.coverage.wrapperProfiles}，missing=${report.coverage.missing.length}；LightCC empty/error=${lightcc?.emptyPatch ?? 0}/${lightcc?.errors ?? 0}。 | 稳定性好，数据完整；短板是 patch 提取只看工作区 diff，commit 后 diff 和 patch 质量没有在 runner 层强制判定。 |`,
    `| LightCC internal profiling | LightCC 额外写 \`profile.report.json\`，报告只把它用于 LightCC 自诊断，不参与外部 coder 横比。 | LightCC internal=${report.coverage.lightccInternalProfiles}；top bottleneck=${escapeMarkdownTableCell(lightccInternal.bottleneckSummary)}；provider=${formatDuration(lightccInternal.providerMs)}，transcript=${formatDuration(lightccInternal.transcriptMs)}，maxContext=${formatNumber(lightccInternal.maxContextTokens)}，bash/nonzero=${formatNumber(lightccInternal.bashCount)}/${formatNumber(lightccInternal.nonzeroExitCount)}。 | 诊断粒度已经足够定位瓶颈；下一步应把高成本、重复失败验证、context 过大这些信号反馈到运行时收敛策略。 |`,
    `| 报告与归因 | \`evals/report/swebench-analysis.ts\` 汇总官方结果、公共 profile、LightCC internal、规则归因和人工 overlay，并生成 action priorities。 | action priorities=${report.actionPriorities.length}，其中直接改进 LightCC=${directActionCount}，评测系统=${evalActionCount}，其他 coder 问题=${externalActionCount}。 | 报告已经能分清 LightCC road map 和横评噪声；下一步要把 action priorities 变成 runner/loop 的可测试 guard。 |`,
    "",
    "### 数据判断",
    "",
    "| 观察项 | 数据 | 结论 |",
    "|---|---|---|",
  )
  lines.push(
    `| 官方结果 | LightCC=${formatResolved(lightcc)}，OpenCode=${formatResolved(opencode)}，OpenHands=${formatResolved(openhands)}，Aider=${formatResolved(aider)}。 | LightCC 与 OpenHands 同为 10/20，但 OpenHands 有 ${openhands?.emptyPatch ?? 0} 个 empty patch；OpenCode 12/20 是当前最高。 |`,
    `| 成本位置 | LightCC tokens=${formatTokenCount(lightcc?.totalTokens ?? null)}，tokens/resolved=${formatNumber(lightcc?.tokensPerResolved ?? null)}；OpenCode tokens/resolved=${formatNumber(opencode?.tokensPerResolved ?? null)}，OpenHands=${formatNumber(openhands?.tokensPerResolved ?? null)}，Aider=${formatNumber(aider?.tokensPerResolved ?? null)}。 | LightCC 比 OpenCode/OpenHands 省 token，但比 Aider 贵；Aider 低成本伴随 7/20 resolved 和辅助文件噪声，不能只按成本排序。 |`,
    `| LightCC 失败形态 | ${lightccFailureRows.length} 个未通过：patch_failed_hidden_tests=${lightcc?.failureCategories.patch_failed_hidden_tests ?? 0}，high_cost_search_miss=${lightcc?.failureCategories.high_cost_search_miss ?? 0}，lightcc_competitor_gap=${lightcc?.failureCategories.lightcc_competitor_gap ?? 0}。 | 当前最大问题不是运行崩溃，而是补丁语义、验证闭环和高成本搜索没有收敛。 |`,
    `| 逐题矩阵 | All failed=${noteCounts.get("All failed") ?? 0}，LightCC gap=${noteCounts.get("LightCC gap") ?? 0}，LightCC solved but expensive=${noteCounts.get("LightCC solved but expensive") ?? 0}，Mixed=${noteCounts.get("Mixed") ?? 0}。 | LightCC gap 题优先做 resolved 对照复盘；expensive success 题说明成功路径也有降本空间。 |`,
    `| 评测链路噪声 | OpenHands empty patch=${openhandsEmptyRows.length}，这些 empty patch 总 token=${formatTokenCount(openhandsEmptyTokens)}；patch guard 影响 ${patchGuard?.affectedInstances.length ?? 0} 个 instance、${patchGuard?.affectedCoders.length ?? 0} 个 coder。 | 评测系统先修 patch 收集和质量 gate，可以立即提高矩阵可信度，避免把 no-op 样本混进模型能力分析。 |`,
    "",
    "### 未来改进方向",
    "",
    "| 优先级 | 方向 | 数据依据 | 具体做法 | 落地模块 |",
    "|---:|---|---|---|---|",
  )
  lines.push(
    `| 1 | 修 patch 收集和 patch 质量 gate | OpenHands ${openhandsEmptyRows.length} 个 empty patch 消耗 ${formatTokenCount(openhandsEmptyTokens)}；patch guard 覆盖 ${patchGuard?.affectedInstances.length ?? 0} 个 instance、${patchGuard?.affectedCoders.length ?? 0} 个 coder。 | 在 agent 运行前记录 base HEAD；运行后先取 worktree diff，若为空再取 \`base..HEAD\` commit diff；禁止或标记 agent 内部 commit。patch 收集后写 \`patchQuality\`：empty、auxiliary-only、temp-only、only .gitignore、patchLines 过大、changedFiles 过多。guard 命中时写入 metrics/wrapper warnings，并在报告中作为高置信评测问题展示。 | \`${escapeMarkdownTableCell((patchGuard?.implementationModules ?? ["evals/swebench/run.ts"]).join("`; `"))}\` |`,
    `| 2 | 给 LightCC 加中途收敛/无进展检测 | high_cost_search_miss=${lightcc?.failureCategories.high_cost_search_miss ?? 0}；high_cost_unresolved 优先级题=${highCostPriorityCount}；相关 action 覆盖 ${noProgressAction?.affectedInstances.length ?? 0} 个 instance；maxContext=${formatNumber(lightccInternal.maxContextTokens)}。 | 在 loop state 里记录每轮 patch SHA、changedFiles、验证命令、非零退出次数、request/token/context 水位。若连续 N 轮没有新增有效 diff、同一验证连续失败、context 超过 30k、或 SWE 单题请求超过 20 且没有复现证据，则切换到 repro-first 模式或提前失败并写明原因。 | \`${escapeMarkdownTableCell((noProgressAction?.implementationModules ?? ["src/loop/runTurn.ts"]).join("`; `"))}\` |`,
    `| 3 | 运行时强化最小复现，评测后才做 resolved patch 对照 | LightCC competitor gap 失败=${lightcc?.failureCategories.lightcc_competitor_gap ?? 0}；LightCC gap 矩阵题=${noteCounts.get("LightCC gap") ?? 0}；repro action 覆盖 ${reproAction?.affectedInstances.length ?? 0} 个 instance。 | 正式运行时要求先产出最小复现命令或 focused failing assertion，再扩大实现；若找不到复现，记录 no-repro rationale。评测后分析才列出 resolved changed files、失败 patch changed files、scope 差异和候选最小复现，不把竞品答案注入正式 evaluator。 | \`${escapeMarkdownTableCell((reproAction?.implementationModules ?? ["src/loop/runTurn.ts"]).join("`; `"))}\` |`,
    `| 4 | 给 generated artifacts 加完整性检查 | astropy__astropy-14369 中 LightCC unresolved，tokens=3570088，patchLines=97，changedFiles 包含 \`cds.py\`、\`cds_parsetab.py\` 和临时脚本；parser guard 覆盖 ${parserGuard?.affectedInstances.length ?? 0} 个 instance。 | 当 patch 触及 parser table、grammar 生成文件或类似 \`*_parsetab.py\` 时，强制跑完整性检查：源 grammar 与 generated table 同步、table 非空、关键 symbols 存在、import 不报错、局部 parser 回归通过；失败时要求回退 generated file 或重新生成。 | \`${escapeMarkdownTableCell((parserGuard?.implementationModules ?? ["src/tools/builtins/applyPatch.ts"]).join("`; `"))}\` |`,
    `| 5 | 把报告 action priorities 反向接入 harness 配置 | 当前 action priorities=${report.actionPriorities.length}，已分成直接改进 LightCC=${directActionCount}、评测系统=${evalActionCount}、其他 coder=${externalActionCount}。 | 在 \`swebench-action-priorities.json\` 之外增加机器可读 \`guardSignals\`：patchQuality、loopConvergence、reproEvidence、resolvedPeerContrast。dashboard 和 Markdown 继续展示数据，人类 road map 只吸收 \`lightcc_improvement\`，评测 gate 只吸收 \`evaluation_system\`。 | \`evals/report/swebench-analysis.ts\`; \`evals/swebench/run.ts\`; \`src/profiling/profiler.ts\` |`,
    "",
    `执行顺序建议：先做评测系统的 patch 收集和质量 gate，因为它直接覆盖 ${patchGuard?.affectedInstances.length ?? 0} 个 instance 且能清掉 ${formatTokenCount(openhandsEmptyTokens)} empty-patch 噪声；再做 LightCC loop 收敛和 repro-first，因为这对应 ${lightccFailureRows.length} 个 LightCC 未通过题中的主要失败形态；最后补 generated artifact guard，把 astropy__astropy-14369 这种 3570088 token 的隐性损坏提前变成本地可解释失败。`,
  )
  return lines
}

function coderSummaryFor(report: SweBenchAnalysisReport, coderId: string): CoderSummary | undefined {
  return report.coderSummary.find((item) => item.coderId === coderId)
}

function formatResolved(item: CoderSummary | undefined): string {
  if (!item) return "-"
  return `${item.resolved}/${item.rows}`
}

function countMatrixNotes(report: SweBenchAnalysisReport): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of report.instanceMatrix) counts.set(item.note, (counts.get(item.note) ?? 0) + 1)
  return counts
}

function renderDashboardHarnessSummary(
  report: SweBenchAnalysisReport,
  lightccInternal: ReturnType<typeof lightccInternalAggregate>,
): string {
  const lightcc = coderSummaryFor(report, "lightcc")
  const aider = coderSummaryFor(report, "aider")
  const openhands = coderSummaryFor(report, "openhands")
  const opencode = coderSummaryFor(report, "opencode")
  const directActionCount = report.actionPriorities.filter((item) => item.improvementClass === "lightcc_improvement").length
  const evalActionCount = report.actionPriorities.filter((item) => item.improvementClass === "evaluation_system").length
  const externalActionCount = report.actionPriorities.filter((item) => item.improvementClass === "external_coder_issue").length
  const lightccFailureRows = report.rows.filter((row) => row.coderId === "lightcc" && row.officialOutcome !== "resolved")
  const openhandsEmptyRows = report.rows.filter((row) => row.coderId === "openhands" && row.officialOutcome === "empty_patch")
  const openhandsEmptyTokens = sum(openhandsEmptyRows.map((row) => row.provider.totalTokens).filter(isNumber))
  const noteCounts = countMatrixNotes(report)
  const highCostPriorityCount = report.priorities.filter((item) => item.category === "high_cost_unresolved").length
  const patchGuard = report.actionPriorities.find((item) => item.title === "增加评测 patch 质量 guard")
  const noProgressAction = report.actionPriorities.find((item) => item.title === "LightCC 高成本搜索后仍未通过：增加中途收敛/无进展检测")
  const reproAction = report.actionPriorities.find((item) => item.title === "失败复盘引入 resolved patch 对照，运行时强化最小复现优先流程")
  const parserGuard = report.actionPriorities.find((item) => item.title === "给 LightCC generated parser table / CDS parsetab 加完整性检查")
  const structureRows = [
    {
      layer: "Adapter 契约",
      current: "evals/adapters/coders/types.ts 定义统一 CoderAdapter，loader.ts 校验 schema、target、模板变量和 secret env，registry.ts 管理 LightCC/Aider/OpenHands/OpenCode。",
      evidence: `本轮 ${report.coderOrder.length} 个 coder 产出 ${report.coverage.actualRows}/${report.coverage.expectedRows} 行；官方 JSON=${report.coverage.officialJsons}。`,
      judgement: "结构清晰，适合横评；下一步要把 coder-specific 风险写入 adapter 元数据，例如 OpenHands commit diff、Aider 辅助文件噪声。",
    },
    {
      layer: "SWE runner 与 artifact",
      current: "evals/swebench/run.ts 负责安全 taskset、repo checkout、agent command、patch.diff、metrics.json、wrapper.profile.json 和 evaluator 调用。",
      evidence: `provider profiles=${report.coverage.providerProfiles}，wrapper profiles=${report.coverage.wrapperProfiles}，missing=${report.coverage.missing.length}；LightCC empty/error=${lightcc?.emptyPatch ?? 0}/${lightcc?.errors ?? 0}。`,
      judgement: "稳定性好，数据完整；短板是 patch 提取只看工作区 diff，commit 后 diff 和 patch 质量没有在 runner 层强制判定。",
    },
    {
      layer: "LightCC internal profiling",
      current: "LightCC 额外写 profile.report.json，报告只把它用于 LightCC 自诊断，不参与外部 coder 横比。",
      evidence: `LightCC internal=${report.coverage.lightccInternalProfiles}；top bottleneck=${lightccInternal.bottleneckSummary}；provider=${formatDuration(lightccInternal.providerMs)}，transcript=${formatDuration(lightccInternal.transcriptMs)}，maxContext=${formatNumber(lightccInternal.maxContextTokens)}，bash/nonzero=${formatNumber(lightccInternal.bashCount)}/${formatNumber(lightccInternal.nonzeroExitCount)}。`,
      judgement: "诊断粒度已经足够定位瓶颈；下一步应把高成本、重复失败验证、context 过大这些信号反馈到运行时收敛策略。",
    },
    {
      layer: "报告与归因",
      current: "evals/report/swebench-analysis.ts 汇总官方结果、公共 profile、LightCC internal、规则归因和人工 overlay，并生成 action priorities。",
      evidence: `action priorities=${report.actionPriorities.length}，其中直接改进 LightCC=${directActionCount}，评测系统=${evalActionCount}，其他 coder 问题=${externalActionCount}。`,
      judgement: "报告已经能分清 LightCC road map 和横评噪声；下一步要把 action priorities 变成 runner/loop 的可测试 guard。",
    },
  ]
  const dataRows = [
    {
      observation: "官方结果",
      data: `LightCC=${formatResolved(lightcc)}，OpenCode=${formatResolved(opencode)}，OpenHands=${formatResolved(openhands)}，Aider=${formatResolved(aider)}。`,
      conclusion: `LightCC 与 OpenHands 同为 ${formatResolved(lightcc)}，但 OpenHands 有 ${openhands?.emptyPatch ?? 0} 个 empty patch；OpenCode ${formatResolved(opencode)} 是当前最高。`,
    },
    {
      observation: "成本位置",
      data: `LightCC tokens=${formatTokenCount(lightcc?.totalTokens ?? null)}，tokens/resolved=${formatNumber(lightcc?.tokensPerResolved ?? null)}；OpenCode tokens/resolved=${formatNumber(opencode?.tokensPerResolved ?? null)}，OpenHands=${formatNumber(openhands?.tokensPerResolved ?? null)}，Aider=${formatNumber(aider?.tokensPerResolved ?? null)}。`,
      conclusion: "LightCC 比 OpenCode/OpenHands 省 token，但比 Aider 贵；Aider 低成本伴随 7/20 resolved 和辅助文件噪声，不能只按成本排序。",
    },
    {
      observation: "LightCC 失败形态",
      data: `${lightccFailureRows.length} 个未通过：patch_failed_hidden_tests=${lightcc?.failureCategories.patch_failed_hidden_tests ?? 0}，high_cost_search_miss=${lightcc?.failureCategories.high_cost_search_miss ?? 0}，lightcc_competitor_gap=${lightcc?.failureCategories.lightcc_competitor_gap ?? 0}。`,
      conclusion: "当前最大问题不是运行崩溃，而是补丁语义、验证闭环和高成本搜索没有收敛。",
    },
    {
      observation: "逐题矩阵",
      data: `All failed=${noteCounts.get("All failed") ?? 0}，LightCC gap=${noteCounts.get("LightCC gap") ?? 0}，LightCC solved but expensive=${noteCounts.get("LightCC solved but expensive") ?? 0}，Mixed=${noteCounts.get("Mixed") ?? 0}。`,
      conclusion: "LightCC gap 题优先做 resolved 对照复盘；expensive success 题说明成功路径也有降本空间。",
    },
    {
      observation: "评测链路噪声",
      data: `OpenHands empty patch=${openhandsEmptyRows.length}，这些 empty patch 总 token=${formatTokenCount(openhandsEmptyTokens)}；patch guard 影响 ${patchGuard?.affectedInstances.length ?? 0} 个 instance、${patchGuard?.affectedCoders.length ?? 0} 个 coder。`,
      conclusion: "评测系统先修 patch 收集和质量 gate，可以立即提高矩阵可信度，避免把 no-op 样本混进模型能力分析。",
    },
  ]
  const improvementRows = [
    {
      priority: 1,
      direction: "修 patch 收集和 patch 质量 gate",
      evidence: `OpenHands ${openhandsEmptyRows.length} 个 empty patch 消耗 ${formatTokenCount(openhandsEmptyTokens)}；patch guard 覆盖 ${patchGuard?.affectedInstances.length ?? 0} 个 instance、${patchGuard?.affectedCoders.length ?? 0} 个 coder。`,
      action: "在 agent 运行前记录 base HEAD；运行后先取 worktree diff，若为空再取 base..HEAD commit diff；禁止或标记 agent 内部 commit。patch 收集后写 patchQuality：empty、auxiliary-only、temp-only、only .gitignore、patchLines 过大、changedFiles 过多。guard 命中时写入 metrics/wrapper warnings，并在报告中作为高置信评测问题展示。",
      modules: patchGuard?.implementationModules ?? ["evals/swebench/run.ts"],
    },
    {
      priority: 2,
      direction: "给 LightCC 加中途收敛/无进展检测",
      evidence: `high_cost_search_miss=${lightcc?.failureCategories.high_cost_search_miss ?? 0}；high_cost_unresolved 优先级题=${highCostPriorityCount}；相关 action 覆盖 ${noProgressAction?.affectedInstances.length ?? 0} 个 instance；maxContext=${formatNumber(lightccInternal.maxContextTokens)}。`,
      action: "在 loop state 里记录每轮 patch SHA、changedFiles、验证命令、非零退出次数、request/token/context 水位。若连续 N 轮没有新增有效 diff、同一验证连续失败、context 超过 30k、或 SWE 单题请求超过 20 且没有复现证据，则切换到 repro-first 模式或提前失败并写明原因。",
      modules: noProgressAction?.implementationModules ?? ["src/loop/runTurn.ts"],
    },
    {
      priority: 3,
      direction: "运行时强化最小复现，评测后才做 resolved patch 对照",
      evidence: `LightCC competitor gap 失败=${lightcc?.failureCategories.lightcc_competitor_gap ?? 0}；LightCC gap 矩阵题=${noteCounts.get("LightCC gap") ?? 0}；repro action 覆盖 ${reproAction?.affectedInstances.length ?? 0} 个 instance。`,
      action: "正式运行时要求先产出最小复现命令或 focused failing assertion，再扩大实现；若找不到复现，记录 no-repro rationale。评测后分析才列出 resolved changed files、失败 patch changed files、scope 差异和候选最小复现，不把竞品答案注入正式 evaluator。",
      modules: reproAction?.implementationModules ?? ["src/loop/runTurn.ts"],
    },
    {
      priority: 4,
      direction: "给 generated artifacts 加完整性检查",
      evidence: `astropy__astropy-14369 中 LightCC unresolved，tokens=3570088，patchLines=97，changedFiles 包含 cds.py、cds_parsetab.py 和临时脚本；parser guard 覆盖 ${parserGuard?.affectedInstances.length ?? 0} 个 instance。`,
      action: "当 patch 触及 parser table、grammar 生成文件或类似 *_parsetab.py 时，强制跑完整性检查：源 grammar 与 generated table 同步、table 非空、关键 symbols 存在、import 不报错、局部 parser 回归通过；失败时要求回退 generated file 或重新生成。",
      modules: parserGuard?.implementationModules ?? ["src/tools/builtins/applyPatch.ts"],
    },
    {
      priority: 5,
      direction: "把报告 action priorities 反向接入 harness 配置",
      evidence: `当前 action priorities=${report.actionPriorities.length}，已分成直接改进 LightCC=${directActionCount}、评测系统=${evalActionCount}、其他 coder=${externalActionCount}。`,
      action: "在 swebench-action-priorities.json 之外增加机器可读 guardSignals：patchQuality、loopConvergence、reproEvidence、resolvedPeerContrast。dashboard 和 Markdown 继续展示数据，人类 road map 只吸收 lightcc_improvement，评测 gate 只吸收 evaluation_system。",
      modules: ["evals/report/swebench-analysis.ts", "evals/swebench/run.ts", "src/profiling/profiler.ts"],
    },
  ]
  return `
    <section id="harnessSummary">
      <h2>Harness 结构评价与改进方向</h2>
      <p class="narrative">这次结果说明，当前 harness 已经是一个可复盘的测量系统：它能稳定跑出四路官方 outcome，能把每个 coder 的 provider/profile/wrapper 产物汇总到同一张事实表，也能把 LightCC internal profile 与公共横比隔离开。但它还不是一个足够强的闭环系统：patch 收集、patch 质量 gate、LightCC 运行时收敛判断、以及评测后失败复盘，还没有把这些数据直接转化成自动防错或运行时策略。</p>
      <h3>结构评价</h3>
      <div class="scroll"><table>
        <tr><th>结构层</th><th>当前做法</th><th>数据证据</th><th>评价</th></tr>
        ${structureRows.map((row) => `<tr><td>${escapeHtml(row.layer)}</td><td class="wrap">${escapeHtml(row.current)}</td><td class="wrap">${escapeHtml(row.evidence)}</td><td class="wrap">${escapeHtml(row.judgement)}</td></tr>`).join("")}
      </table></div>
      <h3>数据判断</h3>
      <div class="scroll"><table>
        <tr><th>观察项</th><th>数据</th><th>结论</th></tr>
        ${dataRows.map((row) => `<tr><td>${escapeHtml(row.observation)}</td><td class="wrap">${escapeHtml(row.data)}</td><td class="wrap">${escapeHtml(row.conclusion)}</td></tr>`).join("")}
      </table></div>
      <h3>未来改进方向</h3>
      <div class="scroll"><table>
        <tr><th>优先级</th><th>方向</th><th>数据依据</th><th>具体做法</th><th>落地模块</th></tr>
        ${improvementRows.map((row) => `<tr><td class="num">${row.priority}</td><td class="wrap">${escapeHtml(row.direction)}</td><td class="wrap">${escapeHtml(row.evidence)}</td><td class="wrap">${escapeHtml(row.action)}</td><td class="path">${escapeHtml(row.modules.join(" · "))}</td></tr>`).join("")}
      </table></div>
      <div class="column-notes">
        <strong>执行顺序建议</strong>
        <ul>
          <li>先做评测系统的 patch 收集和质量 gate，因为它直接覆盖 ${patchGuard?.affectedInstances.length ?? 0} 个 instance 且能清掉 ${escapeHtml(formatTokenCount(openhandsEmptyTokens))} empty-patch 噪声。</li>
          <li>再做 LightCC loop 收敛和 repro-first，因为这对应 ${lightccFailureRows.length} 个 LightCC 未通过题中的主要失败形态。</li>
          <li>最后补 generated artifact guard，把 astropy__astropy-14369 这种 3570088 token 的隐性损坏提前变成本地可解释失败。</li>
        </ul>
      </div>
    </section>`
}

function renderDashboard(report: SweBenchAnalysisReport): string {
  const data = JSON.stringify(report).replaceAll("</", "<\\/")
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SWE-bench Analysis - ${escapeHtml(report.runId)}</title>
  <style>
    :root {
      --bg: #f7f7f3;
      --text: #202124;
      --muted: #5f6368;
      --line: #d7d9d2;
      --panel: #ffffff;
      --green: #1b7f4b;
      --red: #b3261e;
      --amber: #9a5b00;
      --blue: #2766a3;
      --gray: #70757a;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { padding: 24px 28px 16px; border-bottom: 1px solid var(--line); background: #fbfbf7; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 18px; letter-spacing: 0; }
    main { padding: 20px 28px 36px; display: grid; gap: 22px; }
    section { border-top: 1px solid var(--line); padding-top: 18px; }
    .meta { color: var(--muted); display: flex; flex-wrap: wrap; gap: 16px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 14px; }
    .toolbar label { color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
    select, input { height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: white; color: var(--text); }
    button { height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 12px; background: white; color: var(--text); cursor: pointer; }
    button.active { border-color: var(--blue); color: var(--blue); background: #eef5fb; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)); gap: 12px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-height: 92px; }
    .metric strong { display: block; font-size: 20px; margin-top: 4px; }
    .metric span { color: var(--muted); }
    .scroll { overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 860px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; white-space: nowrap; }
    th { background: #f0f1ec; position: sticky; top: 0; z-index: 1; font-size: 12px; text-transform: uppercase; color: var(--muted); }
    tr:hover td { background: #fafaf5; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 78px; height: 24px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 650; }
    .resolved { background: #e7f4ed; color: var(--green); }
    .unresolved { background: #fdeeee; color: var(--red); }
    .empty_patch { background: #fff4dc; color: var(--amber); }
    .error, .incomplete { background: #eceff1; color: var(--gray); }
    .priority { border-left: 4px solid var(--blue); }
    .path { color: var(--muted); white-space: normal; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .two-col { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 420px); gap: 18px; }
    .detail { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 260px; }
    .detail dl { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 12px; margin: 0; }
    .detail dt { color: var(--muted); }
    .detail dd { margin: 0; min-width: 0; }
    .subtle { color: var(--muted); margin: -8px 0 12px; max-width: 900px; }
    .slow-spans { white-space: normal; min-width: 260px; }
    .signals { white-space: normal; min-width: 180px; }
    .wrap { white-space: normal; min-width: 220px; max-width: 520px; }
    .evidence { white-space: normal; min-width: 280px; max-width: 640px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); }
    .signal { display: inline-flex; margin: 0 4px 4px 0; padding: 2px 6px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: #f8f8f4; font-size: 12px; }
    .column-notes { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fbfbf7; color: var(--muted); }
    .column-notes strong { display: block; color: var(--text); margin-bottom: 4px; }
    .column-notes ul { margin: 0; padding-left: 18px; display: grid; gap: 3px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #f0f1ec; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
    .narrative { max-width: 1040px; margin: 0 0 14px; color: var(--text); }
    @media (max-width: 980px) {
      header, main { padding-left: 16px; padding-right: 16px; }
      .summary { grid-template-columns: repeat(2, minmax(150px, 1fr)); }
      .two-col { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>SWE-bench 四路结果分析</h1>
    <div class="meta">
      <span>Run: ${escapeHtml(report.runId)}</span>
      <span>Generated: ${escapeHtml(report.generatedAt)}</span>
      <span>Rows: ${report.coverage.actualRows}/${report.coverage.expectedRows}</span>
    </div>
  </header>
  <main>
    <section>
      <h2>总览</h2>
      <div id="summary" class="summary"></div>
    </section>
    ${renderDashboardHarnessSummary(report, lightccInternalAggregate(report))}
    <section>
      <h2>逐题矩阵</h2>
      <div class="toolbar">
        <label>Filter <select id="matrixFilter"><option value="all">All</option><option value="gap">LightCC gaps</option><option value="expensive">Expensive successes</option><option value="all_failed">All failed</option></select></label>
        <label>Search <input id="matrixSearch" type="search" placeholder="instance id"></label>
      </div>
      <div class="two-col">
        <div class="scroll"><table id="matrix"></table></div>
        <aside id="detail" class="detail"></aside>
      </div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Instance：SWE-bench 题目 ID。</li>
          <li>lightcc / aider / openhands / opencode：官方 evaluator outcome；cell 里的 tokens 与 req 是该题的 provider profile 摘要。</li>
          <li>Note：基于四路 outcome 和 token 的自动摘要，例如 LightCC gap、All failed、LightCC solved but expensive。</li>
        </ul>
      </div>
    </section>
    <section>
      <h2>逐题 Profiling 横比</h2>
      <p class="subtle">Select one instance to compare public provider/wrapper/patch signals across all coders.</p>
      <div class="toolbar">
        <label>Instance <select id="profileInstance"></select></label>
      </div>
      <div id="instanceProfileSummary" class="summary"></div>
      <div class="scroll"><table id="instanceProfiles"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Coder：本行对应的 coder/wrapper，例如 lightcc、aider、openhands、opencode。这个字段用于确认同一道题的横向比较对象。</li>
          <li>Outcome：官方 SWE-bench evaluator 的最终判定。resolved 表示 hidden tests 通过；unresolved 表示提交了 patch 但未通过；empty_patch 表示没有有效 patch；error/incomplete 表示评测或提交流程没有形成正常结果。它是结果，不解释具体失败原因。</li>
          <li>Failure Reason：规则化失败归因假设；resolved 行显示 -。</li>
          <li>Evidence：支撑归因的 bounded metadata 与诊断信号，例如 patchLines、changedFiles、tokens、同题 resolved coder、LightCC internal bottleneck。</li>
          <li>Next Action：建议下一步查看的 artifact 或对比动作。</li>
          <li>Requests：该 coder 在这道题上发给 provider 的 API 请求次数。请求数高通常说明 agent 进行了更多轮思考/工具调用/重试；若没有提升 resolved，可能指向循环策略或停止条件问题。</li>
          <li>Total Tokens：provider 报告的总 token，用来衡量该题总消耗。它通常由输入 token 和输出 token 共同构成，适合横向比较“同一道题谁更省”。</li>
          <li>Input / Output：Input 是发给模型的输入 token 总量，常受 prompt、上下文、历史记录、文件内容影响；Output 是模型生成的 token 总量，常反映回答/推理/补丁生成长度。</li>
          <li>Cache R/W：Cache Read 是命中 provider 缓存的输入 token；Cache Write 是未命中或新写入缓存的输入 token。Read 高通常说明 prompt 前缀较稳定、缓存复用较好；Write 高说明新内容或变化内容更多。</li>
          <li>Reasoning：provider 返回的 reasoning token 数。如果 provider 不提供该字段会显示 -。它可辅助判断模型是否把大量 token 花在内部推理上。</li>
          <li>Avg Latency：该题所有 provider 请求的平均端到端耗时，包括等待和接收响应。它主要反映 API/provider 层速度，不能单独代表 agent 本地执行速度。</li>
          <li>First Token：平均首 token 延迟，也就是请求发出到收到第一个 token 的时间。它更接近 provider 排队、模型首响和网络延迟。</li>
          <li>Wrapper：该题 coder wrapper 进程总耗时，包括启动 coder、执行任务、收集 patch/artifact 的外层耗时。它是公共 wrapper profile 数据，可横向比较外层运行时长。</li>
          <li>Exit：wrapper 进程退出码。0 表示 wrapper 正常结束；非 0 通常表示 wrapper/runtime/harness 层异常，但不等同于官方 evaluator unresolved。</li>
          <li>Patch：生成 patch 的行数。0 或很小通常需要关注 empty patch、只改了很少内容或 patch 生成链路；很大则可能提示过度修改。</li>
          <li>Changed Files：patch 涉及的文件列表。用于判断 coder 是否改到了合理模块，或是否出现无关文件、配置文件、临时文件等可疑修改。</li>
          <li>Internal Bottleneck：LightCC 内部 profile 里耗时最大的 span 类别，例如 provider、tool、context、transcript。它只说明 LightCC 内部主要耗时在哪里。</li>
          <li>Internal Max Context：LightCC 在该题中单次上下文组装的最大估算 token。数值高通常指向上下文过大、文件/历史内容过多，可能需要优化裁剪或压缩。</li>
          <li>Internal Provider：LightCC 内部 provider span 总耗时。它和公共 provider latency 相关，但来自 LightCC 自己的 span 记录，用于定位 LightCC 内部是否主要卡在模型调用。</li>
          <li>Internal Transcript：LightCC 写 transcript 的总耗时。数值高说明日志/转录写入本身占用了明显时间，可能指向 IO 或记录策略问题。</li>
          <li>Internal Bash / Nonzero：LightCC 内部 bash 调用次数 / bash 非零退出次数。非零退出常见于探索命令、验证命令失败或试错过程，不等同于官方 evaluator 失败，但高比例可能提示工具使用或验证策略低效。</li>
          <li>Signals：自动生成的诊断标签。lowest tokens/highest tokens 标出该题 token 最低/最高者；fastest wrapper 标出外层耗时最短者；LightCC gap 表示 LightCC 未解但至少一个竞品解出；expensive success 表示 LightCC 解出但 token 明显高于更省的解题者。</li>
        </ul>
      </div>
    </section>
    <section>
      <h2>失败归因</h2>
      <div class="toolbar">
        <label>Coder <select id="failureCoder"><option value="all">All</option></select></label>
        <label>Category <select id="failureCategory"><option value="all">All</option></select></label>
        <label>Search <input id="failureSearch" type="search" placeholder="instance id or reason"></label>
      </div>
      <div class="scroll"><table id="failures"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Failure Reason：基于官方 outcome、patch、wrapper/provider profile、LightCC internal profile 和 transcript 信号生成的失败归因假设。</li>
          <li>Evidence：只包含 bounded metadata 和诊断信号，不内嵌 prompt、patch、transcript 或 stdout/stderr 正文。</li>
          <li>Next Action：下一步人工排查动作；hidden tests 不暴露时，未通过 patch 只能给出低/中置信度归因。</li>
          <li>Confidence：high 表示有直接证据，例如 empty patch、wrapper/provider error；medium 表示同题竞品对照或高成本搜索信号；low 表示只有官方 unresolved 和 patch metadata。</li>
        </ul>
      </div>
    </section>
    <section id="manualFailureSection">
      <h2>子智能体人工归因 Overlay</h2>
      <p class="subtle">Manual review from parallel sub-agents. It complements the repeatable rule-based attribution above.</p>
      <div class="scroll"><table id="manualFailures"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Manual Failure Reason：子智能体读 patch/profile/transcript 片段后的人工判断，通常包含更具体的语义偏差。</li>
          <li>Evidence：人工审阅摘要，仍然只保留 bounded evidence，不复制 prompt、patch 或 transcript 原文。</li>
          <li>Reviewer：负责该分片的子智能体昵称。</li>
        </ul>
      </div>
    </section>
    <section>
      <h2>高价值改动与证据</h2>
      <p class="subtle">Actionable changes aggregated from manual overlay, rule attribution, instance matrix, and per-row profiling.</p>
      <div class="scroll"><table id="actionPriorities"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Class：三类改进方向。直接改进 LightCC 是我们要进入 road map 的短板；评测系统问题是修完后能降低评测链路影响的问题；其他 coder 问题只用于说明竞品自身失败或横评噪声。</li>
          <li>Class Rank / Overall：组内优先级 / 全局展示顺序，不等同于单题优化分数。</li>
          <li>Change：建议做的工程改动；Target Area：主要落点，例如 runner、patch gate、LightCC loop 或 generated artifact validation。</li>
          <li>改进模块：建议落地的代码模块。LightCC 自身改进优先指向 src harness 模块；评测系统和其他 coder 问题指向 evals/report 或 adapter 模块。</li>
          <li>Affected：证据覆盖的 instance 和 coder，用于判断影响面。</li>
          <li>Evidence：来自人工 overlay、规则归因和 profile/matrix 的计数摘要与代表性证据。</li>
          <li>Expected Impact / Next Action：预期收益和可直接开工的下一步。</li>
        </ul>
      </div>
    </section>
    <section>
      <h2>LightCC 优化优先级</h2>
      <div class="scroll"><table id="priorities"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Score：自动排序分数，越高越建议优先分析。</li>
          <li>Instance：题目 ID；Category：优化类型，如 high_priority_gap、high_cost_unresolved、expensive_success。</li>
          <li>LightCC：LightCC 官方 outcome；Competitors：解出该题的其他 coder。</li>
          <li>Evidence：该题进入优先级列表的关键证据。</li>
        </ul>
      </div>
    </section>
    <section>
      <h2>Profiling 横比</h2>
      <div class="scroll"><table id="profiles"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Resolved：官方 evaluator 判定 resolved 的题数；Cost：美元估算成本，优先使用 SWE-bench summary/result cost，其次用 provider usage 和同一 DeepSeek pricing 补算；Provider Errors：provider API 错误次数总和。</li>
          <li>Requests：provider API 请求总数；Total Tokens：provider 报告的总 token；Input / Output：输入 token 总量 / 输出 token 总量。</li>
          <li>Cache R/W：总体缓存命中输入 token / 新写入缓存输入 token，并显示 read 占比；read 占比越高，说明 prompt 前缀和上下文复用越充分。</li>
          <li>Wrapper Time：wrapper 进程耗时总和；Nonzero Exits：wrapper 进程非零退出次数。</li>
          <li>Tokens/Resolved：总 token 除以 resolved 数，用于粗略衡量解题 token 效率；Cost/Resolved：总美元估算成本除以 resolved 数。</li>
          <li>Internal Bottleneck：LightCC 内部 top bottleneck 分布，例如 provider=20 表示 20 题的主瓶颈都是 provider。</li>
          <li>Internal Provider：LightCC 内部 provider span 总耗时；Internal Transcript：LightCC transcript 写入总耗时。</li>
          <li>Internal Max Context：LightCC 20 题里最大的一次上下文估算 token；Internal Bash / Nonzero：LightCC bash 调用总数 / bash 非零退出总数。</li>
          <li>Internal 列来自 LightCC profile.report.json；其他 coder 无内部 span 数据，因此显示 -。</li>
        </ul>
      </div>
    </section>
    <section>
      <h2>Coverage</h2>
      <div class="scroll"><table id="coverage"></table></div>
      <div class="column-notes">
        <strong>列说明</strong>
        <ul>
          <li>Metric：覆盖率指标名称，例如事实表行数、官方 JSON 数、provider/wrapper/internal profile 数。</li>
          <li>Value：对应指标的数量；Missing records 为 0 表示当前分析输入没有发现缺口。</li>
        </ul>
      </div>
    </section>
  </main>
  <script id="analysis-data" type="application/json">${data}</script>
  <script>
    const report = JSON.parse(document.getElementById("analysis-data").textContent);
    const coderOrder = report.coderOrder;
    const rowsByKey = new Map(report.rows.map(row => [row.coderId + "\\u0000" + row.instanceId, row]));
    const fmt = new Intl.NumberFormat("en-US");
    const ms = value => value == null ? "-" : value >= 1000 ? (value / 1000).toFixed(1) + "s" : Math.round(value) + "ms";
    const num = value => value == null ? "-" : fmt.format(Math.round(value));
    const pct = value => value == null ? "-" : value.toFixed(1) + "%";
    const cacheRatio = (read, write) => {
      const total = (read ?? 0) + (write ?? 0);
      if (!total) return "-";
      return num(read ?? 0) + " / " + num(write ?? 0) + " (" + pct(((read ?? 0) / total) * 100) + " read)";
    };
    const usd = value => value == null ? "-" : "$" + value.toFixed(6);
    const esc = value => String(value ?? "-").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const badge = outcome => '<span class="badge ' + outcome + '">' + outcome + '</span>';

    function renderSummary() {
      document.getElementById("summary").innerHTML = report.coderSummary.map(item => [
        '<div class="metric">',
        '<span>' + item.coderId + '</span>',
        '<strong>' + item.resolved + '/' + item.rows + '</strong>',
        '<span>' + usd(item.estimatedUsd) + ' · ' + num(item.totalTokens) + ' tokens · ' + item.requestCount + ' requests</span>',
        '</div>'
      ].join("")).join("");
    }

    function renderMatrix() {
      const filter = document.getElementById("matrixFilter").value;
      const search = document.getElementById("matrixSearch").value.trim().toLowerCase();
      let items = report.instanceMatrix;
      if (filter === "gap") items = items.filter(item => item.lightccOutcome !== "resolved" && item.solvedCoders.some(coder => coder !== "lightcc"));
      if (filter === "expensive") items = items.filter(item => item.note === "LightCC solved but expensive");
      if (filter === "all_failed") items = items.filter(item => item.solvedCoders.length === 0);
      if (search) items = items.filter(item => item.instanceId.toLowerCase().includes(search));
      const head = '<tr><th>Instance</th>' + coderOrder.map(coder => '<th>' + coder + '</th>').join("") + '<th>Note</th></tr>';
      const body = items.map(item => {
        const cells = coderOrder.map(coder => {
          const cell = item.outcomes[coder];
          if (!cell) return '<td>-</td>';
          return '<td>' + badge(cell.outcome) + '<div class="path">' + usd(cell.estimatedUsd) + ' · ' + num(cell.totalTokens) + ' tokens · ' + (cell.requestCount ?? "-") + ' req</div></td>';
        }).join("");
        return '<tr data-instance="' + item.instanceId + '"><td><button data-instance="' + item.instanceId + '">' + item.instanceId + '</button></td>' + cells + '<td>' + item.note + '</td></tr>';
      }).join("");
      document.getElementById("matrix").innerHTML = head + body;
      document.querySelectorAll("#matrix button").forEach(button => button.addEventListener("click", () => renderDetail(button.dataset.instance)));
      if (items[0]) renderDetail(items[0].instanceId);
    }

    function renderDetail(instanceId) {
      const item = report.instanceMatrix.find(entry => entry.instanceId === instanceId);
      if (!item) return;
      const lightcc = rowsByKey.get("lightcc\\u0000" + instanceId);
      syncProfileInstance(instanceId);
      const lines = [
        ["Instance", item.instanceId],
        ["Repo", item.repo ?? "-"],
        ["LightCC", item.lightccOutcome ? badge(item.lightccOutcome) : "-"],
        ["Solved By", item.solvedCoders.join(", ") || "-"],
        ["Best Competitor", item.bestResolvedCompetitor ? item.bestResolvedCompetitor.coderId + " · " + num(item.bestResolvedCompetitor.totalTokens) + " tokens" : "-"],
        ["Failure", lightcc?.failureAttribution?.category === "resolved" ? "-" : lightcc?.failureAttribution?.failureReason ?? "-"],
        ["Evidence", lightcc?.failureAttribution?.category === "resolved" ? "-" : lightcc?.failureAttribution?.evidence?.join(" · ") ?? "-"],
        ["Next Action", lightcc?.failureAttribution?.category === "resolved" ? "-" : lightcc?.failureAttribution?.nextAction ?? "-"],
        ["LightCC Bottleneck", lightcc?.lightccInternal?.topBottleneck ?? "-"],
        ["LightCC Max Context", num(lightcc?.lightccInternal?.maxEstimatedTokens)],
        ["Patch", lightcc?.artifactPaths?.patch ?? "-"],
        ["Transcript", lightcc?.artifactPaths?.transcript ?? "-"],
        ["Internal Profile", lightcc?.artifactPaths?.internalProfile ?? "-"]
      ];
      document.getElementById("detail").innerHTML = '<h2>Case Detail</h2><dl>' + lines.map(([key, value]) => '<dt>' + esc(key) + '</dt><dd class="' + (String(value).startsWith("/") ? "path" : "") + '">' + (String(value).startsWith("<span") ? value : esc(value)) + '</dd>').join("") + '</dl>';
    }

    function renderProfileInstanceOptions() {
      const select = document.getElementById("profileInstance");
      select.innerHTML = report.instanceMatrix.map(item => '<option value="' + item.instanceId + '">' + item.instanceId + '</option>').join("");
      select.addEventListener("change", () => renderInstanceProfiles(select.value));
    }

    function syncProfileInstance(instanceId) {
      const select = document.getElementById("profileInstance");
      if (!select || select.value === instanceId) return;
      select.value = instanceId;
      renderInstanceProfiles(instanceId);
    }

    function renderInstanceProfiles(instanceId) {
      const item = report.instanceMatrix.find(entry => entry.instanceId === instanceId) ?? report.instanceMatrix[0];
      if (!item) return;
      const rows = coderOrder.map(coder => rowsByKey.get(coder + "\\u0000" + item.instanceId)).filter(Boolean);
      const tokenRows = rows.filter(row => row.provider.totalTokens != null);
      const requestRows = rows.filter(row => row.provider.requestCount != null);
      const durationRows = rows.filter(row => row.wrapper.durationMs != null);
      const lowestToken = minBy(tokenRows, row => row.provider.totalTokens);
      const highestToken = maxBy(tokenRows, row => row.provider.totalTokens);
      const fastest = minBy(durationRows, row => row.wrapper.durationMs);
      const mostRequests = maxBy(requestRows, row => row.provider.requestCount);
      const lightcc = rowsByKey.get("lightcc\\u0000" + item.instanceId);
      document.getElementById("instanceProfileSummary").innerHTML = [
        metric("Instance", item.instanceId, item.note),
        metric("Lowest Tokens", lowestToken ? lowestToken.coderId + " · " + num(lowestToken.provider.totalTokens) : "-", "public provider profile"),
        metric("Fastest Wrapper", fastest ? fastest.coderId + " · " + ms(fastest.wrapper.durationMs) : "-", "wrapper duration"),
        metric("LightCC Internal", lightcc?.lightccInternal?.topBottleneck ?? "-", lightcc?.lightccInternal ? "max context " + num(lightcc.lightccInternal.maxEstimatedTokens) : "not available")
      ].join("");
      const head = '<tr><th>Coder</th><th>Outcome</th><th>Failure Reason</th><th>Evidence</th><th>Next Action</th><th>Requests</th><th>Cost</th><th>Total Tokens</th><th>Input / Output</th><th>Cache R/W</th><th>Reasoning</th><th>Avg Latency</th><th>First Token</th><th>Wrapper</th><th>Exit</th><th>Patch</th><th>Changed Files</th><th>Cost Source</th><th>Internal Bottleneck</th><th>Internal Max Context</th><th>Internal Provider</th><th>Internal Transcript</th><th>Internal Bash / Nonzero</th><th>Signals</th></tr>';
      const body = rows.map(row => {
        const signals = profileSignals(row, { lowestToken, highestToken, fastest, mostRequests, item });
        const internal = row.lightccInternal;
        const failure = row.failureAttribution;
        const hasFailure = failure && failure.category !== "resolved";
        return '<tr><td>' + esc(row.coderId) + '</td><td>' + badge(row.officialOutcome) + '</td><td class="wrap">' + (hasFailure ? esc(failure.failureReason) + '<div class="path">' + esc(failure.category + " · " + failure.confidence) + '</div>' : '-') + '</td><td class="evidence">' + (hasFailure ? esc(failure.evidence.join(" · ")) : '-') + '</td><td class="wrap">' + (hasFailure ? esc(failure.nextAction) : '-') + '</td><td class="num">' + num(row.provider.requestCount) + '</td><td class="num">' + usd(row.provider.estimatedUsd) + '</td><td class="num">' + num(row.provider.totalTokens) + '</td><td class="num">' + num(row.provider.inputTokens) + ' / ' + num(row.provider.outputTokens) + '</td><td class="num">' + num(row.provider.cacheReadInputTokens) + ' / ' + num(row.provider.cacheWriteInputTokens) + '</td><td class="num">' + num(row.provider.reasoningTokens) + '</td><td class="num">' + ms(row.provider.averageLatencyMs) + '</td><td class="num">' + ms(row.provider.averageFirstTokenMs) + '</td><td class="num">' + ms(row.wrapper.durationMs) + '</td><td class="num">' + (row.wrapper.exitCode ?? "-") + '</td><td class="num">' + num(row.patchLines) + ' lines</td><td class="path">' + esc(row.changedFiles.join(", ") || "-") + '</td><td class="path">' + esc(row.provider.costSource ?? "-") + '</td><td>' + esc(internal?.topBottleneck ?? "-") + '</td><td class="num">' + num(internal?.maxEstimatedTokens) + '</td><td class="num">' + ms(internal?.providerTotalDurationMs) + '</td><td class="num">' + ms(internal?.transcriptWriteDurationMs) + '</td><td class="num">' + (internal ? num(internal.bashCount) + ' / ' + num(internal.runtimeNonzeroExitCount) : '-') + '</td><td class="signals">' + signals.map(signal => '<span class="signal">' + esc(signal) + '</span>').join("") + '</td></tr>';
      }).join("");
      document.getElementById("instanceProfiles").innerHTML = head + body;
    }

    function profileSignals(row, context) {
      const signals = [];
      if (row === context.lowestToken) signals.push("lowest tokens");
      if (row === context.highestToken) signals.push("highest tokens");
      if (row === context.fastest) signals.push("fastest wrapper");
      if (row === context.mostRequests) signals.push("most requests");
      if (row.provider.errorCount > 0) signals.push("provider error");
      if (row.wrapper.exitCode != null && row.wrapper.exitCode !== 0) signals.push("wrapper exit");
      if (row.emptyPatch || row.officialOutcome === "empty_patch") signals.push("empty patch");
      if (row.coderId === "lightcc" && row.officialOutcome !== "resolved" && context.item.solvedCoders.some(coder => coder !== "lightcc")) signals.push("LightCC gap");
      if (row.coderId === "lightcc" && row.officialOutcome === "resolved" && context.lowestToken && row.provider.totalTokens && context.lowestToken.provider.totalTokens && row.provider.totalTokens > context.lowestToken.provider.totalTokens * 1.5) signals.push("expensive success");
      return signals.length > 0 ? signals : ["baseline"];
    }

    function renderFailureControls() {
      const coderSelect = document.getElementById("failureCoder");
      const categorySelect = document.getElementById("failureCategory");
      const coderOptions = [...new Set(report.failureAttributions.map(item => item.coderId))];
      const categoryOptions = [...new Set(report.failureAttributions.map(item => item.failureAttribution.category))].sort();
      coderSelect.innerHTML = '<option value="all">All</option>' + coderOptions.map(coder => '<option value="' + esc(coder) + '">' + esc(coder) + '</option>').join("");
      categorySelect.innerHTML = '<option value="all">All</option>' + categoryOptions.map(category => '<option value="' + esc(category) + '">' + esc(category) + '</option>').join("");
    }

    function renderFailures() {
      const coder = document.getElementById("failureCoder").value;
      const category = document.getElementById("failureCategory").value;
      const search = document.getElementById("failureSearch").value.trim().toLowerCase();
      let items = report.failureAttributions;
      if (coder !== "all") items = items.filter(item => item.coderId === coder);
      if (category !== "all") items = items.filter(item => item.failureAttribution.category === category);
      if (search) {
        items = items.filter(item => [
          item.instanceId,
          item.coderId,
          item.officialOutcome,
          item.failureAttribution.category,
          item.failureAttribution.failureReason,
          item.failureAttribution.nextAction,
          item.failureAttribution.evidence.join(" ")
        ].join(" ").toLowerCase().includes(search));
      }
      const head = '<tr><th>Coder</th><th>Instance</th><th>Outcome</th><th>Category</th><th>Confidence</th><th>Failure Reason</th><th>Evidence</th><th>Next Action</th></tr>';
      const body = items.map(item => {
        const failure = item.failureAttribution;
        return '<tr><td>' + esc(item.coderId) + '</td><td>' + esc(item.instanceId) + '</td><td>' + badge(item.officialOutcome) + '</td><td>' + esc(failure.category) + '</td><td>' + esc(failure.confidence) + '</td><td class="wrap">' + esc(failure.failureReason) + '</td><td class="evidence">' + esc(failure.evidence.join(" · ")) + '</td><td class="wrap">' + esc(failure.nextAction) + '</td></tr>';
      }).join("");
      document.getElementById("failures").innerHTML = head + body;
    }

    function renderManualFailures() {
      const section = document.getElementById("manualFailureSection");
      if (!report.manualFailureAttributions || report.manualFailureAttributions.length === 0) {
        section.style.display = "none";
        return;
      }
      section.style.display = "";
      const head = '<tr><th>Reviewer</th><th>Coder</th><th>Instance</th><th>Confidence</th><th>Manual Failure Reason</th><th>Evidence</th><th>Manual Next Action</th></tr>';
      const body = report.manualFailureAttributions.map(item => {
        return '<tr><td>' + esc(item.reviewer ?? "-") + '</td><td>' + esc(item.coderId) + '</td><td>' + esc(item.instanceId) + '</td><td>' + esc(item.confidence) + '</td><td class="wrap">' + esc(item.failureReason) + '</td><td class="evidence">' + esc(item.evidence.join(" · ")) + '</td><td class="wrap">' + esc(item.nextAction) + '</td></tr>';
      }).join("");
      document.getElementById("manualFailures").innerHTML = head + body;
    }

    function minBy(items, valueFor) {
      return items.reduce((best, item) => !best || valueFor(item) < valueFor(best) ? item : best, null);
    }

    function maxBy(items, valueFor) {
      return items.reduce((best, item) => !best || valueFor(item) > valueFor(best) ? item : best, null);
    }

    function renderActionPriorities() {
      const items = report.actionPriorities ?? [];
      const head = '<tr><th>Class</th><th>Class Rank</th><th>Overall</th><th>Change</th><th>Target Area</th><th>改进模块</th><th>Affected</th><th>Confidence</th><th>Evidence</th><th>Expected Impact</th><th>Next Action</th></tr>';
      let previousClass = "";
      const body = items.map(item => {
        const label = item.improvementClassLabel ?? item.improvementClass ?? "-";
        const group = label !== previousClass ? '<tr><th colspan="11">' + esc(label) + '</th></tr>' : "";
        previousClass = label;
        const modules = (item.implementationModules ?? []).join(" · ") || "-";
        const affected = esc(item.affectedInstances.join(", ") || "-") + '<div class="path">' + esc(item.affectedCoders.join(", ") || "-") + '</div>';
        return group + '<tr class="priority"><td class="wrap">' + esc(label) + '</td><td class="num">' + item.classRank + '</td><td class="num">' + item.rank + '</td><td class="wrap">' + esc(item.title) + '</td><td class="wrap">' + esc(item.targetArea) + '</td><td class="path">' + esc(modules) + '</td><td class="wrap">' + affected + '</td><td>' + esc(item.confidence) + '</td><td class="evidence">' + esc(item.evidence.join(" · ")) + '</td><td class="wrap">' + esc(item.expectedImpact) + '</td><td class="wrap">' + esc(item.nextAction) + '</td></tr>';
      }).join("");
      document.getElementById("actionPriorities").innerHTML = head + (body || '<tr><td colspan="11">No action priorities.</td></tr>');
    }

    function renderPriorities() {
      const head = '<tr><th>Score</th><th>Instance</th><th>Category</th><th>LightCC</th><th>Competitors</th><th>Evidence</th></tr>';
      const body = report.priorities.map(item => '<tr class="priority"><td class="num">' + item.priorityScore + '</td><td>' + item.instanceId + '</td><td>' + item.category + '</td><td>' + (item.lightccOutcome ? badge(item.lightccOutcome) : "-") + '</td><td>' + (item.solvedCompetitors.join(", ") || "-") + '</td><td>' + item.evidence + '</td></tr>').join("");
      document.getElementById("priorities").innerHTML = head + body;
    }

    function renderProfiles() {
      const internal = lightccInternalAggregate();
      const head = '<tr><th>Coder</th><th>Resolved</th><th>Requests</th><th>Cost</th><th>Cost/Resolved</th><th>Provider Errors</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache R/W</th><th>Wrapper Time</th><th>Nonzero Exits</th><th>Tokens/Resolved</th><th>Internal Bottleneck</th><th>Internal Provider</th><th>Internal Transcript</th><th>Internal Max Context</th><th>Internal Bash / Nonzero</th></tr>';
      const body = report.coderSummary.map(item => {
        const internalCells = item.coderId === "lightcc"
          ? '<td>' + internal.bottleneckSummary + '</td><td class="num">' + ms(internal.providerMs) + '</td><td class="num">' + ms(internal.transcriptMs) + '</td><td class="num">' + num(internal.maxContextTokens) + '</td><td class="num">' + num(internal.bashCount) + ' / ' + num(internal.nonzeroExitCount) + '</td>'
          : '<td>-</td><td class="num">-</td><td class="num">-</td><td class="num">-</td><td class="num">-</td>';
        return '<tr><td>' + item.coderId + '</td><td class="num">' + item.resolved + '/' + item.rows + '</td><td class="num">' + item.requestCount + '</td><td class="num">' + usd(item.estimatedUsd) + '</td><td class="num">' + usd(item.costPerResolved) + '</td><td class="num">' + item.providerErrors + '</td><td class="num">' + num(item.totalTokens) + '</td><td class="num">' + num(item.inputTokens) + '</td><td class="num">' + num(item.outputTokens) + '</td><td class="num">' + cacheRatio(item.cacheReadInputTokens, item.cacheWriteInputTokens) + '</td><td class="num">' + ms(item.wrapperDurationMs) + '</td><td class="num">' + item.wrapperNonzeroExitCount + '</td><td class="num">' + num(item.tokensPerResolved) + '</td>' + internalCells + '</tr>';
      }).join("");
      document.getElementById("profiles").innerHTML = head + body;
    }

    function lightccInternalAggregate() {
      const rows = report.rows
        .filter(row => row.coderId === "lightcc" && row.lightccInternal)
      const bottlenecks = rows.reduce((acc, row) => {
        const key = row.lightccInternal.topBottleneck ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const maxContextTokens = rows.reduce((best, row) => Math.max(best, row.lightccInternal.maxEstimatedTokens ?? 0), 0);
      const transcriptMs = rows.reduce((sum, row) => sum + (row.lightccInternal.transcriptWriteDurationMs ?? 0), 0);
      const providerMs = rows.reduce((sum, row) => sum + (row.lightccInternal.providerTotalDurationMs ?? 0), 0);
      const bashCount = rows.reduce((sum, row) => sum + (row.lightccInternal.bashCount ?? 0), 0);
      const nonzeroExitCount = rows.reduce((sum, row) => sum + (row.lightccInternal.runtimeNonzeroExitCount ?? 0), 0);
      return {
        bottleneckSummary: Object.entries(bottlenecks).map(([key, value]) => key + "=" + value).join(" · ") || "-",
        providerMs: rows.length ? providerMs : null,
        transcriptMs: rows.length ? transcriptMs : null,
        maxContextTokens: rows.length ? maxContextTokens : null,
        bashCount: rows.length ? bashCount : null,
        nonzeroExitCount: rows.length ? nonzeroExitCount : null
      };
    }

    function metric(label, value, caption) {
      return '<div class="metric"><span>' + label + '</span><strong>' + value + '</strong><span>' + caption + '</span></div>';
    }

    function outcomeSort(outcome) {
      if (outcome === "unresolved") return 0;
      if (outcome === "empty_patch") return 1;
      if (outcome === "error") return 2;
      if (outcome === "incomplete") return 3;
      return 4;
    }

    function renderCoverage() {
      const c = report.coverage;
      const rows = [
        ["Expected rows", c.expectedRows],
        ["Actual rows", c.actualRows],
        ["Official JSONs", c.officialJsons],
        ["Summary JSONs", c.summaryJsons],
        ["Provider profiles", c.providerProfiles],
        ["Wrapper profiles", c.wrapperProfiles],
        ["LightCC internal profiles", c.lightccInternalProfiles],
        ["Missing records", c.missing.length]
      ];
      document.getElementById("coverage").innerHTML = '<tr><th>Metric</th><th>Value</th></tr>' + rows.map(row => '<tr><td>' + row[0] + '</td><td class="num">' + row[1] + '</td></tr>').join("");
    }

    document.getElementById("matrixFilter").addEventListener("change", renderMatrix);
    document.getElementById("matrixSearch").addEventListener("input", renderMatrix);
    document.getElementById("failureCoder").addEventListener("change", renderFailures);
    document.getElementById("failureCategory").addEventListener("change", renderFailures);
    document.getElementById("failureSearch").addEventListener("input", renderFailures);
    renderSummary();
    renderProfileInstanceOptions();
    renderFailureControls();
    renderMatrix();
    renderInstanceProfiles(report.instanceMatrix[0]?.instanceId);
    renderFailures();
    renderManualFailures();
    renderActionPriorities();
    renderPriorities();
    renderProfiles();
    renderCoverage();
  </script>
</body>
</html>
`
}

async function parseArgs(argv: string[]): Promise<SweBenchAnalysisOptions> {
  const options: SweBenchAnalysisOptions = {
    runId: DEFAULT_RUN_ID,
    runRoot: resolve(DEFAULT_RUN_ROOT),
    outputDir: resolve(DEFAULT_RUN_ROOT, "final-report"),
    officialJsons: {},
    manualAttributionsPath: null,
  }
  let outputDirProvided = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--run-id") options.runId = requireValue(argv, ++index, arg)
    else if (arg === "--run-root") options.runRoot = resolve(requireValue(argv, ++index, arg))
    else if (arg === "--output-dir") {
      options.outputDir = resolve(requireValue(argv, ++index, arg))
      outputDirProvided = true
    } else if (arg === "--official-json") {
      const [coder, path] = splitAssignment(requireValue(argv, ++index, arg), arg)
      options.officialJsons[coder] = resolve(path)
    } else if (arg === "--manual-attributions") {
      options.manualAttributionsPath = resolve(requireValue(argv, ++index, arg))
    } else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!outputDirProvided) options.outputDir = join(options.runRoot, "final-report")
  if (options.manualAttributionsPath === null) {
    const defaultManualPath = join(options.outputDir, "swebench-manual-failure-attributions.json")
    options.manualAttributionsPath = existsSync(defaultManualPath) ? defaultManualPath : null
  }
  if (Object.keys(options.officialJsons).length === 0) options.officialJsons = await discoverOfficialJsons(options.runId)
  if (Object.keys(options.officialJsons).length === 0) throw new Error(`No official SWE result JSONs found for run id ${options.runId}`)
  return options
}

async function discoverOfficialJsons(runId: string): Promise<Record<string, string>> {
  const files = await readdir(process.cwd())
  const result: Record<string, string> = {}
  for (const file of files) {
    const marker = `.${runId}-eval-`
    if (!file.includes(marker) || !file.endsWith(".json")) continue
    const coderId = file.slice(file.indexOf(marker) + marker.length, -".json".length)
    if (coderId) result[coderId] = resolve(file)
  }
  return result
}

function emptyWrapperProfile(): WrapperProfileSummary {
  return {
    exists: false,
    schemaVersion: null,
    wrapperId: null,
    runtime: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    warningCount: 0,
    artifactCount: 0,
    hasPrompt: false,
    hasTranscript: false,
    hasPatch: false,
    hasSummary: false,
    missingEnvNames: [],
  }
}

function emptyProviderProfile(): ProviderProfileSummary {
  return {
    exists: false,
    model: null,
    requestCount: null,
    successCount: null,
    errorCount: null,
    retryableErrorCount: null,
    totalLatencyMs: null,
    averageLatencyMs: null,
    averageFirstTokenMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
    estimatedUsd: null,
    costSource: null,
  }
}

function emptyTranscriptSignals(): TranscriptSignalSummary {
  return {
    exists: false,
    bytes: null,
    truncated: false,
    lineCount: null,
    jsonEventCount: null,
    turnEndedReasons: {},
    stepEndedReasons: {},
    providerFailureCount: 0,
    compactFailureCount: 0,
    toolErrorCount: 0,
    lastTurnReason: null,
    textSignals: [],
  }
}

function pendingFailureAttribution(outcome: OfficialOutcome): FailureAttribution {
  return {
    category: outcome === "resolved" ? "resolved" : "patch_failed_hidden_tests",
    confidence: outcome === "resolved" ? "none" : "low",
    failureReason: outcome === "resolved" ? "官方 evaluator 已 resolved，本行无失败归因。" : "归因尚未计算。",
    evidence: [`outcome=${outcome}`],
    nextAction: outcome === "resolved" ? "无需失败处理。" : "等待归因器读取同题横比与 artifact signals。",
  }
}

function inferOutcome(result: JsonRecord, metrics: JsonRecord | undefined): OfficialOutcome {
  if (booleanValue(metrics, "emptyPatch") || booleanValue(result, "emptyPatch")) return "empty_patch"
  const status = stringValue(metrics, "status") ?? stringValue(result, "status")
  if (status === "failed") return "error"
  if (status === "completed") return "unresolved"
  return "incomplete"
}

function bestCompetitor(outcomes: Record<string, InstanceCoderCell>): InstanceMatrixEntry["bestResolvedCompetitor"] {
  const candidates = Object.entries(outcomes)
    .filter(([coderId, cell]) => coderId !== "lightcc" && cell.outcome === "resolved")
    .sort((left, right) => (left[1].totalTokens ?? Number.MAX_SAFE_INTEGER) - (right[1].totalTokens ?? Number.MAX_SAFE_INTEGER))
  const best = candidates[0]
  if (!best) return null
  return {
    coderId: best[0],
    totalTokens: best[1].totalTokens,
    requestCount: best[1].requestCount,
    wrapperDurationMs: best[1].wrapperDurationMs,
  }
}

function instanceNote(lightcc: InstanceCoderCell | undefined, solvedCoders: string[], best: InstanceMatrixEntry["bestResolvedCompetitor"]): string {
  const solvedCompetitors = solvedCoders.filter((coderId) => coderId !== "lightcc")
  if (!lightcc) return "Missing LightCC row"
  if (solvedCoders.length === 0) return "All failed"
  if (lightcc.outcome !== "resolved" && solvedCompetitors.length > 0) return "LightCC gap"
  if (lightcc.outcome === "resolved" && solvedCompetitors.length === 0) return "LightCC strength"
  if (lightcc.outcome === "resolved" && best?.totalTokens && lightcc.totalTokens && lightcc.totalTokens > best.totalTokens * 1.5) return "LightCC solved but expensive"
  if (solvedCoders.length === 4) return "All solved"
  return "Mixed"
}

function sortedCoders(coders: string[]): string[] {
  return coders.sort((left, right) => coderRank(left) - coderRank(right) || left.localeCompare(right))
}

function coderRank(coderId: string): number {
  const index = CODER_ORDER.indexOf(coderId)
  return index === -1 ? CODER_ORDER.length : index
}

function reportDirFromSummaryPath(summaryPath: string): string {
  return summaryPath.slice(0, -"summary.json".length)
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

function countOutcome(rows: AnalysisRow[], outcome: OfficialOutcome): number {
  return rows.filter((row) => row.officialOutcome === outcome).length
}

function countFailureCategories(rows: AnalysisRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const category = row.failureAttribution.category
    if (category === "resolved") continue
    counts[category] = (counts[category] ?? 0) + 1
  }
  return counts
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function recordValue(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return asRecord(record?.[key])
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => Boolean(item)) : []
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
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

function booleanValue(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === "boolean" ? value : undefined
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function nullableSum(values: Array<number | null>): number | null {
  const present = values.filter(isNumber)
  return present.length > 0 ? sum(present) : null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[midpoint]
  return round((sorted[midpoint - 1] + sorted[midpoint]) / 2, 3)
}

function roundNullable(value: number | null): number | null {
  return value === null ? null : round(value, 6)
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits))
}

function formatDuration(value: number | null): string {
  if (value === null) return "-"
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : String(value)
}

function formatUsd(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(6)}`
}

function formatCacheRatio(read: number | null, write: number | null): string {
  const readValue = read ?? 0
  const writeValue = write ?? 0
  const total = readValue + writeValue
  if (total === 0) return "-"
  return `${readValue} / ${writeValue} (${round((readValue / total) * 100, 1)}% read)`
}

function formatTokenCount(value: number | null): string {
  if (value === null) return "-"
  if (value >= 1_000_000) return `${value} (${round(value / 1_000_000, 2)}M)`
  return String(value)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim()
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
    "Usage: bun evals/report/swebench-analysis.ts [--run-root <dir>] [--output-dir <dir>] [--manual-attributions <json>]",
    "       --official-json lightcc=lightcc__deepseek-v4-flash.swe20-fourway-20260602-eval-lightcc.json",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
