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
    })

    const report = await buildSweBenchAnalysis({
      runId: "unit-run",
      runRoot,
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
  },
): Promise<void> {
  const reportDir = join(runRoot, "matrix", "jobs", input.jobId, "report")
  const artifactDir = join(reportDir, "instances", input.instanceId)
  const agentDir = join(artifactDir, "agent")
  await mkdir(agentDir, { recursive: true })
  await writeJson(join(reportDir, "provider.profile.json"), providerProfileFixture(input.requests, input.tokens))
  await writeJson(join(agentDir, "wrapper.profile.json"), wrapperProfileFixture(input.coderId, input.instanceId, join(artifactDir, "patch.diff")))
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
      },
    ],
  })
}

function providerProfileFixture(requestCount: number, totalTokens: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
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

function wrapperProfileFixture(coderId: string, instanceId: string, patchPath: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    wrapper: { id: coderId, displayName: coderId, runtime: "unit-test" },
    process: { exitCode: 0, durationMs: 1000 },
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
