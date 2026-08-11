import type { EvalProfileRow, OutcomeProfileSplit } from "./types"
import { EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION } from "./types"
import { sumNullable } from "./utils"

export function buildOutcomeProfileSplits(rows: EvalProfileRow[]): OutcomeProfileSplit[] {
  const groups = new Map<string, EvalProfileRow[]>()
  for (const row of rows) {
    const key = outcomeKey(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([outcome, group]) => ({
    outcome,
    rows: group.length,
    requestCount: sumNullable(group.map((row) => row.commonProfile.provider.requestCount)),
    totalTokens: sumNullable(group.map((row) => row.commonProfile.provider.totalTokens)),
    estimatedUsd: sumNullable(group.map((row) => row.commonProfile.provider.estimatedUsd)),
    wrapperDurationMs: sumNullable(group.map((row) => row.commonProfile.wrapper.durationMs)),
    providerLatencyMs: sumNullable(group.map((row) => row.commonProfile.provider.totalLatencyMs)),
  }))
}

export function outcomeKey(row: EvalProfileRow): string {
  if (row.outcome.officialOutcome) return row.outcome.officialOutcome
  if (typeof row.outcome.tbenchReward === "number") return row.outcome.tbenchReward >= 1 ? "passed" : "failed"
  return row.outcome.status ?? "unknown"
}

export function isResolvedLike(row: EvalProfileRow): boolean {
  if (row.outcome.officialOutcome) return row.outcome.officialOutcome === "resolved"
  if (typeof row.outcome.tbenchReward === "number") return row.outcome.tbenchReward >= 1
  return false
}

export function isFailureLike(row: EvalProfileRow): boolean {
  if (row.outcome.officialOutcome) return row.outcome.officialOutcome !== "resolved"
  if (typeof row.outcome.tbenchReward === "number") return row.outcome.tbenchReward < 1
  if (row.outcome.emptyPatch === true) return true
  const exitCode = row.commonProfile.wrapper.exitCode
  return typeof exitCode === "number" && exitCode !== 0
}

export { EVAL_PROFILE_ANALYSIS_SCHEMA_VERSION }
