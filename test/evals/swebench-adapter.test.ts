import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildSweBenchPrompt } from "../../evals/swebench/prompt"
import { safeInstanceFromRecord, type SweBenchPrediction } from "../../evals/swebench/types"
import { createTempWorkspace } from "../helpers"

describe("SWE-bench adapter", () => {
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
      totals: { selected: number; prepared: number; emptyPatch: number }
    }
    expect(summary.mode.dryRun).toBe(true)
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
