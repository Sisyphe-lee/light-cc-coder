import type { ProfileReport } from "./types"

// Stable machine-readable output. Pretty-printed for human diffing; the contract
// is the JSON structure, defined by ../schema/profile-report.schema.json.
export function renderJson(report: ProfileReport): string {
  return JSON.stringify(report, null, 2)
}
