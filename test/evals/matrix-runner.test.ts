import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createMatrixPlan, runMatrix, type MatrixCommandRunner } from "../../evals/matrix/run"
import { createTempWorkspace } from "../helpers"

describe("eval matrix runner", () => {
  test("expands coder x benchmark x task jobs with isolated command contracts", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "matrix")
    const plan = await createMatrixPlan({
      runId: "matrix-plan-test",
      reportDir,
      coders: ["lightcc"],
      benchmarks: ["swebench", "terminal-bench"],
      tasks: {
        swebench: ["sample__repo-1"],
        "terminal-bench": ["terminal-bench/break-filter-js-from-html"],
      },
      swebench: {
        instancesFile: "evals/swebench/fixtures/sample-instance.json",
      },
    })

    expect(plan.mode).toBe("dry-run")
    expect(plan.model).toBe("deepseek-v4-flash")
    expect(plan.totals.jobs).toBe(2)
    expect(plan.totals.draftJobs).toBe(0)

    const swebench = plan.jobs.find((job) => job.benchmark === "swebench")
    const tbench = plan.jobs.find((job) => job.benchmark === "terminal-bench")
    expect(swebench).toBeDefined()
    expect(tbench).toBeDefined()

    expect(swebench?.command.args.slice(0, 4)).toEqual([process.execPath, "run", "eval:swebench", "--"])
    expect(swebench?.command.args).toContain("--dry-run")
    expect(swebench?.command.args).toContain("--work-dir")
    expect(swebench?.command.args).toContain("--instances-file")
    expect(swebench?.reportDir).toContain(join(reportDir, "jobs"))
    expect(swebench?.workDir).toContain(join(reportDir, "work"))

    expect(tbench?.command.args.slice(0, 4)).toEqual([process.execPath, "run", "eval:tbench", "--"])
    expect(tbench?.command.args).toContain("--dry-run")
    expect(tbench?.command.args).toContain("--jobs-dir")
    expect(tbench?.reportDir).toContain(join(reportDir, "jobs"))
    expect(tbench?.workDir).toContain(join(reportDir, "work"))
  })

  test("honors configured concurrency", async () => {
    const root = await createTempWorkspace()
    let active = 0
    let maxActive = 0
    const runner: MatrixCommandRunner = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(20)
      active -= 1
      return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 20 }
    }

    const summary = await runMatrix(
      {
        runId: "matrix-concurrency-test",
        reportDir: join(root, "matrix"),
        coders: ["lightcc"],
        benchmarks: ["terminal-bench"],
        tasks: {
          "terminal-bench": ["task-a", "task-b", "task-c", "task-d"],
        },
        concurrency: 2,
      },
      runner,
    )

    expect(maxActive).toBe(2)
    expect(summary.status).toBe("completed")
    expect(summary.totals.completed).toBe(4)
    expect(existsSync(summary.planPath)).toBe(true)
    expect(existsSync(summary.jobsPath)).toBe(true)
    expect(existsSync(join(summary.reportDir, "summary.json"))).toBe(true)
  })

  test("passes agent profiling only to selected coder ids", async () => {
    const root = await createTempWorkspace()
    const plan = await createMatrixPlan({
      runId: "matrix-profile-coder-test",
      reportDir: join(root, "matrix"),
      coders: ["lightcc", "aider"],
      benchmarks: ["swebench"],
      tasks: {
        swebench: ["sample__repo-1"],
      },
      profileCoders: ["lightcc"],
    })

    const lightcc = plan.jobs.find((job) => job.coderId === "lightcc")
    const aider = plan.jobs.find((job) => job.coderId === "aider")
    expect(plan.profileCoders).toEqual(["lightcc"])
    expect(lightcc?.command.args).toContain("--agent-profile")
    expect(aider?.command.args).not.toContain("--agent-profile")
  })

  test("plans per-job provider proxy without leaking upstream into coder base-url", async () => {
    const root = await createTempWorkspace()
    const plan = await createMatrixPlan({
      runId: "matrix-provider-proxy-test",
      reportDir: join(root, "matrix"),
      mode: "run",
      allowLargeRun: true,
      coders: ["lightcc"],
      benchmarks: ["swebench"],
      tasks: {
        swebench: ["sample__repo-1"],
      },
      swebench: {
        instancesFile: "evals/swebench/fixtures/sample-instance.json",
      },
      providerProxy: {
        upstreamBaseUrl: "https://api.deepseek.com",
      },
    })

    const job = plan.jobs[0]
    expect(job?.command.providerProxy).toMatchObject({
      activate: true,
      listenHost: "127.0.0.1",
      upstreamBaseUrl: "https://api.deepseek.com",
      apiKeyEnv: process.env.LIGHT_CC_API_KEY_ENV ?? "OPENAI_API_KEY",
      model: "deepseek-v4-flash",
    })
    expect(job?.command.providerProxy?.profilePath).toContain("provider.profile.json")
    expect(job?.command.args).not.toContain("https://api.deepseek.com")
    expect(job?.command.args).not.toContain("--base-url")
  })

  test("expands SWE-bench jobs from a safe taskset file", async () => {
    const root = await createTempWorkspace()
    const tasksetPath = join(root, "swe-safe.jsonl")
    await writeFile(
      tasksetPath,
      [
        JSON.stringify({
          instance_id: "sample__repo-1",
          repo: "sample/repo",
          base_commit: "1234567",
          problem_statement: "safe prompt",
        }),
        "",
      ].join("\n"),
      "utf8",
    )

    const plan = await createMatrixPlan({
      runId: "matrix-taskset-test",
      reportDir: join(root, "matrix"),
      coders: ["lightcc"],
      benchmarks: ["swebench"],
      swebench: {
        tasksetFile: tasksetPath,
      },
    })

    expect(plan.totals.jobs).toBe(1)
    expect(plan.jobs[0]?.taskId).toBe("sample__repo-1")
    expect(plan.jobs[0]?.command.args).toContain("--instances-file")
    expect(plan.jobs[0]?.command.args).toContain(tasksetPath)
  })

  test("rejects evaluator-only fields in SWE-bench taskset files", async () => {
    const root = await createTempWorkspace()
    const tasksetPath = join(root, "unsafe.jsonl")
    await writeFile(
      tasksetPath,
      `${JSON.stringify({
        instance_id: "sample__repo-1",
        repo: "sample/repo",
        base_commit: "1234567",
        problem_statement: "safe prompt",
        FAIL_TO_PASS: ["hidden"],
      })}\n`,
      "utf8",
    )

    await expect(
      createMatrixPlan({
        runId: "matrix-unsafe-taskset-test",
        reportDir: join(root, "matrix"),
        coders: ["lightcc"],
        benchmarks: ["swebench"],
        swebench: {
          tasksetFile: tasksetPath,
        },
      }),
    ).rejects.toThrow("evaluator-only fields")
  })

  test("rejects draft coders for real runs unless explicitly allowed", async () => {
    await expect(
      createMatrixPlan({
        runId: "matrix-draft-test",
        mode: "run",
        coders: ["deepseek-reasonix"],
        benchmarks: ["terminal-bench"],
        tasks: {
          "terminal-bench": ["terminal-bench/break-filter-js-from-html"],
        },
      }),
    ).rejects.toThrow("--allow-draft-real")

    const root = await createTempWorkspace()
    const summary = await runMatrix(
      {
        runId: "matrix-draft-allowed-test",
        reportDir: join(root, "matrix"),
        mode: "run",
        allowDraftReal: true,
        coders: ["deepseek-reasonix"],
        benchmarks: ["terminal-bench"],
        tasks: {
          "terminal-bench": ["terminal-bench/break-filter-js-from-html"],
        },
      },
      async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    )

    expect(summary.status).toBe("completed")
    expect(summary.totals.draftJobs).toBe(1)
    expect(summary.warnings).toContain("Coder adapter deepseek-reasonix is draft; real run override enabled")
  })

  test("requires allow-large-run for real matrices above five jobs", async () => {
    const tasks = ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"]
    await expect(
      createMatrixPlan({
        runId: "matrix-large-run-test",
        mode: "run",
        coders: ["lightcc"],
        benchmarks: ["terminal-bench"],
        tasks: {
          "terminal-bench": tasks,
        },
      }),
    ).rejects.toThrow("--allow-large-run")

    const plan = await createMatrixPlan({
      runId: "matrix-large-run-allowed-test",
      mode: "run",
      allowLargeRun: true,
      coders: ["lightcc"],
      benchmarks: ["terminal-bench"],
      tasks: {
        "terminal-bench": tasks,
      },
    })
    expect(plan.totals.jobs).toBe(6)
  })

  test("CLI dry-run invokes existing benchmark scripts and writes matrix artifacts", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "matrix")
    const result = await runMatrixCli([
      "--coder",
      "lightcc",
      "--benchmark",
      "swebench",
      "--benchmark",
      "tbench",
      "--swebench-task",
      "sample__repo-1",
      "--swebench-instances-file",
      "evals/swebench/fixtures/sample-instance.json",
      "--tbench-task",
      "terminal-bench/break-filter-js-from-html",
      "--dry-run",
      "--run-id",
      "matrix-dry-test",
      "--report-dir",
      reportDir,
      "--concurrency",
      "1",
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(existsSync(join(reportDir, "plan.json"))).toBe(true)
    expect(existsSync(join(reportDir, "jobs.jsonl"))).toBe(true)
    expect(existsSync(join(reportDir, "summary.json"))).toBe(true)

    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      mode: string
      totals: { jobs: number; completed: number; failed: number }
      jobs: Array<{ benchmark: string; status: string; reportDir: string }>
    }
    expect(summary.mode).toBe("dry-run")
    expect(summary.totals).toMatchObject({ jobs: 2, completed: 2, failed: 0 })
    expect(summary.jobs.map((job) => job.benchmark).sort()).toEqual(["swebench", "terminal-bench"])
    for (const job of summary.jobs) {
      expect(job.status).toBe("completed")
      expect(existsSync(join(job.reportDir, "summary.json"))).toBe(true)
    }
  })
})

async function runMatrixCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "evals/matrix/run.ts", ...args], {
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
