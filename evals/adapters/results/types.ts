export const EVAL_RESULT_SCHEMA_VERSION = 1

export type EvalBenchmark = "swebench" | "terminal-bench" | "adapter-conformance"

export type EvalResultStatus = "prepared" | "passed" | "failed" | "errored" | "skipped"

export type EvalTokenUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export type EvalCost = {
  amount: number
  currency: "USD"
  estimated: boolean
}

export type EvalFailure = {
  type: string
  message: string
  stage?: "prepare" | "agent" | "verifier" | "report"
}

export type EvalArtifacts = {
  rootDir?: string
  transcriptPath?: string
  patchPath?: string
  summaryPath?: string
  rawResultPath?: string
}

export type EvalReproducibility = {
  adapterId: string
  adapterStatus: "ready" | "draft"
  installKind: string
  installPackage?: string
  model?: string
  baseUrlHost?: string
  attempts: number
  maxSteps?: number
  permissionMode?: string
  osSandbox?: string
}

export type UnifiedEvalResult = {
  schemaVersion: typeof EVAL_RESULT_SCHEMA_VERSION
  runId: string
  createdAt: string
  coder: {
    id: string
    displayName: string
  }
  benchmark: EvalBenchmark
  task: {
    id: string
    attempt: number
  }
  status: EvalResultStatus
  passed: boolean | null
  durationMs?: number
  artifacts: EvalArtifacts
  usage?: EvalTokenUsage
  cost?: EvalCost
  failure?: EvalFailure
  reproducibility: EvalReproducibility
}
