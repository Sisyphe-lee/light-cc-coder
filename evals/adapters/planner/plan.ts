import { join } from "node:path"
import { buildCoderCommand, loadCoderAdapter } from "../coders/loader"
import type { CoderAdapter, CoderEvalTarget } from "../coders/types"
import { EVAL_MATRIX_PLAN_SCHEMA_VERSION, type EvalMatrixPlan, type EvalMatrixPlanEntry } from "./types"

export type EvalMatrixRequest = {
  runId: string
  benchmark: CoderEvalTarget
  coders: string[]
  tasks: string[]
  models: string[]
  attempts: number
  artifactRoot?: string
  allowDraft?: boolean
  maxEntries?: number
  apiKeyEnv?: string
}

export async function createEvalMatrixPlan(request: EvalMatrixRequest): Promise<EvalMatrixPlan> {
  validateRequest(request)
  const adapters = await Promise.all(request.coders.map((coder) => loadCoderAdapter(coder)))
  const warnings: string[] = []
  const entries: EvalMatrixPlanEntry[] = []
  const artifactRoot = request.artifactRoot ?? join(".light-cc", "evals", request.runId, "matrix")

  for (const adapter of adapters) {
    validateAdapterForPlan(adapter, request, warnings)
    for (const taskId of request.tasks) {
      for (const model of request.models) {
        for (let attempt = 1; attempt <= request.attempts; attempt++) {
          const artifactDir = join(artifactRoot, adapter.id, request.benchmark, sanitizePathSegment(taskId), model, `attempt-${attempt}`)
          const rendered = buildCoderCommand(adapter, {
            instruction: `Benchmark task ${taskId}`,
            workspace: "/workspace",
            artifactDir,
            transcriptPath: join(artifactDir, "transcript.jsonl"),
            patchPath: join(artifactDir, "patch.diff"),
            resultPath: join(artifactDir, "result.json"),
            model,
            baseUrl: "",
            apiKeyEnv: request.apiKeyEnv ?? "OPENAI_API_KEY",
            maxSteps: "120",
            permissionMode: "danger-full-access",
            osSandbox: "off",
            sandboxSettings: "",
            executable: "coder",
          })
          entries.push({
            id: `${adapter.id}:${request.benchmark}:${taskId}:${model}:${attempt}`,
            coderId: adapter.id,
            coderStatus: adapter.status,
            benchmark: request.benchmark,
            taskId,
            model,
            attempt,
            artifactDir,
            requiredEnv: rendered.requiredEnv,
          })
        }
      }
    }
  }

  const maxEntries = request.maxEntries ?? 50
  if (entries.length > maxEntries) {
    throw new Error(`Refusing to create ${entries.length} planned entries without increasing maxEntries`)
  }

  return {
    schemaVersion: EVAL_MATRIX_PLAN_SCHEMA_VERSION,
    mode: "dry-run-plan",
    runId: request.runId,
    createdAt: new Date().toISOString(),
    totals: {
      coders: adapters.length,
      tasks: request.tasks.length,
      models: request.models.length,
      attempts: request.attempts,
      entries: entries.length,
      draftEntries: entries.filter((entry) => entry.coderStatus === "draft").length,
    },
    entries,
    warnings,
  }
}

function validateRequest(request: EvalMatrixRequest): void {
  if (!request.runId) throw new Error("runId is required")
  if (request.coders.length === 0) throw new Error("At least one coder is required")
  if (request.tasks.length === 0) throw new Error("At least one task is required")
  if (request.models.length === 0) throw new Error("At least one model is required")
  if (!Number.isInteger(request.attempts) || request.attempts <= 0) throw new Error("attempts must be a positive integer")
}

function validateAdapterForPlan(adapter: CoderAdapter, request: EvalMatrixRequest, warnings: string[]): void {
  if (!adapter.targets.includes(request.benchmark)) {
    throw new Error(`Adapter ${adapter.id} does not support ${request.benchmark}`)
  }
  if (adapter.status === "draft") {
    const message = `Adapter ${adapter.id} is draft`
    if (!request.allowDraft) throw new Error(`${message}; pass allowDraft to include it in a dry-run plan`)
    warnings.push(message)
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_")
}
