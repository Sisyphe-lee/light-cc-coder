import type { CoderAdapterStatus, CoderEvalTarget } from "../coders/types"

export const EVAL_MATRIX_PLAN_SCHEMA_VERSION = 1

export type EvalMatrixPlanEntry = {
  id: string
  coderId: string
  coderStatus: CoderAdapterStatus
  benchmark: CoderEvalTarget
  taskId: string
  model: string
  attempt: number
  artifactDir: string
  requiredEnv: string[]
}

export type EvalMatrixPlan = {
  schemaVersion: typeof EVAL_MATRIX_PLAN_SCHEMA_VERSION
  mode: "dry-run-plan"
  runId: string
  createdAt: string
  totals: {
    coders: number
    tasks: number
    models: number
    attempts: number
    entries: number
    draftEntries: number
  }
  entries: EvalMatrixPlanEntry[]
  warnings: string[]
}
