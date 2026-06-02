import { describe, expect, test } from "bun:test"
import { compareReports, renderComparison, type ProfileComparison } from "../../profiling/compareReports"
import type { ComparisonCheck } from "../../profiling/compareReports"
import type { ProfileReport } from "../../profiling/report/types"

// Stage 1 compareReports is a developer-only coarse regression guard. These tests
// pin the gating contract from spec/phase-8-stage-1.md §6-§8 using hand-built
// reports (mutated clones of a baseline), so the gating logic is exercised
// deterministically and independently of real timing.

function baselineReport(): ProfileReport {
  return {
    schemaVersion: 1,
    sourceTranscript: "/tmp/baseline.jsonl",
    generatedAt: "2026-06-02T00:00:00.000Z",
    session: { sessionId: "s1", cwd: "/workspace", turnCount: 1, stepCount: 2 },
    summary: { observedDurationMs: 100, profileSpanCount: 10, topBottleneck: "provider" },
    categoryTotals: [
      { category: "provider", totalDurationMs: 200, spanCount: 2 },
      { category: "context", totalDurationMs: 40, spanCount: 2 },
    ],
    topSlowSpans: [{ spanId: "span_1", name: "provider.step", category: "provider", status: "ok", durationMs: 120 }],
    provider: {
      callCount: 2,
      totalDurationMs: 200,
      firstTokenMsP50: 40,
      firstTokenMsMax: 60,
      streamMsP50: 80,
      streamMsMax: 100,
      retryCount: 0,
      failureClasses: [],
      inputTokens: 1200,
      outputTokens: 34,
      cacheReadInputTokens: 1000,
      cacheWriteInputTokens: null,
    },
    context: { assembleCount: 2, totalDurationMs: 40, maxEstimatedTokens: 1500 },
    tools: [{ toolName: "read", count: 1, durationMsP50: 30, durationMsMax: 30, errorCount: 0, deniedCount: 0, timeoutCount: 0 }],
    approval: { count: 0, allowCount: 0, denyCount: 0, waitMsTotal: null, waitMsMax: null },
    runtime: { bashCount: 1, durationMsP50: 100, durationMsMax: 100, nonzeroExitCount: 0, timeoutCount: 0, truncatedCount: 0 },
    mcp: { serverStartupCount: 0, readyCount: 0, failedCount: 0, toolCallCount: 0 },
    compact: { count: 0, failedCount: 0, durationMs: null, preCompactEstimatedTokens: null, postCompactEstimatedTokens: null },
    transcriptWrite: { writeCount: 10, totalDurationMs: 100, maxDurationMs: 10, totalBytes: 4000, profilerSpanWriteCount: 10, profilerSpanWriteDurationMs: 5 },
    warnings: [],
  }
}

function clone(report: ProfileReport): ProfileReport {
  return JSON.parse(JSON.stringify(report)) as ProfileReport
}

function check(comparison: ProfileComparison, metric: string): ComparisonCheck | undefined {
  return comparison.checks.find((entry) => entry.metric === metric)
}

describe("Phase 8 Stage 1 — compareReports identical / same-shape", () => {
  test("a report compared with itself passes with no failures or warnings", () => {
    const report = baselineReport()
    const result = compareReports({ baseline: report, current: clone(report) })
    expect(result.status).toBe("pass")
    expect(result.summary.failed).toBe(0)
    expect(result.summary.warned).toBe(0)
    expect(result.summary.topRegressions).toHaveLength(0)
    expect(result.diagnostics).toBeUndefined()
    expect(result.schemaVersion).toBe(1)
  })

  test("comparison output is JSON-serializable", () => {
    const report = baselineReport()
    const result = compareReports({ baseline: report, current: clone(report) })
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow()
  })
})

describe("Phase 8 Stage 1 — strict invariant mismatches fail", () => {
  test("turnCount mismatch fails", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.session.turnCount = 2
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "session.turnCount")?.severity).toBe("fail")
  })

  test("provider.callCount mismatch fails", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.provider.callCount = 3
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "provider.callCount")?.severity).toBe("fail")
  })

  test("context.assembleCount and runtime.bashCount mismatches fail", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.context.assembleCount = 5
    current.runtime.bashCount = 2
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "context.assembleCount")?.severity).toBe("fail")
    expect(check(result, "runtime.bashCount")?.severity).toBe("fail")
  })

  test("tool count change by name fails, and a new tool appearing fails", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.tools[0].count = 2
    current.tools.push({ toolName: "edit", count: 1, durationMsP50: 5, durationMsMax: 5, errorCount: 0, deniedCount: 0, timeoutCount: 0 })
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "tools.read.count")?.severity).toBe("fail")
    expect(check(result, "tools.edit.count")?.severity).toBe("fail")
    expect(check(result, "tools.edit.count")?.baseline).toBe(0)
  })

  test("scripted provider usage counters use strict equality", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.provider.inputTokens = 1300
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "provider.inputTokens")?.severity).toBe("fail")
  })

  test("usage counter presence change (null -> value) fails", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.provider.cacheWriteInputTokens = 50 // baseline is null
    const result = compareReports({ baseline, current })
    expect(check(result, "provider.cacheWriteInputTokens")?.severity).toBe("fail")
  })

  test("compact.count and mcp.toolCallCount mismatches fail", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.compact.count = 1
    current.mcp.toolCallCount = 1
    const result = compareReports({ baseline, current })
    expect(check(result, "compact.count")?.severity).toBe("fail")
    expect(check(result, "mcp.toolCallCount")?.severity).toBe("fail")
  })
})

describe("Phase 8 Stage 1 — coarse duration thresholds", () => {
  test("an inflated aggregate duration fails at the 2x ratio + 100ms delta", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.summary.observedDurationMs = 300 // 3x of 100, delta +200ms
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    const c = check(result, "summary.observedDurationMs")
    expect(c?.severity).toBe("fail")
    expect(c?.ratio).toBe(3)
    expect(c?.deltaMs).toBe(200)
  })

  test("a moderate slowdown warns but does not fail", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.summary.observedDurationMs = 160 // 1.6x of 100 (>=1.5, <2.0), delta +60ms (>=50)
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("warn")
    expect(check(result, "summary.observedDurationMs")?.severity).toBe("warn")
  })

  test("a category total regression fails", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.categoryTotals = [
      { category: "provider", totalDurationMs: 600, spanCount: 2 }, // 3x of 200
      { category: "context", totalDurationMs: 40, spanCount: 2 },
    ]
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "categoryTotals.provider.totalDurationMs")?.severity).toBe("fail")
    expect(check(result, "categoryTotals.context.totalDurationMs")?.severity).toBe("pass")
  })

  test("a metric below minComparableMs is reported as info, never fail", () => {
    const baseline = baselineReport()
    baseline.context.totalDurationMs = 10 // below 25ms floor
    const current = clone(baseline)
    current.context.totalDurationMs = 500 // 50x, but baseline is too small to gate
    const result = compareReports({ baseline, current })
    const c = check(result, "context.totalDurationMs")
    expect(c?.severity).toBe("info")
    expect(result.status).toBe("pass")
  })

  test("a metric present on only one side is info, not a duration failure", () => {
    const baseline = baselineReport()
    baseline.compact.durationMs = null
    const current = clone(baseline)
    current.compact.durationMs = 500
    const result = compareReports({ baseline, current })
    expect(check(result, "compact.durationMs")?.severity).toBe("info")
  })
})

describe("Phase 8 Stage 1 — runtime / transcriptWrite use a wider threshold", () => {
  test("a 2.5x runtime regression warns (wider 3.0 failRatio) instead of failing", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.runtime.durationMsP50 = 250 // 2.5x of 100, delta +150ms
    current.runtime.durationMsMax = 250
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("warn")
    expect(check(result, "runtime.durationMsP50")?.severity).toBe("warn")
  })

  test("the same runtime regression fails under an explicit default-tight override", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.runtime.durationMsP50 = 250
    current.runtime.durationMsMax = 250
    const result = compareReports({ baseline, current, thresholds: { runtime: { failRatio: 2.0 } } })
    expect(result.status).toBe("fail")
    expect(check(result, "runtime.durationMsP50")?.severity).toBe("fail")
  })

  test("a 2.5x transcriptWrite regression warns under the wider threshold", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.transcriptWrite.totalDurationMs = 250 // 2.5x of 100
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("warn")
    expect(check(result, "transcriptWrite.totalDurationMs")?.severity).toBe("warn")
  })
})

describe("Phase 8 Stage 1 — token growth (warn-only, count delta)", () => {
  test("large context growth warns", () => {
    const baseline = baselineReport()
    baseline.context.maxEstimatedTokens = 1000
    const current = clone(baseline)
    current.context.maxEstimatedTokens = 2000 // 2x, +1000 tokens
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("warn")
    expect(check(result, "context.maxEstimatedTokens")?.severity).toBe("warn")
  })

  test("small context growth passes (below token delta floor)", () => {
    const baseline = baselineReport()
    baseline.context.maxEstimatedTokens = 1000
    const current = clone(baseline)
    current.context.maxEstimatedTokens = 1100 // 1.1x, +100 tokens < 500
    const result = compareReports({ baseline, current })
    expect(check(result, "context.maxEstimatedTokens")?.severity).toBe("pass")
    expect(result.status).toBe("pass")
  })
})

describe("Phase 8 Stage 1 — missing profile data", () => {
  test("current report with no spans fails when baseline had data", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.summary.profileSpanCount = 0
    const result = compareReports({ baseline, current })
    expect(result.status).toBe("fail")
    expect(check(result, "profileData.present")?.severity).toBe("fail")
  })

  test("both reports missing profile data warns (comparison not meaningful)", () => {
    const baseline = baselineReport()
    baseline.summary.profileSpanCount = 0
    const current = clone(baseline)
    const result = compareReports({ baseline, current })
    expect(check(result, "profileData.present")?.severity).toBe("warn")
  })
})

describe("Phase 8 Stage 1 — malformed / unsupported reports", () => {
  test("an unsupported schemaVersion fails without throwing", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    ;(current as { schemaVersion: number }).schemaVersion = 2
    let result: ProfileComparison | undefined
    expect(() => {
      result = compareReports({ baseline, current })
    }).not.toThrow()
    expect(result?.status).toBe("fail")
    expect(check(result as ProfileComparison, "schemaVersion")?.severity).toBe("fail")
  })

  test("a non-object report fails without throwing", () => {
    const baseline = baselineReport()
    let result: ProfileComparison | undefined
    expect(() => {
      result = compareReports({ baseline, current: {} as unknown as ProfileReport })
    }).not.toThrow()
    expect(result?.status).toBe("fail")
  })
})

describe("Phase 8 Stage 1 — rendering and diagnostics", () => {
  test("renderComparison summarizes a failing comparison and lists top slow spans", () => {
    const baseline = baselineReport()
    const current = clone(baseline)
    current.summary.observedDurationMs = 400
    const result = compareReports({ baseline, current })
    expect(result.diagnostics?.topSlowSpans?.length).toBeGreaterThan(0)
    const text = renderComparison(result)
    expect(text).toContain("Profile comparison: FAIL")
    expect(text).toContain("summary.observedDurationMs")
    expect(text).toContain("top slow spans")
  })

  test("renderComparison reports a clean pass", () => {
    const report = baselineReport()
    const result = compareReports({ baseline: report, current: clone(report) })
    expect(renderComparison(result)).toContain("PASS")
    expect(renderComparison(result)).toContain("no regressions")
  })
})
