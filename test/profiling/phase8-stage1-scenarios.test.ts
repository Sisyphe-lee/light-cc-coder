import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { compareReports } from "../../profiling/compareReports"
import { validateAgainstSchema } from "../../profiling/schema/validateReport"
import { PROFILE_REPORT_SCHEMA_VERSION, type ProfileReport } from "../../profiling/report/types"
import {
  runAutoCompact,
  runEditVerify,
  runReadonlySearchBatch,
  runStartupNoop,
  STAGE1_SCENARIOS,
} from "./scenarios"

// Stage 1 deterministic scenarios: each FakeProvider script + fixed fixture, run
// with profiling on, must produce a schema-valid ProfileReport, and comparing a
// report with itself (or a second identical run) must not report a regression.
// These prove the Stage 0 reducer -> ProfileReport -> compareReports pipeline works
// end-to-end on real harness output.

function clone(report: ProfileReport): ProfileReport {
  return JSON.parse(JSON.stringify(report)) as ProfileReport
}

function toolNames(report: ProfileReport): string[] {
  return report.tools.map((tool) => tool.toolName).sort()
}

function toolCount(report: ProfileReport, name: string): number {
  return report.tools.find((tool) => tool.toolName === name)?.count ?? 0
}

describe("Phase 8 Stage 1 — every scenario produces a schema-valid, self-consistent report", () => {
  test("each scenario yields a schemaVersion:1 report with profile spans, and passes self-comparison", async () => {
    const schema = JSON.parse(await readFile(resolve("profiling/schema/profile-report.schema.json"), "utf8"))
    for (const scenario of STAGE1_SCENARIOS) {
      const result = await scenario.run()
      expect(result.report.schemaVersion).toBe(PROFILE_REPORT_SCHEMA_VERSION)
      expect(validateAgainstSchema(result.report, schema)).toEqual([])
      expect(result.report.summary.profileSpanCount).toBeGreaterThan(0)
      expect(result.meta.scenario).toBe(scenario.name)

      const selfCompare = compareReports({ baseline: result.report, current: clone(result.report) })
      expect(selfCompare.status).toBe("pass")
      expect(selfCompare.summary.failed).toBe(0)
    }
  })
})

describe("Phase 8 Stage 1 — per-scenario internal shape", () => {
  test("startup_noop: one turn, one step, one provider call, no tools, no bash", async () => {
    const { report } = await runStartupNoop()
    expect(report.session.turnCount).toBe(1)
    expect(report.session.stepCount).toBe(1)
    expect(report.provider.callCount).toBe(1)
    expect(report.runtime.bashCount).toBe(0)
    expect(report.tools).toHaveLength(0)
  })

  test("readonly_search_batch: two provider calls, glob/grep/read each once, no bash", async () => {
    const { report } = await runReadonlySearchBatch()
    expect(report.provider.callCount).toBe(2)
    expect(report.runtime.bashCount).toBe(0)
    expect(toolNames(report)).toEqual(["glob", "grep", "read"])
    expect(toolCount(report, "glob")).toBe(1)
    expect(toolCount(report, "grep")).toBe(1)
    expect(toolCount(report, "read")).toBe(1)
  })

  test("edit_verify: three provider calls, one edit, one bash verification", async () => {
    const { report } = await runEditVerify()
    expect(report.provider.callCount).toBe(3)
    expect(report.runtime.bashCount).toBe(1)
    expect(toolCount(report, "edit")).toBe(1)
    expect(toolCount(report, "bash")).toBe(1)
  })

  test("auto_compact: two turns and at least one timed compaction", async () => {
    const { report } = await runAutoCompact()
    expect(report.session.turnCount).toBe(2)
    expect(report.compact.count).toBeGreaterThanOrEqual(1)
    expect(report.compact.durationMs).not.toBeNull()
  })
})

describe("Phase 8 Stage 1 — cross-run stability (no false regressions)", () => {
  test("two runs of startup_noop compare cleanly (fully deterministic)", async () => {
    const first = await runStartupNoop()
    const second = await runStartupNoop()
    const comparison = compareReports({ baseline: first.report, current: second.report })
    expect(comparison.status).toBe("pass")
  })

  test("two runs of each scenario report no failures", async () => {
    for (const scenario of STAGE1_SCENARIOS) {
      const first = await scenario.run()
      const second = await scenario.run()
      const comparison = compareReports({ baseline: first.report, current: second.report })
      // Strict invariants are deterministic; tiny counter/shell timing jitter can
      // never reach the coarse fail thresholds, so a clean run never fails.
      expect(comparison.summary.failed).toBe(0)
    }
  })
})

describe("Phase 8 Stage 1 — the default guard catches an inflated report", () => {
  test("a 3x inflated category total on a real scenario report fails", async () => {
    const { report } = await runEditVerify()
    const inflated = clone(report)
    // Force a large, gating regression on top of a genuine scenario report.
    inflated.summary.observedDurationMs = Math.max(report.summary.observedDurationMs, 50) * 4 + 500
    inflated.categoryTotals = report.categoryTotals.map((entry) => ({
      ...entry,
      totalDurationMs: Math.max(entry.totalDurationMs, 50) * 4 + 500,
    }))
    const comparison = compareReports({ baseline: report, current: inflated })
    expect(comparison.status).toBe("fail")
    expect(comparison.summary.failed).toBeGreaterThan(0)
  })
})
