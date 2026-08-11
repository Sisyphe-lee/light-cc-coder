import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildProfileAnalysis, writeProfileAnalysisArtifacts } from "../../evals/report/profile-analysis/run"
import { createTempWorkspace } from "../helpers"

describe("eval profile analysis", () => {
  test("builds SWE-bench rows from matrix artifacts without reading raw artifacts", async () => {
    const root = await createTempWorkspace("light-cc-profile-analysis-swe-")
    const reportDir = join(root, "matrix", "jobs", "001-lightcc-swebench-repo__case-1", "report")
    const artifactDir = join(reportDir, "instances", "repo__case-1")
    const agentDir = join(artifactDir, "agent")
    await mkdir(agentDir, { recursive: true })

    await writeJson(join(reportDir, "provider.profile.json"), providerProfileFixture({
      requestCount: 2,
      totalTokens: 2000,
      errorCount: 1,
    }))
    await writeJson(join(agentDir, "wrapper.profile.json"), wrapperProfileFixture({
      coderId: "lightcc",
      itemId: "repo__case-1",
      patchPath: join(artifactDir, "patch.diff"),
      exitCode: 1,
      durationMs: 5000,
    }))
    await writeJson(join(agentDir, "profile.report.json"), internalProfileFixture())
    await writeJson(join(artifactDir, "metrics.json"), {
      status: "completed",
      patchBytes: 120,
      patchLines: 4,
      patchSha256: "abc123",
      changedFiles: ["pkg/core.py"],
      emptyPatch: false,
    })
    await writeJson(join(reportDir, "summary.json"), {
      schemaVersion: 1,
      runId: "unit-swe-run",
      reportDir,
      status: "completed",
      coder: { id: "lightcc", displayName: "Light CC Coder" },
      swebench: { dataset: "unit" },
      results: [
        {
          instanceId: "repo__case-1",
          status: "completed",
          artifactDir,
          patchPath: join(artifactDir, "patch.diff"),
          transcriptPath: join(agentDir, "transcript.jsonl"),
          wrapperProfilePath: join(agentDir, "wrapper.profile.json"),
          profileReportPath: join(agentDir, "profile.report.json"),
          patchBytes: 120,
          patchLines: 4,
          patchSha256: "abc123",
          changedFiles: ["pkg/core.py"],
          emptyPatch: false,
          cost: { totalUsd: 0.0123, pricing: { source: "unit pricing" } },
        },
      ],
    })

    const result = await buildProfileAnalysis({ runRoot: root })
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row).toMatchObject({
      benchmark: "swebench",
      runId: "unit-swe-run",
      itemId: "repo__case-1",
      coderId: "lightcc",
      outcome: {
        patchBytes: 120,
        patchLines: 4,
        changedFiles: ["pkg/core.py"],
      },
      commonProfile: {
        wrapper: { exists: true, valid: true, exitCode: 1 },
        provider: { exists: true, valid: true, requestCount: 2, errorCount: 1, estimatedUsd: 0.0123 },
      },
      internalProfile: { exists: true, valid: true, topBottleneck: "tool" },
    })
    expect(result.summary.coverage).toMatchObject({
      wrapper: { valid: 1, missing: 0 },
      provider: { valid: 1, missing: 0 },
      internal: { valid: 1, missing: 0 },
    })
    expect(result.outliers.map((outlier) => outlier.kind)).toContain("provider_error")
    expect(result.outliers.map((outlier) => outlier.kind)).toContain("wrapper_nonzero_exit")

    const outDir = join(root, "profile-analysis")
    await writeProfileAnalysisArtifacts(result, outDir)
    const rowsText = await readFile(join(outDir, "eval-profile.rows.jsonl"), "utf8")
    expect(rowsText).toContain("\"repo__case-1\"")
    expect(rowsText).not.toContain("SECRET_PATCH_CONTENT")
  })

  test("keeps Terminal-Bench run-level provider profile out of per-task rows", async () => {
    const root = await createTempWorkspace("light-cc-profile-analysis-tbench-")
    const summaryDir = join(root, "terminal-bench")
    const taskDir = join(summaryDir, "tasks", "terminal-bench_demo-task")
    const jobAgentDir = join(root, "jobs", "unit-tbench-run", "demo-task__abc123", "agent")
    await mkdir(taskDir, { recursive: true })
    await mkdir(jobAgentDir, { recursive: true })

    await writeJson(join(root, "provider.profile.json"), providerProfileFixture({ requestCount: 5, totalTokens: 5000, errorCount: 0 }))
    await writeJson(join(jobAgentDir, "wrapper.profile.json"), wrapperProfileFixture({
      coderId: "lightcc",
      itemId: "",
      patchPath: "/logs/agent/patch.diff",
      exitCode: 0,
      durationMs: 3000,
      benchmark: "terminal-bench",
    }))
    await writeJson(join(jobAgentDir, "profile.report.json"), internalProfileFixture())
    await writeJson(join(taskDir, "metrics.json"), {
      taskId: "terminal-bench/demo-task",
      status: "prepared",
      artifactDir: taskDir,
    })
    await writeJson(join(summaryDir, "summary.json"), {
      runId: "unit-tbench-run",
      coder: { id: "lightcc", displayName: "Light CC Coder" },
      tasks: [{ taskId: "terminal-bench/demo-task", status: "prepared", artifactDir: taskDir }],
      profileReports: [{ reportPath: join(jobAgentDir, "profile.report.json") }],
      wrapperProfilePaths: [join(jobAgentDir, "wrapper.profile.json")],
      providerProfilePaths: [join(root, "provider.profile.json")],
    })

    const result = await buildProfileAnalysis({ runRoot: root })
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.benchmark).toBe("terminal-bench")
    expect(row.itemId).toBe("terminal-bench/demo-task")
    expect(row.commonProfile.provider.exists).toBe(false)
    expect(row.commonProfile.wrapper.exists).toBe(true)
    expect(result.summary.warnings.examples.join("\n")).toContain("provider profile is not row-associated")
  })
})

function providerProfileFixture(input: { requestCount: number; totalTokens: number; errorCount: number }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "metadata-only-provider-proxy",
    privacy: {
      prompt: "not_recorded",
      response: "not_recorded",
      apiKey: "not_recorded",
    },
    proxy: { model: "deepseek-v4-flash" },
    totals: {
      requestCount: input.requestCount,
      successCount: input.requestCount - input.errorCount,
      errorCount: input.errorCount,
      retryableErrorCount: input.errorCount,
      totalLatencyMs: input.requestCount * 1000,
      averageLatencyMs: 1000,
      averageFirstTokenMs: 250,
      usage: {
        inputTokens: input.totalTokens - 100,
        outputTokens: 100,
        totalTokens: input.totalTokens,
        cacheReadInputTokens: input.totalTokens - 500,
        cacheWriteInputTokens: 400,
        reasoningTokens: 10,
      },
      cost: { estimatedUsd: null, currency: "USD", source: "not_configured" },
    },
    requests: Array.from({ length: input.requestCount }, (_, index) => ({
      latencyMs: 900 + index * 100,
      firstTokenMs: 200 + index * 10,
      model: "deepseek-v4-flash",
      error: index < input.errorCount ? { kind: "upstream_http_error", status: 429, retryable: true } : null,
    })),
  }
}

function wrapperProfileFixture(input: {
  coderId: string
  itemId: string
  patchPath: string
  exitCode: number
  durationMs: number
  benchmark?: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    wrapper: { id: input.coderId, displayName: input.coderId, runtime: "unit-test" },
    run: { benchmark: input.benchmark ?? "swebench", runId: "unit-run", itemId: input.itemId },
    command: { executablePath: "/bin/unit", cwd: "/workspace", argCount: 2, argsSha256: "args" },
    artifacts: [
      { kind: "prompt", path: "/logs/agent/prompt.md", bytes: 10, sha256: "prompt" },
      { kind: "transcript", path: "/logs/agent/transcript.jsonl", bytes: 200, sha256: "transcript" },
      { kind: "patch", path: input.patchPath, bytes: 120, sha256: "patch" },
      { kind: "stdout", path: "/logs/agent/stdout.log", bytes: 0, sha256: "stdout" },
      { kind: "stderr", path: "/logs/agent/stderr.log", bytes: 0, sha256: "stderr" },
      { kind: "summary", path: "/logs/agent/profile.report.json", bytes: 100, sha256: "summary" },
    ],
    environment: { missingNames: [] },
    process: { exitCode: input.exitCode, durationMs: input.durationMs },
    warnings: [],
  }
}

function internalProfileFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceTranscript: "/logs/agent/transcript.jsonl",
    generatedAt: "2026-06-04T00:00:00.000Z",
    session: { sessionId: "unit", cwd: "/workspace", turnCount: 1, stepCount: 1 },
    summary: { observedDurationMs: 2500, profileSpanCount: 4, topBottleneck: "tool" },
    categoryTotals: [
      { category: "tool", totalDurationMs: 2000, spanCount: 2 },
      { category: "provider", totalDurationMs: 500, spanCount: 1 },
    ],
    topSlowSpans: [{ spanId: "s1", name: "tool.execute", category: "tool", status: "ok", durationMs: 2000 }],
    provider: {
      callCount: 1,
      totalDurationMs: 500,
      firstTokenMsP50: 200,
      firstTokenMsMax: 200,
      streamMsP50: 300,
      streamMsMax: 300,
      retryCount: 0,
      failureClasses: [],
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: null,
    },
    context: { assembleCount: 1, totalDurationMs: 10, maxEstimatedTokens: 1000 },
    tools: [{ toolName: "bash", count: 1, durationMsP50: 2000, durationMsMax: 2000, errorCount: 1, deniedCount: 0, timeoutCount: 0 }],
    approval: { count: 0, allowCount: 0, denyCount: 0, waitMsTotal: null, waitMsMax: null },
    runtime: { bashCount: 1, durationMsP50: 2000, durationMsMax: 2000, nonzeroExitCount: 1, timeoutCount: 0, truncatedCount: 0 },
    mcp: { serverStartupCount: 0, readyCount: 0, failedCount: 0, toolCallCount: 0 },
    compact: { count: 0, failedCount: 0, durationMs: null, preCompactEstimatedTokens: null, postCompactEstimatedTokens: null },
    transcriptWrite: {
      writeCount: 2,
      totalDurationMs: 100,
      maxDurationMs: 50,
      totalBytes: 200,
      profilerSpanWriteCount: 1,
      profilerSpanWriteDurationMs: 10,
    },
    warnings: [],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
