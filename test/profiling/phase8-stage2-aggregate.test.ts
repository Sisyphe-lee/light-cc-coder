import { describe, expect, test } from "bun:test"
import { aggregateLiveRuns, computeStats, LIVE_RUNS_SUMMARY_SCHEMA_VERSION, type LiveRunRecord } from "../../profiling/liveRuns/aggregate"
import type { ProfileReport } from "../../profiling/report/types"

// Stage 2 pure aggregate tests. They use synthetic single-run ProfileReport
// objects, so they need no real provider, no subprocess, and no filesystem.

type ReportOverrides = {
  observedDurationMs?: number
  topBottleneck?: string | null
  profileSpanCount?: number
  categoryTotals?: { category: string; totalDurationMs: number; spanCount?: number }[]
  provider?: Partial<ProfileReport["provider"]>
  context?: Partial<ProfileReport["context"]>
  tools?: ProfileReport["tools"]
  runtime?: Partial<ProfileReport["runtime"]>
  compact?: Partial<ProfileReport["compact"]>
  transcriptWrite?: Partial<ProfileReport["transcriptWrite"]>
}

function makeReport(overrides: ReportOverrides = {}): ProfileReport {
  return {
    schemaVersion: 1,
    sourceTranscript: "x.jsonl",
    generatedAt: "",
    session: { sessionId: "s1", cwd: "/w", turnCount: 1, stepCount: 1 },
    summary: {
      observedDurationMs: overrides.observedDurationMs ?? 100,
      profileSpanCount: overrides.profileSpanCount ?? 4,
      topBottleneck: overrides.topBottleneck === undefined ? "provider" : overrides.topBottleneck,
    },
    categoryTotals: (overrides.categoryTotals ?? [{ category: "provider", totalDurationMs: 80 }]).map((entry) => ({
      category: entry.category,
      totalDurationMs: entry.totalDurationMs,
      spanCount: entry.spanCount ?? 1,
    })),
    topSlowSpans: [],
    provider: {
      callCount: 1,
      totalDurationMs: 80,
      firstTokenMsP50: 40,
      firstTokenMsMax: 40,
      streamMsP50: 60,
      streamMsMax: 60,
      retryCount: 0,
      failureClasses: [],
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      ...overrides.provider,
    },
    context: { assembleCount: 1, totalDurationMs: 10, maxEstimatedTokens: 1000, ...overrides.context },
    tools: overrides.tools ?? [],
    approval: { count: 0, allowCount: 0, denyCount: 0, waitMsTotal: null, waitMsMax: null },
    runtime: { bashCount: 0, durationMsP50: null, durationMsMax: null, nonzeroExitCount: 0, timeoutCount: 0, truncatedCount: 0, ...overrides.runtime },
    mcp: { serverStartupCount: 0, readyCount: 0, failedCount: 0, toolCallCount: 0 },
    compact: { count: 0, failedCount: 0, durationMs: null, preCompactEstimatedTokens: null, postCompactEstimatedTokens: null, ...overrides.compact },
    transcriptWrite: { writeCount: 0, totalDurationMs: null, maxDurationMs: null, totalBytes: null, profilerSpanWriteCount: 0, profilerSpanWriteDurationMs: null, ...overrides.transcriptWrite },
    warnings: [],
  }
}

function okRun(index: number, report: ProfileReport, opts: { warmup?: boolean; wallClockMs?: number } = {}): LiveRunRecord {
  return {
    index,
    warmup: opts.warmup ?? false,
    status: "ok",
    wallClockMs: opts.wallClockMs ?? 1000,
    transcriptPath: `/out/run-${index}.transcript.jsonl`,
    reportPath: `/out/run-${index}.report.json`,
    report,
    error: null,
  }
}

describe("computeStats", () => {
  test("median/min/max/IQR for an odd sample (Tukey hinges)", () => {
    const stats = computeStats([10, 20, 30, 40, 50])
    expect(stats).toEqual({ count: 5, median: 30, min: 10, max: 50, iqr: 30 })
  })

  test("median/IQR for an even sample averages middle pairs", () => {
    const stats = computeStats([1, 2, 3, 4])
    expect(stats).toEqual({ count: 4, median: 2.5, min: 1, max: 4, iqr: 2 })
  })

  test("single value collapses IQR to 0", () => {
    expect(computeStats([7])).toEqual({ count: 1, median: 7, min: 7, max: 7, iqr: 0 })
  })

  test("empty sample is null", () => {
    expect(computeStats([])).toBeNull()
  })

  test("median is order-independent", () => {
    expect(computeStats([50, 10, 40, 30, 20])).toEqual(computeStats([10, 20, 30, 40, 50]))
  })
})

describe("aggregateLiveRuns", () => {
  test("aggregates observed duration and provider stats across included runs", () => {
    const runs = [
      okRun(0, makeReport({ observedDurationMs: 100, provider: { firstTokenMsP50: 40, streamMsP50: 60, totalDurationMs: 80, inputTokens: 1000, outputTokens: 200 } })),
      okRun(1, makeReport({ observedDurationMs: 200, provider: { firstTokenMsP50: 50, streamMsP50: 70, totalDurationMs: 90, inputTokens: 1100, outputTokens: 210 } })),
      okRun(2, makeReport({ observedDurationMs: 300, provider: { firstTokenMsP50: 60, streamMsP50: 80, totalDurationMs: 100, inputTokens: 1200, outputTokens: 220 } })),
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })

    expect(summary.schemaVersion).toBe(LIVE_RUNS_SUMMARY_SCHEMA_VERSION)
    expect(summary.kind).toBe("live-runs.summary")
    expect(summary.counts).toMatchObject({ total: 3, included: 3, warmup: 0, skipped: 0, failed: 0 })
    expect(summary.observedDurationMs).toEqual({ count: 3, median: 200, min: 100, max: 300, iqr: 200 })
    expect(summary.provider.firstTokenMs).toMatchObject({ median: 50, min: 40, max: 60 })
    expect(summary.provider.inputTokens).toMatchObject({ median: 1100, min: 1000, max: 1200 })
    expect(summary.wallClockMsTotal).toBe(3000)
    expect(summary.includedTranscriptPaths).toHaveLength(3)
    expect(summary.includedReportPaths).toHaveLength(3)
  })

  test("excludes warmup runs from statistics but counts them", () => {
    const runs = [
      okRun(0, makeReport({ observedDurationMs: 9999 }), { warmup: true, wallClockMs: 500 }),
      okRun(1, makeReport({ observedDurationMs: 100 }), { wallClockMs: 1000 }),
      okRun(2, makeReport({ observedDurationMs: 300 }), { wallClockMs: 1000 }),
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })

    expect(summary.counts).toMatchObject({ total: 3, included: 2, warmup: 1 })
    // The 9999ms warmup value must NOT pollute the median.
    expect(summary.observedDurationMs).toEqual({ count: 2, median: 200, min: 100, max: 300, iqr: 200 })
    // Wall-clock total still includes the warmup time actually spent.
    expect(summary.wallClockMsTotal).toBe(2500)
    expect(summary.runs.find((entry) => entry.warmup)?.included).toBe(false)
  })

  test("accounts for failed and skipped runs without dropping successful reports", () => {
    const runs: LiveRunRecord[] = [
      okRun(0, makeReport({ observedDurationMs: 100 })),
      { index: 1, warmup: false, status: "failed", wallClockMs: 50, transcriptPath: "/out/run-1.t.jsonl", reportPath: null, report: null, error: "CLI exited with code 1" },
      { index: 2, warmup: false, status: "skipped", wallClockMs: null, transcriptPath: null, reportPath: null, report: null, error: "rate limited" },
      okRun(3, makeReport({ observedDurationMs: 300 })),
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })

    expect(summary.counts).toMatchObject({ total: 4, included: 2, failed: 1, skipped: 1 })
    expect(summary.observedDurationMs).toEqual({ count: 2, median: 200, min: 100, max: 300, iqr: 200 })
    expect(summary.failures).toEqual([
      { index: 1, status: "failed", error: "CLI exited with code 1" },
      { index: 2, status: "skipped", error: "rate limited" },
    ])
    expect(summary.warnings.some((w) => w.includes("1 run(s) failed"))).toBe(true)
    expect(summary.warnings.some((w) => w.includes("1 run(s) skipped"))).toBe(true)
  })

  test("computes top bottleneck frequency across included runs", () => {
    const runs = [
      okRun(0, makeReport({ topBottleneck: "provider" })),
      okRun(1, makeReport({ topBottleneck: "provider" })),
      okRun(2, makeReport({ topBottleneck: "transcript" })),
      okRun(3, makeReport({ topBottleneck: null })),
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })
    expect(summary.topBottleneckFrequency).toEqual([
      { category: "provider", count: 2 },
      { category: "transcript", count: 1 },
    ])
  })

  test("aggregates per-tool counts and durations by tool name", () => {
    const runs = [
      okRun(
        0,
        makeReport({
          tools: [
            { toolName: "read", count: 2, durationMsP50: 5, durationMsMax: 8, errorCount: 0, deniedCount: 0, timeoutCount: 0 },
            { toolName: "grep", count: 1, durationMsP50: 10, durationMsMax: 10, errorCount: 1, deniedCount: 0, timeoutCount: 0 },
          ],
        }),
      ),
      okRun(
        1,
        makeReport({
          tools: [{ toolName: "read", count: 3, durationMsP50: 7, durationMsMax: 12, errorCount: 0, deniedCount: 0, timeoutCount: 1 }],
        }),
      ),
    ]
    const summary = aggregateLiveRuns({ scenario: "repo_overview", runs })

    const read = summary.tools.find((tool) => tool.toolName === "read")
    expect(read).toMatchObject({ count: 5, runCount: 2, timeoutCount: 1 })
    expect(read?.durationMsP50).toMatchObject({ median: 6, min: 5, max: 7 })
    const grep = summary.tools.find((tool) => tool.toolName === "grep")
    expect(grep).toMatchObject({ count: 1, runCount: 1, errorCount: 1 })
    // Sorted by total count desc.
    expect(summary.tools[0].toolName).toBe("read")
  })

  test("aggregates category totals treating missing categories as zero that run", () => {
    const runs = [
      okRun(0, makeReport({ categoryTotals: [{ category: "provider", totalDurationMs: 80 }, { category: "transcript", totalDurationMs: 20 }] })),
      okRun(1, makeReport({ categoryTotals: [{ category: "provider", totalDurationMs: 100 }] })),
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })
    const transcript = summary.categoryTotals.find((entry) => entry.category === "transcript")
    // Second run had no transcript category, counted as 0.
    expect(transcript).toMatchObject({ count: 2, min: 0, max: 20, median: 10 })
  })

  test("warns and excludes a run with no profile.span data", () => {
    const runs = [okRun(0, makeReport({ observedDurationMs: 100 })), okRun(1, makeReport({ profileSpanCount: 0, observedDurationMs: 0 }))]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })

    expect(summary.counts).toMatchObject({ included: 1, missingProfileData: 1 })
    expect(summary.observedDurationMs).toEqual({ count: 1, median: 100, min: 100, max: 100, iqr: 0 })
    expect(summary.warnings.some((w) => w.includes("no profile.span data"))).toBe(true)
  })

  test("warns and excludes a malformed report on an ok run", () => {
    const runs: LiveRunRecord[] = [
      okRun(0, makeReport({ observedDurationMs: 100 })),
      { index: 1, warmup: false, status: "ok", wallClockMs: 1000, transcriptPath: "/out/run-1.t.jsonl", reportPath: "/out/run-1.report.json", report: { schemaVersion: 2 } as unknown as ProfileReport, error: null },
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })

    expect(summary.counts).toMatchObject({ included: 1, malformed: 1 })
    expect(summary.warnings.some((w) => w.includes("missing or malformed"))).toBe(true)
  })

  test("empty run set warns about no included data", () => {
    const summary = aggregateLiveRuns({ scenario: "pong", runs: [] })
    expect(summary.counts.included).toBe(0)
    expect(summary.observedDurationMs).toBeNull()
    expect(summary.warnings.some((w) => w.includes("no included runs"))).toBe(true)
  })

  test("aggregates transcript-write sum and median across runs", () => {
    const runs = [
      okRun(0, makeReport({ transcriptWrite: { totalDurationMs: 10, totalBytes: 1000 } })),
      okRun(1, makeReport({ transcriptWrite: { totalDurationMs: 30, totalBytes: 1200 } })),
    ]
    const summary = aggregateLiveRuns({ scenario: "pong", runs })
    expect(summary.transcriptWrite.totalDurationMs).toMatchObject({ median: 20, min: 10, max: 30 })
    expect(summary.transcriptWrite.sumDurationMs).toBe(40)
    expect(summary.transcriptWrite.sumBytes).toBe(2200)
  })
})
