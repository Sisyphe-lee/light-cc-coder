export const SWE_BENCH_LITE_DEFAULTS = {
  packageVersion: "swebench==4.1.0",
  datasetName: "SWE-bench/SWE-bench_Lite",
  split: "test",
  datasetRevision: "69611d31007e1c6731db8bd5b5c3f2d33f5bab6e",
} as const

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
  agentSummaryPath?: string
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
