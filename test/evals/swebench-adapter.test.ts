import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildSweBenchPrompt } from "../../evals/swebench/prompt"
import { checkoutSweBenchRepo } from "../../evals/swebench/run"
import {
  isSweBenchProfile,
  safeInstanceFromRecord,
  SWE_BENCH_DEFAULT_PROFILE,
  SWE_BENCH_DEFAULTS,
  SWE_BENCH_LITE_DEFAULTS,
  SWE_BENCH_PROFILES,
  SWE_BENCH_VERIFIED_DEFAULTS,
  type SweBenchPrediction,
} from "../../evals/swebench/types"
import { createTempWorkspace } from "../helpers"

describe("SWE-bench adapter", () => {
  test("profile defaults use Verified while keeping Lite available", () => {
    expect(SWE_BENCH_DEFAULT_PROFILE).toBe("verified")
    expect(SWE_BENCH_DEFAULTS).toBe(SWE_BENCH_VERIFIED_DEFAULTS)
    expect(SWE_BENCH_PROFILES).toEqual({
      lite: SWE_BENCH_LITE_DEFAULTS,
      verified: SWE_BENCH_VERIFIED_DEFAULTS,
    })
    expect(SWE_BENCH_VERIFIED_DEFAULTS).toMatchObject({
      packageVersion: "swebench==4.1.0",
      datasetName: "SWE-bench/SWE-bench_Verified",
      split: "test",
      datasetRevision: "91aa3ed51b709be6457e12d00300a6a596d4c6a3",
    })
    expect(SWE_BENCH_LITE_DEFAULTS).toMatchObject({
      packageVersion: "swebench==4.1.0",
      datasetName: "SWE-bench/SWE-bench_Lite",
      split: "test",
      datasetRevision: "69611d31007e1c6731db8bd5b5c3f2d33f5bab6e",
    })
    expect(isSweBenchProfile("lite")).toBe(true)
    expect(isSweBenchProfile("verified")).toBe(true)
    expect(isSweBenchProfile("full")).toBe(false)
  })

  test("safeInstanceFromRecord strips hidden evaluator fields before prompt generation", () => {
    const instance = safeInstanceFromRecord({
      instance_id: "sample__repo-1",
      repo: "sample/repo",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Fix the broken add function.",
      patch: "GOLD_PATCH_DO_NOT_LEAK",
      test_patch: "HIDDEN_TEST_DO_NOT_LEAK",
      FAIL_TO_PASS: ["test_secret"],
      PASS_TO_PASS: ["test_regression"],
    })

    const prompt = buildSweBenchPrompt(instance)
    expect(prompt).toContain("SWE-bench issue")
    expect(prompt).not.toContain("SWE-bench Lite issue")
    expect(prompt).toContain("Fix the broken add function.")
    expect(prompt).toContain("sample/repo")
    expect(prompt).not.toContain("GOLD_PATCH_DO_NOT_LEAK")
    expect(prompt).not.toContain("HIDDEN_TEST_DO_NOT_LEAK")
    expect(prompt).not.toContain("test_secret")
    expect(prompt).not.toContain("test_regression")
  })

  test("dry-run writes safe artifacts and official prediction shape", async () => {
    const root = await createTempWorkspace()
    const instancesFile = join(root, "instances.json")
    const reportDir = join(root, "report")
    await writeFile(
      instancesFile,
      JSON.stringify(
        [
          {
            instance_id: "sample__repo-1",
            repo: "sample/repo",
            base_commit: "0123456789abcdef0123456789abcdef01234567",
            problem_statement: "Fix the broken add function.",
            patch: "GOLD_PATCH_DO_NOT_LEAK",
            test_patch: "HIDDEN_TEST_DO_NOT_LEAK",
            FAIL_TO_PASS: ["test_secret"],
            PASS_TO_PASS: ["test_regression"],
          },
        ],
        null,
        2,
      ),
      "utf8",
    )

    const result = await runSweBench([
      "--instances-file",
      instancesFile,
      "--dry-run",
      "--run-id",
      "dry-test",
      "--report-dir",
      reportDir,
      "--model-name",
      "light-cc-coder/test",
    ])

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(reportDir, "summary.json"))).toBe(true)
    expect(existsSync(join(reportDir, "predictions.jsonl"))).toBe(true)

    const prompt = await readFile(join(reportDir, "instances", "sample__repo-1", "prompt.md"), "utf8")
    const instanceJson = await readFile(join(reportDir, "instances", "sample__repo-1", "instance.json"), "utf8")
    const selected = await readFile(join(reportDir, "selected_instances.jsonl"), "utf8")
    const combinedSafeArtifacts = `${prompt}\n${instanceJson}\n${selected}`
    expect(combinedSafeArtifacts).not.toContain("GOLD_PATCH_DO_NOT_LEAK")
    expect(combinedSafeArtifacts).not.toContain("HIDDEN_TEST_DO_NOT_LEAK")
    expect(combinedSafeArtifacts).not.toContain("test_secret")
    expect(combinedSafeArtifacts).not.toContain("test_regression")

    const predictions = (await readFile(join(reportDir, "predictions.jsonl"), "utf8")).trim().split(/\r?\n/)
    expect(predictions).toHaveLength(1)
    const prediction = JSON.parse(predictions[0]) as SweBenchPrediction
    expect(prediction).toEqual({
      instance_id: "sample__repo-1",
      model_name_or_path: "light-cc-coder/test",
      model_patch: "",
    })

    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      mode: { dryRun: boolean }
      coder: { id: string; status: string }
      swebench: { benchmarkProfile: string; datasetName: string; split: string; datasetRevision: string }
      totals: { selected: number; prepared: number; emptyPatch: number }
    }
    expect(summary.mode.dryRun).toBe(true)
    expect(summary.coder).toMatchObject({ id: "lightcc", status: "ready" })
    expect(summary.swebench).toMatchObject({
      benchmarkProfile: "verified",
      datasetName: "SWE-bench/SWE-bench_Verified",
      split: "test",
      datasetRevision: "91aa3ed51b709be6457e12d00300a6a596d4c6a3",
    })
    expect(summary.totals.selected).toBe(1)
    expect(summary.totals.prepared).toBe(1)
    expect(summary.totals.emptyPatch).toBe(1)
  })

  test("dry-run refuses to load the full split without an explicit selector", async () => {
    const root = await createTempWorkspace()
    const result = await runSweBench(["--dry-run", "--report-dir", join(root, "report")])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Refusing to load the full split")
  })

  test("dry-run defaults model name to DeepSeek V4 Flash", async () => {
    const root = await createTempWorkspace()
    const instancesFile = join(root, "instances.json")
    const reportDir = join(root, "report")
    await writeFile(
      instancesFile,
      JSON.stringify([
        {
          instance_id: "sample__repo-1",
          repo: "sample/repo",
          base_commit: "0123456789abcdef0123456789abcdef01234567",
          problem_statement: "Fix the broken add function.",
        },
      ]),
      "utf8",
    )

    const result = await runSweBench(["--instances-file", instancesFile, "--dry-run", "--report-dir", reportDir])

    expect(result.exitCode).toBe(0)
    const predictions = (await readFile(join(reportDir, "predictions.jsonl"), "utf8")).trim().split(/\r?\n/)
    const prediction = JSON.parse(predictions[0]) as SweBenchPrediction
    expect(prediction.model_name_or_path).toBe("lightcc/deepseek-v4-flash")
  })

  test("offline dry-run reads and writes a fixed safe taskset", async () => {
    const root = await createTempWorkspace()
    const tasksetFile = join(root, "taskset.jsonl")
    const exportedTasksetFile = join(root, "exported-taskset.json")
    const reportDir = join(root, "report")
    const safeInstance = {
      instance_id: "sample__repo-1",
      repo: "sample/repo",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Fix the broken add function.",
    }
    await writeFile(
      tasksetFile,
      `${JSON.stringify({ ...safeInstance, patch: "GOLD_PATCH_DO_NOT_LEAK", test_patch: "HIDDEN_TEST_DO_NOT_LEAK" })}\n`,
      "utf8",
    )

    const result = await runSweBench([
      "--taskset-file",
      tasksetFile,
      "--write-taskset-file",
      exportedTasksetFile,
      "--offline",
      "--dry-run",
      "--report-dir",
      reportDir,
    ])

    expect(result.exitCode).toBe(0)
    const reportTaskset = await readFile(join(reportDir, "taskset.jsonl"), "utf8")
    const exportedTaskset = await readFile(exportedTasksetFile, "utf8")
    expect(reportTaskset).toContain("sample__repo-1")
    expect(`${reportTaskset}\n${exportedTaskset}`).not.toContain("GOLD_PATCH_DO_NOT_LEAK")
    expect(`${reportTaskset}\n${exportedTaskset}`).not.toContain("HIDDEN_TEST_DO_NOT_LEAK")
    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      readiness: {
        offline: boolean
        taskset: { source: string; sourceKind: string; selected: number; writePath: string }
      }
    }
    expect(summary.readiness.offline).toBe(true)
    expect(summary.readiness.taskset).toMatchObject({
      source: tasksetFile,
      sourceKind: "instances",
      selected: 1,
      writePath: exportedTasksetFile,
    })
  })

  test("repo cache checkout uses a local mirror in offline mode", async () => {
    const root = await createTempWorkspace()
    const sourceRepo = join(root, "source")
    const repoCacheDir = join(root, "repo-cache")
    const mirrorPath = join(repoCacheDir, "sample__repo.git")
    const workspace = join(root, "workspace", "repo")
    await mkdir(sourceRepo, { recursive: true })
    await mkdir(repoCacheDir, { recursive: true })
    await runGit(["init", sourceRepo])
    await runGit(["-C", sourceRepo, "config", "user.email", "swebench@example.test"])
    await runGit(["-C", sourceRepo, "config", "user.name", "SWE Bench Test"])
    await writeFile(join(sourceRepo, "README.md"), "cached checkout\n", "utf8")
    await runGit(["-C", sourceRepo, "add", "README.md"])
    await runGit(["-C", sourceRepo, "commit", "-m", "initial"])
    const baseCommit = (await runGit(["-C", sourceRepo, "rev-parse", "HEAD"])).stdout.trim()
    await runGit(["clone", "--mirror", sourceRepo, mirrorPath])

    const commands = await checkoutSweBenchRepo(
      {
        instance_id: "sample__repo-1",
        repo: "sample/repo",
        base_commit: baseCommit,
        problem_statement: "Use the cached checkout.",
      },
      workspace,
      { repoCacheDir, offline: true },
    )

    expect(commands.flatMap((command) => command.args).join(" ")).not.toContain("https://github.com")
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("cached checkout\n")
    expect((await runGit(["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(baseCommit)
    expect((await runGit(["-C", workspace, "remote"])).stdout.trim()).toBe("")
  })
})

async function runSweBench(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "evals/swebench/run.ts", ...args], {
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

async function runGit(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
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
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`)
  }
  return { exitCode, stdout, stderr }
}
