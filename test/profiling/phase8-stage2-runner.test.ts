import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseLiveRunArgs } from "../../profiling/liveRuns/runner"
import { runLive } from "../../profiling/liveRuns/runner"
import { renderLiveRunsSummary } from "../../profiling/liveRuns/renderSummary"
import type { LiveRunsSummary } from "../../profiling/liveRuns/aggregate"
import { createTempWorkspace } from "../helpers"

// Stage 2 runner smoke. This exercises the full orchestration (spawn -> transcript
// -> offline reducer -> single-run report -> aggregate -> summary file) WITHOUT a
// real provider by passing --fake, which routes the CLI through FakeProvider. It is
// NOT wired into any CI gate; it just runs under `bun run test`.

describe("parseLiveRunArgs", () => {
  test("requires a scenario or prompt file", () => {
    expect(() => parseLiveRunArgs([])).toThrow(/--scenario|--prompt-file/)
  })

  test("rejects supplying both scenario and prompt file", () => {
    expect(() => parseLiveRunArgs(["--scenario", "pong", "--prompt-file", "/tmp/x"])).toThrow(/only one/)
  })

  test("parses run/warmup/provider options with defaults", () => {
    const options = parseLiveRunArgs(["--scenario", "pong", "--runs", "7", "--warmup", "2", "--model", "m", "--fake"])
    expect(options).toMatchObject({ scenario: "pong", runs: 7, warmup: 2, model: "m", fake: true })
  })

  test("defaults runs to 5 and warmup to 0", () => {
    const options = parseLiveRunArgs(["--scenario", "pong"])
    expect(options.runs).toBe(5)
    expect(options.warmup).toBe(0)
  })

  test("rejects non-positive runs", () => {
    expect(() => parseLiveRunArgs(["--scenario", "pong", "--runs", "0"])).toThrow(/positive integer/)
  })
})

describe("runLive (fake provider smoke)", () => {
  test("runs warmup + measured fake sessions and writes an aggregate summary", async () => {
    const cwd = await createTempWorkspace("light-cc-stage2-cwd-")
    const outDir = await createTempWorkspace("light-cc-stage2-out-")

    const { summary, summaryPath } = await runLive({
      scenario: "pong",
      cwd,
      runs: 1,
      warmup: 1,
      outDir,
      json: true,
      fake: true,
      osSandbox: "off",
      permissionMode: "read-only",
      timeoutMs: 120_000,
    })

    // Two attempts total: one warmup (excluded), one measured (included).
    expect(summary.counts.total).toBe(2)
    expect(summary.counts.warmup).toBe(1)
    expect(summary.counts.included).toBe(1)
    expect(summary.counts.failed).toBe(0)

    // The fake one-shot produces a single provider step and a transcript-write span.
    expect(summary.provider.totalDurationMs).not.toBeNull()
    expect(summary.observedDurationMs).not.toBeNull()
    expect(summary.includedReportPaths).toHaveLength(1)
    expect(summary.topBottleneckFrequency.length).toBeGreaterThan(0)

    // Aggregate file is written and parses back to the same shape.
    const written = JSON.parse(await readFile(summaryPath, "utf8")) as LiveRunsSummary
    expect(written.schemaVersion).toBe(1)
    expect(written.kind).toBe("live-runs.summary")
    expect(summaryPath).toBe(join(outDir, "live-runs.summary.json"))

    // The single-run report artifact exists on disk and is schemaVersion 1.
    const reportPath = summary.includedReportPaths[0]
    const report = JSON.parse(await readFile(reportPath, "utf8")) as { schemaVersion: number }
    expect(report.schemaVersion).toBe(1)

    // Human render does not throw and mentions the scenario.
    expect(renderLiveRunsSummary(summary)).toContain("pong")
  }, 60_000)
})
