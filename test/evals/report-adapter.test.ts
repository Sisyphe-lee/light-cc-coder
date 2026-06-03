import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { validateWrapperProfile } from "../../evals/wrapper-profile/validate"
import { createTempWorkspace } from "../helpers"

describe("unified eval report adapter", () => {
  test("generates markdown, JSON, failures JSONL, and cost reports", async () => {
    const root = await createTempWorkspace()
    const evalRoot = join(root, ".light-cc", "evals")
    const runId = "report-mixed"
    const runDir = join(evalRoot, runId)
    await mkdir(join(runDir, "swebench"), { recursive: true })
    await mkdir(join(runDir, "terminal-bench"), { recursive: true })

    await writeJson(join(runDir, "swebench", "summary.json"), {
      runId,
      status: "completed",
      mode: { dryRun: false, runAgent: true, evaluate: false },
      totals: { selected: 2, prepared: 0, completed: 2, failed: 0, skipped: 0, emptyPatch: 1 },
      usage: { requests: 2, inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      cost: {
        currency: "USD",
        totalUsd: 0.0123,
        pricing: { source: "unit test pricing" },
      },
      results: [
        {
          instanceId: "django__django-1",
          status: "completed",
          artifactDir: join(runDir, "swebench", "instances", "django__django-1"),
          prediction: { model_patch: "diff --git a/file b/file\n" },
          profile: profileFixture(join(runDir, "swebench", "instances", "django__django-1", "agent", "profile.report.json"), "provider"),
          wrapperProfile: wrapperProfileFixture({
            wrapperId: "lightcc",
            benchmark: "swebench",
            runId,
            itemId: "django__django-1",
            artifactPath: join(runDir, "swebench", "instances", "django__django-1", "agent", "patch.diff"),
          }),
        },
        {
          instanceId: "sympy__sympy-2",
          status: "completed",
          artifactDir: join(runDir, "swebench", "instances", "sympy__sympy-2"),
          prediction: { model_patch: "" },
          wrapperProfile: {
            ...wrapperProfileFixture({
              wrapperId: "external-coder",
              benchmark: "swebench",
              runId,
              itemId: "sympy__sympy-2",
              artifactPath: join(runDir, "swebench", "instances", "sympy__sympy-2", "agent", "patch.diff"),
            }),
            args: ["--prompt", "raw prompt should not be stored"],
          },
        },
      ],
    })

    const terminalWrapperProfilePath = join(runDir, "terminal-bench", "tasks", "pass", "agent", "wrapper.profile.json")
    await mkdir(join(runDir, "terminal-bench", "tasks", "pass", "agent"), { recursive: true })
    await writeJson(
      terminalWrapperProfilePath,
      wrapperProfileFixture({
        wrapperId: "opencode",
        benchmark: "terminal-bench",
        runId,
        itemId: "terminal-bench/pass",
        artifactPath: join(runDir, "terminal-bench", "tasks", "pass", "agent", "patch.diff"),
      }),
    )

    await writeJson(join(runDir, "terminal-bench", "summary.json"), {
      runId,
      mode: { dryRun: false, runHarbor: true },
      totals: { selected: 2, prepared: 0, completed: 1, failed: 1 },
      tasks: [
        { taskId: "terminal-bench/pass", status: "completed", artifactDir: join(runDir, "terminal-bench", "tasks", "pass") },
        {
          taskId: "terminal-bench/fail",
          status: "failed",
          error: "tests failed",
          artifactDir: join(runDir, "terminal-bench", "tasks", "fail"),
        },
      ],
      harborJob: { costUsd: 0.45 },
      profileReports: [profileFixture(join(runDir, "terminal-bench", "jobs", "job", "trial", "agent", "profile.report.json"), "runtime")],
    })

    const result = await runReport(["--run-id", runId, "--eval-root", evalRoot])

    expect(result.exitCode).toBe(0)
    const reportDir = join(runDir, "report")
    expect(existsSync(join(reportDir, "report.md"))).toBe(true)
    expect(existsSync(join(reportDir, "report.zh-CN.md"))).toBe(true)
    expect(existsSync(join(reportDir, "report.json"))).toBe(true)
    expect(existsSync(join(reportDir, "failures.jsonl"))).toBe(true)
    expect(existsSync(join(reportDir, "cost.json"))).toBe(true)

    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as {
      totals: {
        benchmarksPresent: number
        benchmarksMissing: number
        failureRecords: number
        knownCostUsd: number
        profiledItems: number
        missingProfileItems: number
        profileCoverage: {
          itemCount: number
          wrapper: { coveredItems: number; missingItems: number; invalidItems: number }
          internal: { coveredItems: number; missingItems: number }
          provider: { coveredItems: number; missingItems: number }
        }
      }
      benchmarks: Array<{
        benchmark: string
        profile?: { profiledItemCount: number; missingProfileItemCount: number; provider: { callCount: number } }
        profileCoverage: {
          wrapper: { coveredItems: number; missingItems: number; invalidItems: number }
          internal: { coveredItems: number; missingItems: number }
          provider: { coveredItems: number; missingItems: number }
        }
      }>
      failures: Array<{ benchmark: string; itemId: string; failureType: string }>
    }
    expect(report.totals.benchmarksPresent).toBe(2)
    expect(report.totals.benchmarksMissing).toBe(0)
    expect(report.totals.failureRecords).toBe(2)
    expect(report.totals.knownCostUsd).toBe(0.4623)
    expect(report.totals.profiledItems).toBe(2)
    expect(report.totals.missingProfileItems).toBe(2)
    expect(report.totals.profileCoverage).toMatchObject({
      itemCount: 4,
      wrapper: { coveredItems: 2, missingItems: 2, invalidItems: 1 },
      internal: { coveredItems: 2, missingItems: 2 },
      provider: { coveredItems: 2, missingItems: 2 },
    })
    expect(report.benchmarks.find((benchmark) => benchmark.benchmark === "swebench")?.profile).toMatchObject({
      profiledItemCount: 1,
      missingProfileItemCount: 1,
      provider: { callCount: 2 },
    })
    expect(report.benchmarks.find((benchmark) => benchmark.benchmark === "swebench")?.profileCoverage.wrapper).toMatchObject({
      coveredItems: 1,
      missingItems: 1,
      invalidItems: 1,
    })
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        benchmark: "swebench",
        itemId: "sympy__sympy-2",
        failureType: "empty_patch",
      }),
    )
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        benchmark: "terminal-bench",
        itemId: "terminal-bench/fail",
        failureType: "model_failure",
      }),
    )

    const failures = (await readFile(join(reportDir, "failures.jsonl"), "utf8")).trim().split(/\r?\n/)
    expect(failures).toHaveLength(2)
    const cost = JSON.parse(await readFile(join(reportDir, "cost.json"), "utf8")) as { totalUsd: number }
    expect(cost.totalUsd).toBe(0.4623)
    const markdown = await readFile(join(reportDir, "report.md"), "utf8")
    expect(markdown).toContain("Unified Eval Report")
    expect(markdown).toContain("Profile Coverage")
    expect(markdown).toContain("Profiling")
    expect(markdown).toContain("provider (1)")
    expect(markdown).toContain("empty_patch")
    const zhMarkdown = await readFile(join(reportDir, "report.zh-CN.md"), "utf8")
    expect(zhMarkdown).toContain("统一评测报告")
    expect(zhMarkdown).toContain("Profile 覆盖率")
  })

  test("handles missing benchmark summaries without failing", async () => {
    const root = await createTempWorkspace()
    const evalRoot = join(root, ".light-cc", "evals")
    const runId = "report-missing"

    const result = await runReport(["--run-id", runId, "--eval-root", evalRoot])

    expect(result.exitCode).toBe(0)
    const reportDir = join(evalRoot, runId, "report")
    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as {
      totals: { benchmarksPresent: number; benchmarksMissing: number; failureRecords: number; knownCostUsd: null }
      benchmarks: Array<{ benchmark: string; status: string }>
    }
    expect(report.totals.benchmarksPresent).toBe(0)
    expect(report.totals.benchmarksMissing).toBe(2)
    expect(report.totals.failureRecords).toBe(0)
    expect(report.totals.knownCostUsd).toBeNull()
    expect(report.benchmarks.map((benchmark) => benchmark.status)).toEqual(["missing", "missing"])
    expect(await readFile(join(reportDir, "failures.jsonl"), "utf8")).toBe("")
    expect(await readFile(join(reportDir, "report.md"), "utf8")).toContain("Missing Inputs")
    expect(await readFile(join(reportDir, "report.zh-CN.md"), "utf8")).toContain("缺少输入")
  })

  test("aggregates matrix SWE-bench jobs into a Chinese report with profile coverage by coder", async () => {
    const root = await createTempWorkspace()
    const matrixDir = join(root, "matrix")
    const runId = "matrix-swe-20x4"
    const coders = ["lightcc", "openhands", "aider", "opencode"]
    const tasks = Array.from({ length: 20 }, (_, index) => `repo__case-${index + 1}`)
    const jobs: Array<Record<string, unknown>> = []
    let index = 0

    for (const coderId of coders) {
      for (const taskId of tasks) {
        index += 1
        const jobId = `${String(index).padStart(3, "0")}-${coderId}-${taskId}`
        const jobDir = join(matrixDir, "jobs", jobId)
        const reportDir = join(jobDir, "report")
        const artifactDir = join(reportDir, "instances", taskId)
        const agentDir = join(artifactDir, "agent")
        const providerProfilePath = join(reportDir, "provider.profile.json")
        const wrapperProfilePath = join(agentDir, "wrapper.profile.json")
        await mkdir(agentDir, { recursive: true })
        await writeJson(providerProfilePath, providerProfileFixture())
        await writeJson(
          wrapperProfilePath,
          wrapperProfileFixture({
            wrapperId: coderId,
            benchmark: "swebench",
            runId: `${runId}-${jobId}`,
            itemId: taskId,
            artifactPath: join(artifactDir, "patch.diff"),
          }),
        )
        await writeJson(join(reportDir, "summary.json"), {
          runId: `${runId}-${jobId}`,
          status: "completed",
          mode: { dryRun: false, runAgent: true, evaluate: false, agentProfile: coderId === "lightcc" },
          coder: { id: coderId, status: "ready" },
          totals: { selected: 1, prepared: 0, completed: 1, failed: 0, skipped: 0, emptyPatch: 0 },
          cost: { currency: "USD", totalUsd: 0.001 },
          results: [
            {
              instanceId: taskId,
              status: "completed",
              artifactDir,
              prediction: { model_patch: "diff --git a/file b/file\n" },
              wrapperProfilePath,
              ...(coderId === "lightcc" ? { profile: profileFixture(join(agentDir, "profile.report.json"), "provider") } : {}),
            },
          ],
        })
        jobs.push({
          id: jobId,
          index,
          coderId,
          coderStatus: "ready",
          benchmark: "swebench",
          taskId,
          runId: `${runId}-${jobId}`,
          reportDir,
          artifactDir: jobDir,
          status: "completed",
          providerProfilePath,
        })
      }
    }

    await writeJson(join(matrixDir, "summary.json"), {
      schemaVersion: 1,
      status: "completed",
      mode: "run",
      runId,
      reportDir: matrixDir,
      totals: { jobs: jobs.length, completed: jobs.length, failed: 0, draftJobs: 0 },
      jobs,
      warnings: [],
    })

    const result = await runReport(["--run-dir", matrixDir])

    expect(result.exitCode).toBe(0)
    const reportDir = join(matrixDir, "report")
    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as {
      totals: {
        selected: number
        completed: number
        profileCoverage: {
          itemCount: number
          wrapper: { coveredItems: number; missingItems: number }
          provider: { coveredItems: number; missingItems: number }
          internal: { coveredItems: number; missingItems: number }
        }
      }
      benchmarks: Array<{
        benchmark: string
        matrix?: { coderCount: number; taskCount: number; jobCount: number; coders: Array<{ coderId: string; selected: number; profileCoverage: { internal: { coveredItems: number } } }> }
      }>
    }
    expect(report.totals.selected).toBe(80)
    expect(report.totals.completed).toBe(80)
    expect(report.totals.profileCoverage).toMatchObject({
      itemCount: 80,
      wrapper: { coveredItems: 80, missingItems: 0 },
      provider: { coveredItems: 80, missingItems: 0 },
      internal: { coveredItems: 20, missingItems: 60 },
    })
    const swebench = report.benchmarks.find((benchmark) => benchmark.benchmark === "swebench")
    expect(swebench?.matrix).toMatchObject({ coderCount: 4, taskCount: 20, jobCount: 80 })
    expect(swebench?.matrix?.coders).toHaveLength(4)
    expect(swebench?.matrix?.coders.find((coder) => coder.coderId === "lightcc")).toMatchObject({
      selected: 20,
      profileCoverage: { internal: { coveredItems: 20 } },
    })
    expect(swebench?.matrix?.coders.find((coder) => coder.coderId === "aider")).toMatchObject({
      selected: 20,
      profileCoverage: { internal: { coveredItems: 0 } },
    })
    const zhMarkdown = await readFile(join(reportDir, "report.zh-CN.md"), "utf8")
    expect(zhMarkdown).toContain("Matrix 明细")
    expect(zhMarkdown).toContain("4 路 coder，20 个任务，80 个 job")
    expect(zhMarkdown).toContain("| lightcc | 20 | 20 | 0 | 0 | 20/20")
  })

  test("validates wrapper.profile.json as bounded metadata without raw payloads", () => {
    const valid = wrapperProfileFixture({
      wrapperId: "aider",
      benchmark: "swebench",
      runId: "schema-test",
      itemId: "repo__repo-1",
      artifactPath: "/tmp/artifacts/patch.diff",
    })
    expect(validateWrapperProfile(valid).ok).toBe(true)

    const invalid = {
      ...valid,
      prompt: "raw prompt",
      stdout: "raw stdout",
      stderr: "raw stderr",
      patch: "diff --git a/file b/file",
      command: {
        ...(valid.command as Record<string, unknown>),
        args: ["--message", "raw prompt"],
      },
      environment: {
        ...(valid.environment as Record<string, unknown>),
        values: { OPENAI_API_KEY: "secret" },
      },
    }
    const validation = validateWrapperProfile(invalid)
    expect(validation.ok).toBe(false)
    expect(validation.errors.join("\n")).toContain("raw payload field is not allowed")
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function profileFixture(reportPath: string, topBottleneck: string): Record<string, unknown> {
  return {
    reportPath,
    sourceTranscript: reportPath.replace(/profile\.report\.json$/, "transcript.jsonl"),
    observedDurationMs: 1234,
    profileSpanCount: 12,
    topBottleneck,
    provider: {
      callCount: 2,
      totalDurationMs: 900,
      firstTokenMsP50: 100,
      streamMsP50: 300,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 800,
    },
    context: {
      assembleCount: 2,
      totalDurationMs: 40,
      maxEstimatedTokens: 5000,
    },
    runtime: {
      bashCount: 3,
      durationMsP50: 10,
      durationMsMax: 50,
      nonzeroExitCount: 0,
    },
    transcriptWrite: {
      writeCount: 20,
      totalDurationMs: 6,
      profilerSpanWriteCount: 12,
      profilerSpanWriteDurationMs: 2,
    },
    topSlowSpans: [],
    warnings: [],
  }
}

function wrapperProfileFixture(input: {
  wrapperId: string
  benchmark: string
  runId: string
  itemId: string
  artifactPath: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-02T00:00:00.000Z",
    wrapper: {
      id: input.wrapperId,
      displayName: input.wrapperId,
      runtime: "eval-wrapper",
    },
    run: {
      benchmark: input.benchmark,
      runId: input.runId,
      itemId: input.itemId,
      attempt: 0,
    },
    command: {
      executablePath: "/usr/bin/env",
      cwd: "/workspace",
      argCount: 5,
      argsSha256: hex("a"),
    },
    artifacts: [
      {
        kind: "patch",
        path: input.artifactPath,
        bytes: 12,
        sha256: hex("b"),
      },
    ],
    environment: {
      requiredNames: ["OPENAI_API_KEY"],
      forwardedNames: ["OPENAI_API_KEY"],
      presentNames: ["OPENAI_API_KEY"],
      missingNames: [],
    },
    process: {
      exitCode: 0,
      durationMs: 123,
    },
    warnings: [],
  }
}

function providerProfileFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "metadata-only-provider-proxy",
    startedAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:01.000Z",
    privacy: {
      prompt: "not_recorded",
      response: "not_recorded",
      apiKey: "not_recorded",
    },
    proxy: {
      listenHost: "127.0.0.1",
      port: 8787,
      upstreamBaseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-v4-flash",
    },
    totals: {
      requestCount: 1,
      successCount: 1,
      errorCount: 0,
      retryableErrorCount: 0,
      totalLatencyMs: 100,
      averageLatencyMs: 100,
      averageFirstTokenMs: 50,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      cost: { estimatedUsd: null, currency: "USD", source: "not_configured" },
    },
    requests: [],
    warnings: [],
  }
}

function hex(char: string): string {
  return char.repeat(64)
}

async function runReport(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "evals/report/run.ts", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}
