import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { buildCoderCommand, loadCoderAdapter, validateCoderAdapter } from "../../evals/adapters/coders/loader"
import { createEvalMatrixPlan } from "../../evals/adapters/planner/plan"
import { runAdapterPreflight } from "../../evals/adapters/preflight/check"
import { validateUnifiedEvalResult } from "../../evals/adapters/results/validate"
import { createTempWorkspace } from "../helpers"

describe("adapter support modules", () => {
  test("fake-coder conformance fixture writes transcript, patch, and unified result", async () => {
    const root = await createTempWorkspace()
    const adapter = await loadCoderAdapter("evals/adapters/testing/fake-coder/fake-coder-adapter.json")
    const command = buildCoderCommand(adapter, {
      executable: process.execPath,
      instruction: "Conformance task",
      workspace: process.cwd(),
      artifactDir: join(root, "agent"),
      transcriptPath: join(root, "agent", "transcript.jsonl"),
      patchPath: join(root, "agent", "patch.diff"),
      resultPath: join(root, "agent", "result.json"),
    })

    const proc = Bun.spawn([command.executable, ...command.args], {
      cwd: command.cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)

    const transcript = await readFile(join(root, "agent", "transcript.jsonl"), "utf8")
    const patch = await readFile(join(root, "agent", "patch.diff"), "utf8")
    const result = validateUnifiedEvalResult(JSON.parse(await readFile(join(root, "agent", "result.json"), "utf8")))
    expect(transcript).toContain("Conformance task")
    expect(patch).toContain("FAKE_RESULT.txt")
    expect(result.benchmark).toBe("adapter-conformance")
    expect(result.passed).toBe(true)
  })

  test("matrix planner expands ready adapters and gates draft adapters", async () => {
    const readyPlan = await createEvalMatrixPlan({
      runId: "planner-test",
      benchmark: "terminal-bench",
      coders: ["lightcc"],
      tasks: ["terminal-bench/break-filter-js-from-html"],
      models: ["deepseek-v4-flash"],
      attempts: 2,
    })

    expect(readyPlan.mode).toBe("dry-run-plan")
    expect(readyPlan.totals.entries).toBe(2)
    expect(readyPlan.totals.draftEntries).toBe(0)
    expect(readyPlan.entries[0].requiredEnv).toEqual(["OPENAI_API_KEY"])

    await expect(
      createEvalMatrixPlan({
        runId: "planner-draft-test",
        benchmark: "terminal-bench",
        coders: ["deepseek-reasonix"],
        tasks: ["terminal-bench/break-filter-js-from-html"],
        models: ["deepseek-v4-flash"],
        attempts: 1,
      }),
    ).rejects.toThrow("Adapter deepseek-reasonix is draft")

    const draftPlan = await createEvalMatrixPlan({
      runId: "planner-draft-test",
      benchmark: "terminal-bench",
      coders: ["deepseek-reasonix"],
      tasks: ["terminal-bench/break-filter-js-from-html"],
      models: ["deepseek-v4-flash"],
      attempts: 1,
      allowDraft: true,
    })
    expect(draftPlan.totals.draftEntries).toBe(1)
    expect(draftPlan.warnings).toContain("Adapter deepseek-reasonix is draft")
  })

  test("adapter preflight checks target support, renderability, and required env", async () => {
    const passChecks = await runAdapterPreflight({
      adapter: "lightcc",
      benchmark: "terminal-bench",
      env: { OPENAI_API_KEY: "set" },
      variables: {
        instruction: "Render only",
        promptFile: "/logs/prompt.md",
        workspace: "/workspace",
        artifactDir: "/logs",
        transcriptPath: "/logs/transcript.jsonl",
        patchPath: "/logs/patch.diff",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "OPENAI_API_KEY",
        maxSteps: "80",
        permissionMode: "danger-full-access",
        osSandbox: "off",
        sandboxSettings: "",
      },
    })
    expect(passChecks.every((check) => check.status !== "fail")).toBe(true)

    const failChecks = await runAdapterPreflight({
      adapter: "lightcc",
      benchmark: "terminal-bench",
      env: {},
      variables: {
        instruction: "Render only",
        promptFile: "/logs/prompt.md",
        workspace: "/workspace",
        artifactDir: "/logs",
        transcriptPath: "/logs/transcript.jsonl",
        patchPath: "/logs/patch.diff",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "OPENAI_API_KEY",
        maxSteps: "80",
        permissionMode: "danger-full-access",
        osSandbox: "off",
        sandboxSettings: "",
      },
    })
    expect(failChecks).toContainEqual({ name: "env.OPENAI_API_KEY", status: "fail", detail: "missing" })
  })

  test("external coder configs are valid and expose expected readiness", async () => {
    const draftsDir = resolve("evals/adapters/coders/drafts")
    const files = (await readdir(draftsDir)).filter((file) => file.endsWith(".json"))
    expect(files).toContain("aider.json")
    const statuses: Record<string, string> = {}
    for (const file of files) {
      const adapter = validateCoderAdapter(JSON.parse(await readFile(join(draftsDir, file), "utf8")), file)
      statuses[adapter.id] = adapter.status
      expect(adapter.targets.length).toBeGreaterThan(0)
    }
    expect(statuses).toMatchObject({
      openhands: "ready",
      aider: "ready",
      opencode: "ready",
      "deepseek-reasonix": "draft",
    })
  })

  test("adapter support modules stay decoupled from benchmark runners", async () => {
    const files = await collectFiles(resolve("evals/adapters"))
    for (const file of files.filter((path) => path.endsWith(".ts"))) {
      const text = await readFile(file, "utf8")
      expect(text).not.toContain("../../terminal-bench/run")
      expect(text).not.toContain("../terminal-bench/run")
      expect(text).not.toContain("../../swebench/run")
      expect(text).not.toContain("../swebench/run")
    }
  })
})

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await collectFiles(path)))
    else result.push(path)
  }
  return result
}
