import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildSweBenchAnalysis } from "../../evals/report/swebench-analysis"
import { createTempWorkspace } from "../helpers"

describe("SWE-bench analysis failure attribution", () => {
  test("attributes competitor gaps and empty patches from matrix artifacts", async () => {
    const root = await createTempWorkspace()
    const runRoot = join(root, "run")
    const officialLightcc = join(root, "lightcc.json")
    const officialOpencode = join(root, "opencode.json")

    await writeOfficial(officialLightcc, {
      resolved: ["repo__case-2"],
      unresolved: ["repo__case-1"],
      emptyPatch: [],
    })
    await writeOfficial(officialOpencode, {
      resolved: ["repo__case-1"],
      unresolved: [],
      emptyPatch: ["repo__case-2"],
    })

    await writeJob(runRoot, {
      jobId: "001-lightcc-repo__case-1",
      coderId: "lightcc",
      instanceId: "repo__case-1",
      patch: "diff --git a/pkg/core.py b/pkg/core.py\n+fixed\n",
      changedFiles: ["pkg/core.py"],
      patchLines: 3,
      tokens: 30_000,
      requests: 4,
      costUsd: 0.01234567,
      wrapperDurationMs: 10_000,
    })
    await writeJob(runRoot, {
      jobId: "002-lightcc-repo__case-2",
      coderId: "lightcc",
      instanceId: "repo__case-2",
      patch: "diff --git a/pkg/other.py b/pkg/other.py\n+fixed\n",
      changedFiles: ["pkg/other.py"],
      patchLines: 3,
      tokens: 25_000,
      requests: 3,
      costUsd: 0.01,
      wrapperDurationMs: 1_000,
    })
    await writeJob(runRoot, {
      jobId: "003-opencode-repo__case-1",
      coderId: "opencode",
      instanceId: "repo__case-1",
      patch: "diff --git a/pkg/core.py b/pkg/core.py\n+better\n",
      changedFiles: ["pkg/core.py"],
      patchLines: 3,
      tokens: 20_000,
      requests: 2,
      costUsd: 0.02,
    })
    await writeJob(runRoot, {
      jobId: "004-opencode-repo__case-2",
      coderId: "opencode",
      instanceId: "repo__case-2",
      patch: "",
      changedFiles: [],
      patchLines: 0,
      tokens: 12_000,
      requests: 1,
      costUsd: 0.004,
    })

    const report = await buildSweBenchAnalysis({
      runId: "unit-run",
      runRoot,
      extraRunRoots: [],
      outputDir: join(runRoot, "final-report"),
      officialJsons: { lightcc: officialLightcc, opencode: officialOpencode },
      manualAttributionsPath: null,
    })

    expect(report.coverage).toMatchObject({ expectedRows: 4, actualRows: 4 })
    const lightccGap = report.failureAttributions.find((item) => item.coderId === "lightcc" && item.instanceId === "repo__case-1")
    expect(lightccGap?.failureAttribution).toMatchObject({
      category: "lightcc_competitor_gap",
      confidence: "medium",
    })
    expect(lightccGap?.failureAttribution.evidence.join("\n")).toContain("sameInstanceResolvedBy=opencode")

    const emptyPatch = report.failureAttributions.find((item) => item.coderId === "opencode" && item.instanceId === "repo__case-2")
    expect(emptyPatch?.failureAttribution).toMatchObject({
      category: "empty_patch",
      confidence: "high",
    })
    expect(emptyPatch?.failureAttribution.evidence.join("\n")).toContain("patchLines=0")

    const patchGuard = report.actionPriorities.find((item) => item.title === "增加评测 patch 质量 guard")
    expect(patchGuard?.improvementClass).toBe("evaluation_system")
    expect(patchGuard?.implementationModules).toContain("evals/swebench/run.ts")
    expect(patchGuard?.affectedInstances).toContain("repo__case-2")
    expect(patchGuard?.affectedCoders).toContain("opencode")
    expect(patchGuard?.evidence.join("\n")).toContain("empty_patch")

    const resolvedContrast = report.actionPriorities.find((item) => item.title === "失败复盘引入 resolved patch 对照，运行时强化最小复现优先流程")
    expect(resolvedContrast?.improvementClass).toBe("lightcc_improvement")
    expect(resolvedContrast?.implementationModules).toContain("src/loop/runTurn.ts")
    expect(resolvedContrast?.affectedInstances).toContain("repo__case-1")
    expect(resolvedContrast?.affectedCoders).toContain("lightcc")
    expect(resolvedContrast?.nextAction).toContain("resolved changed files")

    const lightccRow = report.rows.find((item) => item.coderId === "lightcc" && item.instanceId === "repo__case-1")
    expect(lightccRow?.provider.estimatedUsd).toBe(0.01234567)
    expect(lightccRow?.provider.costSource).toBe("unit-test pricing")
    const lightccSummary = report.coderSummary.find((item) => item.coderId === "lightcc")
    expect(lightccSummary?.estimatedUsd).toBe(0.022346)
    expect(lightccSummary?.resolvedEstimatedUsd).toBe(0.01)
    expect(lightccSummary?.costPerResolved).toBe(0.01)
    expect(lightccSummary?.resolvedRequestCount).toBe(3)
    expect(lightccSummary?.requestsPerResolved).toBe(3)
    expect(lightccSummary?.resolvedTotalTokens).toBe(25_000)
    expect(lightccSummary?.tokensPerResolved).toBe(25_000)
    expect(lightccSummary?.wrapperDurationMs).toBe(11_000)
    expect(lightccSummary?.resolvedWrapperDurationMs).toBe(1_000)
  })

  test("merges Kimi rows from an extra run root", async () => {
    const root = await createTempWorkspace()
    const baseRunRoot = join(root, "base-run")
    const kimiRunRoot = join(root, "kimi-run")
    const officialLightcc = join(root, "lightcc.json")
    const officialKimi = join(root, "kimi.json")

    await writeOfficial(officialLightcc, {
      resolved: ["repo__case-1"],
      unresolved: ["repo__case-2"],
      emptyPatch: [],
    })
    await writeOfficial(officialKimi, {
      resolved: ["repo__case-2"],
      unresolved: ["repo__case-1"],
      emptyPatch: [],
    })

    await writeJob(baseRunRoot, {
      jobId: "001-lightcc-swebench-repo__case-1",
      coderId: "lightcc",
      instanceId: "repo__case-1",
      patch: "diff --git a/pkg/core.py b/pkg/core.py\n+fixed\n",
      changedFiles: ["pkg/core.py"],
      patchLines: 3,
      tokens: 10_000,
      requests: 1,
    })
    await writeJob(baseRunRoot, {
      jobId: "002-lightcc-swebench-repo__case-2",
      coderId: "lightcc",
      instanceId: "repo__case-2",
      patch: "diff --git a/pkg/other.py b/pkg/other.py\n+fixed\n",
      changedFiles: ["pkg/other.py"],
      patchLines: 3,
      tokens: 11_000,
      requests: 1,
    })
    await writeJob(kimiRunRoot, {
      jobId: "001-kimi-cli-swebench-repo__case-1",
      coderId: "kimi-cli",
      instanceId: "repo__case-1",
      patch: "diff --git a/pkg/core.py b/pkg/core.py\n+try\n",
      changedFiles: ["pkg/core.py"],
      patchLines: 3,
      tokens: 12_000,
      requests: 2,
    })
    await writeJob(kimiRunRoot, {
      jobId: "002-kimi-cli-swebench-repo__case-2",
      coderId: "kimi-cli",
      instanceId: "repo__case-2",
      patch: "diff --git a/pkg/other.py b/pkg/other.py\n+better\n",
      changedFiles: ["pkg/other.py"],
      patchLines: 3,
      tokens: 13_000,
      requests: 2,
    })

    const report = await buildSweBenchAnalysis({
      runId: "unit-run",
      runRoot: baseRunRoot,
      extraRunRoots: [{ coderId: "kimi-cli", path: kimiRunRoot }],
      outputDir: join(root, "final-report"),
      officialJsons: { lightcc: officialLightcc, "kimi-cli": officialKimi },
      manualAttributionsPath: null,
    })

    expect(report.coverage).toMatchObject({ expectedRows: 4, actualRows: 4 })
    expect(report.coderOrder).toEqual(["lightcc", "kimi-cli"])
    expect(report.coderSummary.map((item) => item.coderId)).toEqual(["lightcc", "kimi-cli"])
    expect(report.rows.filter((row) => row.coderId === "kimi-cli")).toHaveLength(2)
    expect(report.rows.find((row) => row.coderId === "kimi-cli" && row.instanceId === "repo__case-2")?.officialOutcome).toBe("resolved")
  })
})

async function writeOfficial(
  path: string,
  input: { resolved: string[]; unresolved: string[]; emptyPatch: string[] },
): Promise<void> {
  const completed = [...input.resolved, ...input.unresolved, ...input.emptyPatch]
  await writeJson(path, {
    total_instances: 2,
    submitted_ids: completed,
    completed_ids: completed,
    resolved_ids: input.resolved,
    unresolved_ids: input.unresolved,
    empty_patch_ids: input.emptyPatch,
    error_ids: [],
    incomplete_ids: [],
  })
}

async function writeJob(
  runRoot: string,
  input: {
    jobId: string
    coderId: string
    instanceId: string
    patch: string
    changedFiles: string[]
    patchLines: number
    tokens: number
    requests: number
    costUsd?: number
    wrapperDurationMs?: number
  },
): Promise<void> {
  const reportDir = join(runRoot, "matrix", "jobs", input.jobId, "report")
  const artifactDir = join(reportDir, "instances", input.instanceId)
  const agentDir = join(artifactDir, "agent")
  await mkdir(agentDir, { recursive: true })
  await writeJson(join(reportDir, "provider.profile.json"), providerProfileFixture(input.requests, input.tokens))
  await writeJson(join(agentDir, "wrapper.profile.json"), wrapperProfileFixture(input.coderId, input.instanceId, join(artifactDir, "patch.diff"), input.wrapperDurationMs))
  await writeJson(join(artifactDir, "instance.json"), {
    instance_id: input.instanceId,
    repo: "repo/example",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
  })
  await writeFile(join(artifactDir, "patch.diff"), input.patch, "utf8")
  await writeFile(join(agentDir, "transcript.jsonl"), "{\"type\":\"turn.ended\",\"reason\":\"completed\"}\n", "utf8")
  await writeJson(join(artifactDir, "metrics.json"), {
    status: "completed",
    patchBytes: input.patch.length,
    patchLines: input.patchLines,
    changedFiles: input.changedFiles,
    emptyPatch: input.patch.length === 0,
    wrapperProfilePath: join(agentDir, "wrapper.profile.json"),
  })
  await writeJson(join(reportDir, "summary.json"), {
    runId: `unit-run-${input.jobId}`,
    status: "completed",
    coder: { id: input.coderId, displayName: input.coderId },
    usage: usageFixture(input.requests, input.tokens),
    cost: input.costUsd === undefined ? undefined : costFixture(input.costUsd),
    results: [
      {
        instanceId: input.instanceId,
        status: "completed",
        artifactDir,
        patchPath: join(artifactDir, "patch.diff"),
        transcriptPath: join(agentDir, "transcript.jsonl"),
        wrapperProfilePath: join(agentDir, "wrapper.profile.json"),
        patchBytes: input.patch.length,
        patchLines: input.patchLines,
        changedFiles: input.changedFiles,
        emptyPatch: input.patch.length === 0,
        usage: usageFixture(input.requests, input.tokens),
        cost: input.costUsd === undefined ? undefined : costFixture(input.costUsd),
      },
    ],
  })
}

function providerProfileFixture(requestCount: number, totalTokens: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    proxy: { model: "deepseek-v4-flash" },
    totals: {
      requestCount,
      successCount: requestCount,
      errorCount: 0,
      retryableErrorCount: 0,
      totalLatencyMs: requestCount * 100,
      averageLatencyMs: 100,
      averageFirstTokenMs: 50,
      usage: {
        inputTokens: Math.max(0, totalTokens - 100),
        outputTokens: Math.min(100, totalTokens),
        totalTokens,
      },
      cost: { estimatedUsd: null, source: "unit-test" },
    },
  }
}

function usageFixture(requests: number, totalTokens: number): Record<string, unknown> {
  return {
    requests,
    inputTokens: Math.max(0, totalTokens - 100),
    outputTokens: Math.min(100, totalTokens),
    totalTokens,
    promptCacheHitTokens: Math.max(0, totalTokens - 200),
    promptCacheMissTokens: Math.min(200, totalTokens),
    reasoningTokens: 0,
  }
}

function costFixture(totalUsd: number): Record<string, unknown> {
  return {
    currency: "USD",
    model: "deepseek-v4-flash",
    inputCacheHitUsd: 0,
    inputCacheMissUsd: 0,
    outputUsd: totalUsd,
    totalUsd,
    pricing: {
      inputCacheHitPer1M: 0.0028,
      inputCacheMissPer1M: 0.14,
      outputPer1M: 0.28,
      source: "unit-test pricing",
    },
  }
}

function wrapperProfileFixture(coderId: string, instanceId: string, patchPath: string, durationMs = 1000): Record<string, unknown> {
  return {
    schemaVersion: 1,
    wrapper: { id: coderId, displayName: coderId, runtime: "unit-test" },
    process: { exitCode: 0, durationMs },
    artifacts: [
      { kind: "patch", path: patchPath },
      { kind: "transcript", path: patchPath.replace(/patch\.diff$/, "agent/transcript.jsonl") },
    ],
    environment: { missingNames: [] },
    warnings: [],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
