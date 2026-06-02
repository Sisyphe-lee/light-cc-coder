import { EVAL_RESULT_SCHEMA_VERSION, type UnifiedEvalResult } from "./types"

const BENCHMARKS = new Set(["swebench", "terminal-bench", "adapter-conformance"])
const STATUSES = new Set(["prepared", "passed", "failed", "errored", "skipped"])

export function validateUnifiedEvalResult(value: unknown, source = "result"): UnifiedEvalResult {
  const result = asRecord(value, source)
  if (result.schemaVersion !== EVAL_RESULT_SCHEMA_VERSION) {
    throw new Error(`${source}.schemaVersion must be ${EVAL_RESULT_SCHEMA_VERSION}`)
  }
  const runId = readString(result, "runId", source)
  const createdAt = readString(result, "createdAt", source)
  const coder = asRecord(result.coder, `${source}.coder`)
  const benchmark = readString(result, "benchmark", source)
  if (!BENCHMARKS.has(benchmark)) throw new Error(`${source}.benchmark is invalid: ${benchmark}`)
  const task = asRecord(result.task, `${source}.task`)
  const status = readString(result, "status", source)
  if (!STATUSES.has(status)) throw new Error(`${source}.status is invalid: ${status}`)
  const passed = result.passed
  if (passed !== null && typeof passed !== "boolean") throw new Error(`${source}.passed must be boolean or null`)
  const artifacts = asRecord(result.artifacts, `${source}.artifacts`)
  const reproducibility = asRecord(result.reproducibility, `${source}.reproducibility`)

  return {
    schemaVersion: EVAL_RESULT_SCHEMA_VERSION,
    runId,
    createdAt,
    coder: {
      id: readString(coder, "id", `${source}.coder`),
      displayName: readString(coder, "displayName", `${source}.coder`),
    },
    benchmark: benchmark as UnifiedEvalResult["benchmark"],
    task: {
      id: readString(task, "id", `${source}.task`),
      attempt: readNumber(task, "attempt", `${source}.task`),
    },
    status: status as UnifiedEvalResult["status"],
    passed,
    durationMs: readOptionalNumber(result, "durationMs", source),
    artifacts: {
      rootDir: readOptionalString(artifacts, "rootDir", `${source}.artifacts`),
      transcriptPath: readOptionalString(artifacts, "transcriptPath", `${source}.artifacts`),
      patchPath: readOptionalString(artifacts, "patchPath", `${source}.artifacts`),
      summaryPath: readOptionalString(artifacts, "summaryPath", `${source}.artifacts`),
      rawResultPath: readOptionalString(artifacts, "rawResultPath", `${source}.artifacts`),
    },
    usage: result.usage ? (asRecord(result.usage, `${source}.usage`) as UnifiedEvalResult["usage"]) : undefined,
    cost: result.cost ? (asRecord(result.cost, `${source}.cost`) as UnifiedEvalResult["cost"]) : undefined,
    failure: result.failure ? (asRecord(result.failure, `${source}.failure`) as UnifiedEvalResult["failure"]) : undefined,
    reproducibility: {
      adapterId: readString(reproducibility, "adapterId", `${source}.reproducibility`),
      adapterStatus: readString(reproducibility, "adapterStatus", `${source}.reproducibility`) as UnifiedEvalResult["reproducibility"]["adapterStatus"],
      installKind: readString(reproducibility, "installKind", `${source}.reproducibility`),
      installPackage: readOptionalString(reproducibility, "installPackage", `${source}.reproducibility`),
      model: readOptionalString(reproducibility, "model", `${source}.reproducibility`),
      baseUrlHost: readOptionalString(reproducibility, "baseUrlHost", `${source}.reproducibility`),
      attempts: readNumber(reproducibility, "attempts", `${source}.reproducibility`),
      maxSteps: readOptionalNumber(reproducibility, "maxSteps", `${source}.reproducibility`),
      permissionMode: readOptionalString(reproducibility, "permissionMode", `${source}.reproducibility`),
      osSandbox: readOptionalString(reproducibility, "osSandbox", `${source}.reproducibility`),
    },
  }
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be an object`)
  return value as Record<string, unknown>
}

function readString(raw: Record<string, unknown>, key: string, source: string): string {
  const value = raw[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${key} must be a non-empty string`)
  return value
}

function readOptionalString(raw: Record<string, unknown>, key: string, source: string): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${source}.${key} must be a string`)
  return value
}

function readNumber(raw: Record<string, unknown>, key: string, source: string): number {
  const value = raw[key]
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${key} must be a finite number`)
  return value
}

function readOptionalNumber(raw: Record<string, unknown>, key: string, source: string): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}.${key} must be a finite number`)
  return value
}
