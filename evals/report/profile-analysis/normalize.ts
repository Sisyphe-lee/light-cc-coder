import { existsSync } from "node:fs"
import type { LoadedProfileAnalysis, LoadedRowSource } from "./load"
import {
  EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
  type ArtifactRefSummary,
  type ArtifactSummary,
  type CommonDerivedMetrics,
  type CommonProfileSummary,
  type EvalProfileRow,
  type InternalProfileSummary,
  type LightccInternalToolSummary,
  type OutcomeSummary,
  type ProviderProfileSummary,
  type WrapperProfileSummary,
} from "./types"
import {
  arrayRecords,
  arrayStrings,
  asRecord,
  booleanValue,
  firstString,
  nullableBoolean,
  nullableNumber,
  nullableString,
  numberValue,
  percentile,
  ratio,
  readJsonFile,
  recordValue,
  round,
  stringValue,
  sumNullable,
  uniqueSorted,
  type JsonRecord,
} from "./utils"

export async function normalizeEvalProfileRows(loaded: LoadedProfileAnalysis): Promise<EvalProfileRow[]> {
  const rows: EvalProfileRow[] = []
  for (const source of loaded.rowSources) rows.push(await normalizeRow(source))
  return rows.sort((left, right) => (
    left.benchmark.localeCompare(right.benchmark) ||
    left.itemId.localeCompare(right.itemId) ||
    left.coderId.localeCompare(right.coderId) ||
    left.runId.localeCompare(right.runId)
  ))
}

async function normalizeRow(source: LoadedRowSource): Promise<EvalProfileRow> {
  const warnings = [...source.warnings]
  const metrics = await readOptionalRecord(source.paths.metricsJson, warnings, "metrics")
  const wrapperRecord = await readOptionalRecord(source.paths.wrapperProfile, warnings, "wrapper profile")
  const providerRecord = await readOptionalRecord(source.paths.providerProfile, warnings, "provider profile")
  const internalRecord = source.coderId === "lightcc" ? await readOptionalRecord(source.paths.internalProfile, warnings, "internal profile") : null

  const wrapper = normalizeWrapperProfile(source.paths.wrapperProfile, wrapperRecord, warnings)
  const provider = normalizeProviderProfile(source.paths.providerProfile, providerRecord, {
    estimatedUsd: source.outcome.costUsd ?? null,
    costSource: source.outcome.costSource ?? null,
  }, warnings)
  const artifacts = normalizeArtifactSummary(wrapperRecord)
  const paths = {
    summaryJson: source.paths.summaryJson,
    metricsJson: source.paths.metricsJson,
    providerProfile: source.paths.providerProfile,
    wrapperProfile: source.paths.wrapperProfile,
    internalProfile: source.paths.internalProfile,
    patch: firstString(source.paths.patch, firstArtifactPath(artifacts, "patch")),
    transcript: firstString(source.paths.transcript, firstArtifactPath(artifacts, "transcript")),
  }

  return {
    schemaVersion: EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION,
    benchmark: source.benchmark,
    runId: source.runId,
    itemId: source.itemId,
    coderId: source.coderId,
    coderDisplayName: source.coderDisplayName,
    outcome: normalizeOutcome(source, metrics, artifacts),
    commonProfile: {
      wrapper,
      provider,
      artifacts,
      derived: normalizeDerivedMetrics(wrapper, provider),
    },
    internalProfile: normalizeInternalProfile(source.paths.internalProfile, internalRecord, warnings),
    paths,
    warnings: uniqueSorted(warnings),
  }
}

async function readOptionalRecord(path: string | null, warnings: string[], label: string): Promise<JsonRecord | null> {
  if (!path) return null
  const read = await readJsonFile(path)
  if (!read.ok) {
    warnings.push(`${label} read failed: ${path}: ${read.error}`)
    return null
  }
  const record = asRecord(read.value)
  if (!record) {
    warnings.push(`${label} is not an object: ${path}`)
    return null
  }
  return record
}

function normalizeOutcome(source: LoadedRowSource, metrics: JsonRecord | null, artifacts: ArtifactSummary): OutcomeSummary {
  const patchBytes = source.outcome.patchBytes ?? numberValue(metrics ?? undefined, "patchBytes") ?? artifacts.patchBytes
  const emptyPatch = source.outcome.emptyPatch ?? booleanValue(metrics ?? undefined, "emptyPatch") ?? (patchBytes === null ? null : patchBytes === 0)
  return {
    officialOutcome: source.outcome.officialOutcome ?? null,
    tbenchReward: source.outcome.tbenchReward ?? numberValue(metrics ?? undefined, "reward") ?? null,
    completed: source.outcome.completed ?? statusCompleted(source.outcome.status ?? stringValue(metrics ?? undefined, "status")),
    submitted: source.outcome.submitted ?? null,
    status: source.outcome.status ?? stringValue(metrics ?? undefined, "status") ?? null,
    patchBytes,
    patchLines: source.outcome.patchLines ?? numberValue(metrics ?? undefined, "patchLines") ?? null,
    patchSha256: source.outcome.patchSha256 ?? stringValue(metrics ?? undefined, "patchSha256") ?? null,
    changedFiles: source.outcome.changedFiles?.length ? source.outcome.changedFiles : arrayStrings(metrics?.changedFiles),
    emptyPatch,
  }
}

function normalizeWrapperProfile(path: string | null, profile: JsonRecord | null, warnings: string[]): WrapperProfileSummary {
  if (!path) return emptyWrapperProfile(false)
  if (!existsSync(path) || !profile) return emptyWrapperProfile(false)
  const wrapper = recordValue(profile, "wrapper")
  const command = recordValue(profile, "command")
  const process = recordValue(profile, "process")
  const environment = recordValue(profile, "environment")
  const artifacts = arrayRecords(profile.artifacts)
  const schemaVersion = nullableNumber(profile, "schemaVersion")
  const valid = schemaVersion === 1 && Boolean(wrapper) && Boolean(process)
  if (!valid) warnings.push(`invalid wrapper profile: ${path}`)
  return {
    exists: true,
    valid,
    schemaVersion,
    wrapperId: nullableString(wrapper, "id"),
    runtime: nullableString(wrapper, "runtime"),
    executablePath: nullableString(command, "executablePath"),
    cwd: nullableString(command, "cwd"),
    argCount: nullableNumber(command, "argCount"),
    argsSha256: nullableString(command, "argsSha256"),
    durationMs: nullableNumber(process, "durationMs"),
    exitCode: nullableNumber(process, "exitCode"),
    signal: nullableString(process, "signal"),
    warningCount: arrayStrings(profile.warnings).length,
    artifactCount: artifacts.length,
    hasPrompt: artifacts.some((artifact) => stringValue(artifact, "kind") === "prompt"),
    hasTranscript: artifacts.some((artifact) => stringValue(artifact, "kind") === "transcript"),
    hasPatch: artifacts.some((artifact) => stringValue(artifact, "kind") === "patch"),
    hasSummary: artifacts.some((artifact) => stringValue(artifact, "kind") === "summary"),
    hasStdout: artifacts.some((artifact) => stringValue(artifact, "kind") === "stdout"),
    hasStderr: artifacts.some((artifact) => stringValue(artifact, "kind") === "stderr"),
    missingEnvNames: arrayStrings(environment?.missingNames),
  }
}

function normalizeProviderProfile(
  path: string | null,
  profile: JsonRecord | null,
  fallbackCost: { estimatedUsd: number | null; costSource: string | null },
  warnings: string[],
): ProviderProfileSummary {
  if (!path) return emptyProviderProfile(false, fallbackCost)
  if (!existsSync(path) || !profile) return emptyProviderProfile(false, fallbackCost)
  const totals = recordValue(profile, "totals")
  const usage = recordValue(totals, "usage")
  const cost = recordValue(totals, "cost")
  const proxy = recordValue(profile, "proxy")
  const requests = arrayRecords(profile.requests)
  const schemaVersion = numberValue(profile, "schemaVersion")
  const privacy = recordValue(profile, "privacy")
  const kind = stringValue(profile, "kind")
  const privacyValid =
    kind !== "metadata-only-provider-proxy" ||
    (stringValue(privacy, "prompt") === "not_recorded" &&
      stringValue(privacy, "response") === "not_recorded" &&
      stringValue(privacy, "apiKey") === "not_recorded")
  const valid = schemaVersion === 1 && Boolean(totals) && privacyValid
  if (!valid) warnings.push(`invalid provider profile: ${path}`)
  const latencyValues = requests.map((request) => numberValue(request, "latencyMs"))
  const firstTokenValues = requests.map((request) => numberValue(request, "firstTokenMs"))
  const estimatedUsd = numberValue(cost, "estimatedUsd") ?? fallbackCost.estimatedUsd
  const costSource = estimatedUsd === fallbackCost.estimatedUsd && fallbackCost.costSource
    ? fallbackCost.costSource
    : stringValue(cost, "source") ?? fallbackCost.costSource
  return {
    exists: true,
    valid,
    model: nullableString(proxy, "model") ?? firstRequestModel(requests),
    requestCount: nullableNumber(totals, "requestCount"),
    successCount: nullableNumber(totals, "successCount"),
    errorCount: nullableNumber(totals, "errorCount"),
    retryableErrorCount: nullableNumber(totals, "retryableErrorCount"),
    totalLatencyMs: nullableNumber(totals, "totalLatencyMs"),
    averageLatencyMs: nullableNumber(totals, "averageLatencyMs"),
    averageFirstTokenMs: nullableNumber(totals, "averageFirstTokenMs"),
    latencyMsP50: percentile(latencyValues, 0.5),
    latencyMsP90: percentile(latencyValues, 0.9),
    firstTokenMsP50: percentile(firstTokenValues, 0.5),
    firstTokenMsP90: percentile(firstTokenValues, 0.9),
    inputTokens: nullableNumber(usage, "inputTokens"),
    outputTokens: nullableNumber(usage, "outputTokens"),
    totalTokens: nullableNumber(usage, "totalTokens"),
    cacheReadInputTokens: nullableNumber(usage, "cacheReadInputTokens"),
    cacheWriteInputTokens: nullableNumber(usage, "cacheWriteInputTokens"),
    reasoningTokens: nullableNumber(usage, "reasoningTokens"),
    estimatedUsd,
    costSource,
  }
}

function normalizeArtifactSummary(wrapperProfile: JsonRecord | null): ArtifactSummary {
  const refs: ArtifactRefSummary[] = arrayRecords(wrapperProfile?.artifacts).flatMap((artifact) => {
    const kind = stringValue(artifact, "kind")
    const path = stringValue(artifact, "path")
    if (!kind || !path) return []
    return [{
      kind,
      path,
      bytes: nullableNumber(artifact, "bytes"),
      sha256: nullableString(artifact, "sha256"),
    }]
  })
  const bytesByKind = (kind: string): number | null => sumNullable(refs.filter((ref) => ref.kind === kind).map((ref) => ref.bytes))
  return {
    refs,
    totalBytes: sumNullable(refs.map((ref) => ref.bytes)),
    promptBytes: bytesByKind("prompt"),
    transcriptBytes: bytesByKind("transcript"),
    patchBytes: bytesByKind("patch"),
    stdoutBytes: bytesByKind("stdout"),
    stderrBytes: bytesByKind("stderr"),
  }
}

function normalizeDerivedMetrics(wrapper: WrapperProfileSummary, provider: ProviderProfileSummary): CommonDerivedMetrics {
  const cacheInput = sumNullable([provider.cacheReadInputTokens, provider.cacheWriteInputTokens])
  const overheadMs =
    typeof wrapper.durationMs === "number" && typeof provider.totalLatencyMs === "number"
      ? round(wrapper.durationMs - provider.totalLatencyMs)
      : null
  return {
    cacheHitRatio: ratio(provider.cacheReadInputTokens, cacheInput),
    outputTokenRatio: ratio(provider.outputTokens, provider.totalTokens),
    averageInputTokensPerRequest: ratio(provider.inputTokens, provider.requestCount),
    averageOutputTokensPerRequest: ratio(provider.outputTokens, provider.requestCount),
    wrapperVsProviderOverheadMs: overheadMs,
    wrapperVsProviderOverheadRatio: ratio(overheadMs, wrapper.durationMs),
    providerErrorRate: ratio(provider.errorCount, provider.requestCount),
  }
}

function normalizeInternalProfile(path: string | null, profile: JsonRecord | null, warnings: string[]): InternalProfileSummary | null {
  if (!path) return null
  if (!existsSync(path) || !profile) return null
  const summary = recordValue(profile, "summary")
  const provider = recordValue(profile, "provider")
  const context = recordValue(profile, "context")
  const runtime = recordValue(profile, "runtime")
  const approval = recordValue(profile, "approval")
  const mcp = recordValue(profile, "mcp")
  const compact = recordValue(profile, "compact")
  const transcriptWrite = recordValue(profile, "transcriptWrite")
  const observedDurationMs = nullableNumber(summary, "observedDurationMs")
  const valid = numberValue(profile, "schemaVersion") === 1 && Boolean(summary)
  if (!valid) warnings.push(`invalid internal profile: ${path}`)
  return {
    kind: "lightcc-profile-report",
    exists: true,
    valid,
    observedDurationMs,
    profileSpanCount: nullableNumber(summary, "profileSpanCount"),
    topBottleneck: nullableString(summary, "topBottleneck"),
    categoryTotals: arrayRecords(profile.categoryTotals).flatMap((entry) => {
      const category = stringValue(entry, "category")
      const totalDurationMs = numberValue(entry, "totalDurationMs")
      const spanCount = numberValue(entry, "spanCount")
      if (!category || totalDurationMs === undefined || spanCount === undefined) return []
      return [{
        category,
        totalDurationMs,
        spanCount,
        shareOfObserved: ratio(totalDurationMs, observedDurationMs),
      }]
    }),
    provider: {
      callCount: nullableNumber(provider, "callCount"),
      totalDurationMs: nullableNumber(provider, "totalDurationMs"),
      firstTokenMsP50: nullableNumber(provider, "firstTokenMsP50"),
      firstTokenMsMax: nullableNumber(provider, "firstTokenMsMax"),
      streamMsP50: nullableNumber(provider, "streamMsP50"),
      streamMsMax: nullableNumber(provider, "streamMsMax"),
      retryCount: nullableNumber(provider, "retryCount"),
      failureClasses: arrayRecords(provider?.failureClasses).flatMap((entry) => {
        const className = stringValue(entry, "class")
        const count = numberValue(entry, "count")
        return className && count !== undefined ? [{ class: className, count }] : []
      }),
      inputTokens: nullableNumber(provider, "inputTokens"),
      outputTokens: nullableNumber(provider, "outputTokens"),
      cacheReadInputTokens: nullableNumber(provider, "cacheReadInputTokens"),
      cacheWriteInputTokens: nullableNumber(provider, "cacheWriteInputTokens"),
    },
    context: {
      assembleCount: nullableNumber(context, "assembleCount"),
      totalDurationMs: nullableNumber(context, "totalDurationMs"),
      maxEstimatedTokens: nullableNumber(context, "maxEstimatedTokens"),
    },
    tools: arrayRecords(profile.tools).map(normalizeInternalTool),
    runtime: {
      bashCount: nullableNumber(runtime, "bashCount"),
      durationMsP50: nullableNumber(runtime, "durationMsP50"),
      durationMsMax: nullableNumber(runtime, "durationMsMax"),
      nonzeroExitCount: nullableNumber(runtime, "nonzeroExitCount"),
      timeoutCount: nullableNumber(runtime, "timeoutCount"),
      truncatedCount: nullableNumber(runtime, "truncatedCount"),
    },
    approval: {
      count: nullableNumber(approval, "count"),
      allowCount: nullableNumber(approval, "allowCount"),
      denyCount: nullableNumber(approval, "denyCount"),
      waitMsTotal: nullableNumber(approval, "waitMsTotal"),
      waitMsMax: nullableNumber(approval, "waitMsMax"),
    },
    mcp: {
      serverStartupCount: nullableNumber(mcp, "serverStartupCount"),
      readyCount: nullableNumber(mcp, "readyCount"),
      failedCount: nullableNumber(mcp, "failedCount"),
      toolCallCount: nullableNumber(mcp, "toolCallCount"),
    },
    compact: {
      count: nullableNumber(compact, "count"),
      failedCount: nullableNumber(compact, "failedCount"),
      durationMs: nullableNumber(compact, "durationMs"),
      preCompactEstimatedTokens: nullableNumber(compact, "preCompactEstimatedTokens"),
      postCompactEstimatedTokens: nullableNumber(compact, "postCompactEstimatedTokens"),
    },
    transcriptWrite: {
      writeCount: nullableNumber(transcriptWrite, "writeCount"),
      totalDurationMs: nullableNumber(transcriptWrite, "totalDurationMs"),
      maxDurationMs: nullableNumber(transcriptWrite, "maxDurationMs"),
      totalBytes: nullableNumber(transcriptWrite, "totalBytes"),
      profilerSpanWriteCount: nullableNumber(transcriptWrite, "profilerSpanWriteCount"),
      profilerSpanWriteDurationMs: nullableNumber(transcriptWrite, "profilerSpanWriteDurationMs"),
    },
    topSlowSpans: arrayRecords(profile.topSlowSpans).flatMap((span) => {
      const name = stringValue(span, "name")
      const category = stringValue(span, "category")
      const status = stringValue(span, "status")
      const durationMs = numberValue(span, "durationMs")
      if (!name || !category || !status || durationMs === undefined) return []
      return [{
        spanId: nullableString(span, "spanId"),
        name,
        category,
        status,
        durationMs,
      }]
    }),
    warnings: arrayStrings(profile.warnings),
  }
}

function normalizeInternalTool(tool: JsonRecord): LightccInternalToolSummary {
  return {
    toolName: stringValue(tool, "toolName") ?? "unknown",
    count: numberValue(tool, "count") ?? 0,
    durationMsP50: nullableNumber(tool, "durationMsP50"),
    durationMsMax: nullableNumber(tool, "durationMsMax"),
    errorCount: numberValue(tool, "errorCount") ?? 0,
    deniedCount: numberValue(tool, "deniedCount") ?? 0,
    timeoutCount: numberValue(tool, "timeoutCount") ?? 0,
  }
}

function emptyWrapperProfile(exists: boolean): WrapperProfileSummary {
  return {
    exists,
    valid: false,
    schemaVersion: null,
    wrapperId: null,
    runtime: null,
    executablePath: null,
    cwd: null,
    argCount: null,
    argsSha256: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    warningCount: 0,
    artifactCount: 0,
    hasPrompt: false,
    hasTranscript: false,
    hasPatch: false,
    hasSummary: false,
    hasStdout: false,
    hasStderr: false,
    missingEnvNames: [],
  }
}

function emptyProviderProfile(
  exists: boolean,
  fallbackCost: { estimatedUsd: number | null; costSource: string | null },
): ProviderProfileSummary {
  return {
    exists,
    valid: false,
    model: null,
    requestCount: null,
    successCount: null,
    errorCount: null,
    retryableErrorCount: null,
    totalLatencyMs: null,
    averageLatencyMs: null,
    averageFirstTokenMs: null,
    latencyMsP50: null,
    latencyMsP90: null,
    firstTokenMsP50: null,
    firstTokenMsP90: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
    estimatedUsd: fallbackCost.estimatedUsd,
    costSource: fallbackCost.costSource,
  }
}

function firstArtifactPath(artifacts: ArtifactSummary, kind: string): string | null {
  return artifacts.refs.find((artifact) => artifact.kind === kind)?.path ?? null
}

function firstRequestModel(requests: JsonRecord[]): string | null {
  return requests.map((request) => stringValue(request, "model")).find((value): value is string => Boolean(value)) ?? null
}

function statusCompleted(status: string | null | undefined): boolean | null {
  if (!status) return null
  if (status === "completed" || status === "passed" || status === "resolved") return true
  if (status === "failed" || status === "error" || status === "cancelled" || status === "timeout") return false
  return null
}
