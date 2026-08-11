export const SWE_BENCH_PACKAGE_VERSION = "swebench==4.1.0"

export const SWE_BENCH_PROFILE_NAMES = ["lite", "verified"] as const

export type SweBenchProfile = (typeof SWE_BENCH_PROFILE_NAMES)[number]

export type SweBenchDatasetDefaults = {
  packageVersion: string
  datasetName: string
  split: string
  datasetRevision: string
}

export const SWE_BENCH_PROFILES = {
  lite: {
    packageVersion: SWE_BENCH_PACKAGE_VERSION,
    datasetName: "SWE-bench/SWE-bench_Lite",
    split: "test",
    datasetRevision: "69611d31007e1c6731db8bd5b5c3f2d33f5bab6e",
  },
  verified: {
    packageVersion: SWE_BENCH_PACKAGE_VERSION,
    datasetName: "SWE-bench/SWE-bench_Verified",
    split: "test",
    datasetRevision: "91aa3ed51b709be6457e12d00300a6a596d4c6a3",
  },
} as const satisfies Record<SweBenchProfile, SweBenchDatasetDefaults>

export const SWE_BENCH_DEFAULT_PROFILE = "verified" satisfies SweBenchProfile
export const SWE_BENCH_DEFAULTS = SWE_BENCH_PROFILES[SWE_BENCH_DEFAULT_PROFILE]
export const SWE_BENCH_LITE_DEFAULTS = SWE_BENCH_PROFILES.lite
export const SWE_BENCH_VERIFIED_DEFAULTS = SWE_BENCH_PROFILES.verified

export function isSweBenchProfile(value: string): value is SweBenchProfile {
  return (SWE_BENCH_PROFILE_NAMES as readonly string[]).includes(value)
}

export type SweBenchInstance = {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
}

export type SweBenchPrediction = {
  instance_id: string
  model_name_or_path: string
  model_patch: string
}

export type SweBenchRunMode = "dry-run" | "run-agent" | "evaluate" | "gold"

export type SweBenchTaskResult = {
  instanceId: string
  status: "prepared" | "completed" | "failed" | "skipped"
  artifactDir: string
  workspace?: string
  promptPath?: string
  patchPath?: string
  transcriptPath?: string
  profileReportPath?: string
  wrapperProfilePath?: string
  profile?: EvalAgentProfileSummary
  agentSummaryPath?: string
  patchSha256?: string
  patchBytes?: number
  patchLines?: number
  changedFiles?: string[]
  emptyPatch?: boolean
  patchBaseHead?: string
  committedChangesCollected?: boolean
  headDiffMissedChanges?: boolean
  usage?: SweBenchUsageTotals
  cost?: SweBenchCostEstimate
  prediction?: SweBenchPrediction
  error?: string
}

export type SweBenchUsageTotals = {
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  promptCacheHitTokens: number
  promptCacheMissTokens: number
  reasoningTokens: number
}

export type SweBenchCostEstimate = {
  currency: "USD"
  model: string
  inputCacheHitUsd: number
  inputCacheMissUsd: number
  outputUsd: number
  totalUsd: number
  pricing: {
    inputCacheHitPer1M: number
    inputCacheMissPer1M: number
    outputPer1M: number
    source: string
  }
}

export type EvalAgentProfileSummary = {
  reportPath: string
  sourceTranscript: string
  observedDurationMs: number
  profileSpanCount: number
  topBottleneck: string | null
  provider: {
    callCount: number
    totalDurationMs: number
    firstTokenMsP50: number | null
    streamMsP50: number | null
    inputTokens: number | null
    outputTokens: number | null
    cacheReadInputTokens: number | null
  }
  context: {
    assembleCount: number
    totalDurationMs: number
    maxEstimatedTokens: number | null
  }
  runtime: {
    bashCount: number
    durationMsP50: number | null
    durationMsMax: number | null
    nonzeroExitCount: number
  }
  transcriptWrite: {
    writeCount: number
    totalDurationMs: number | null
    profilerSpanWriteCount: number
    profilerSpanWriteDurationMs: number | null
  }
  topSlowSpans: Array<{
    name: string
    category: string
    status: string
    durationMs: number
  }>
  warnings: string[]
}

export function safeInstanceFromRecord(record: Record<string, unknown>): SweBenchInstance {
  const instance = {
    instance_id: requireString(record, "instance_id"),
    repo: requireString(record, "repo"),
    base_commit: requireString(record, "base_commit"),
    problem_statement: requireString(record, "problem_statement"),
  }
  if (!/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+$/.test(instance.instance_id)) {
    throw new Error(`Invalid SWE-bench instance_id: ${instance.instance_id}`)
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(instance.repo)) {
    throw new Error(`Invalid SWE-bench repo: ${instance.repo}`)
  }
  if (!/^[0-9a-fA-F]{6,40}$/.test(instance.base_commit)) {
    throw new Error(`Invalid SWE-bench base_commit for ${instance.instance_id}`)
  }
  return instance
}

function requireString(record: Record<string, unknown>, key: keyof SweBenchInstance): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`SWE-bench instance requires non-empty ${key}`)
  }
  return value
}
