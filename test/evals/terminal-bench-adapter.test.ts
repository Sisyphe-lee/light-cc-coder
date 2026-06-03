import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TERMINAL_BENCH_DEFAULTS, safeTaskId } from "../../evals/terminal-bench/types"
import { createTempWorkspace } from "../helpers"

describe("Terminal-Bench adapter", () => {
  test("safeTaskId accepts normal task ids and rejects path-like surprises", () => {
    expect(safeTaskId("openssl-selfsigned-cert")).toBe("openssl-selfsigned-cert")
    expect(safeTaskId("terminal-bench/adaptive-rejection-sampler")).toBe("terminal-bench/adaptive-rejection-sampler")
    expect(() => safeTaskId("../secret")).toThrow("Invalid Terminal-Bench task id")
    expect(() => safeTaskId("-danger")).toThrow("Invalid Terminal-Bench task id")
  })

  test("dry-run writes Harbor command and artifact contract", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "report")
    const result = await runTerminalBench([
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--dry-run",
      "--run-id",
      "tbench-dry-test",
      "--report-dir",
      reportDir,
      "--model",
      "light-cc-coder/test",
      "--base-url",
      "https://api.deepseek.com",
      "--agent-package-spec",
      "file:/workspace/light-cc-coder",
      "--agent-node-dir",
      "/opt/lightcc-node",
      "--agent-env-file",
      "/run/lightcc/deepseek.env",
      "--verifier-proxy",
      "http://127.0.0.1:7897",
      "--verifier-env",
      "UV_HTTP_TIMEOUT=120",
      "--allow-environment-host",
      "github.com",
      "--extra-docker-compose",
      "/tmp/tbench-proxy.yml",
      "--agent-timeout-multiplier",
      "2",
      "--mounts",
      '[{"type":"bind","source":"/host/repo","target":"/opt/light-cc-coder","read_only":true}]',
      "--mounts",
      '[{"type":"bind","source":"/host/node","target":"/opt/lightcc-node","read_only":true}]',
    ])

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(reportDir, "summary.json"))).toBe(true)
    expect(existsSync(join(reportDir, "harbor-command.json"))).toBe(true)
    expect(existsSync(join(reportDir, "tasks", "terminal-bench_break-filter-js-from-html", "task.json"))).toBe(true)
    expect(existsSync(join(reportDir, "tasks", "terminal-bench_break-filter-js-from-html", "metrics.json"))).toBe(true)

    const command = JSON.parse(await readFile(join(reportDir, "harbor-command.json"), "utf8")) as {
      args: string[]
      env: Record<string, string>
    }
    expect(command.args).toContain("run")
    expect(command.args).toContain("-d")
    expect(command.args).toContain(TERMINAL_BENCH_DEFAULTS.datasetName)
    expect(command.args).toContain("--agent-import-path")
    expect(command.args).toContain(TERMINAL_BENCH_DEFAULTS.agentImportPath)
    expect(command.args).toContain("--job-name")
    expect(command.args).toContain("tbench-dry-test")
    expect(command.args).toContain("-i")
    expect(command.args).toContain("terminal-bench/break-filter-js-from-html")
    expect(command.args).toContain("-k")
    expect(command.args).toContain("1")
    expect(command.args).toContain("--allow-agent-host")
    expect(command.args).toContain("api.deepseek.com")
    expect(command.args).toContain("--allow-environment-host")
    expect(command.args).toContain("github.com")
    expect(command.args).toContain("127.0.0.1")
    expect(command.args).toContain("--verifier-env")
    expect(command.args).toContain("HTTP_PROXY=http://127.0.0.1:7897")
    expect(command.args).toContain("HTTPS_PROXY=http://127.0.0.1:7897")
    expect(command.args).toContain("NO_PROXY=localhost,127.0.0.1,::1")
    expect(command.args).toContain("UV_HTTP_TIMEOUT=120")
    expect(command.args).toContain("--extra-docker-compose")
    expect(command.args).toContain("/tmp/tbench-proxy.yml")
    expect(command.args).toContain("--agent-timeout-multiplier")
    expect(command.args).toContain("2")
    expect(command.args).toContain("--mounts")
    const mountsIndex = command.args.indexOf("--mounts")
    expect(mountsIndex).toBeGreaterThan(-1)
    const mounts = JSON.parse(command.args[mountsIndex + 1] ?? "[]") as Array<Record<string, unknown>>
    expect(mounts).toContainEqual({ type: "bind", source: "/host/repo", target: "/opt/light-cc-coder", read_only: true })
    expect(mounts).toContainEqual({ type: "bind", source: "/host/node", target: "/opt/lightcc-node", read_only: true })
    expect(command.env.LIGHT_CC_TBENCH_NPM_SPEC).toBe("file:/workspace/light-cc-coder")
    expect(command.env.LIGHT_CC_TBENCH_NODE_DIR).toBe("/opt/lightcc-node")
    expect(command.env.LIGHT_CC_TBENCH_ENV_FILE).toBe("/run/lightcc/deepseek.env")
    expect(command.env.LIGHT_CC_TBENCH_OS_SANDBOX).toBe("off")
    expect(command.env.LIGHT_CC_TBENCH_CODER_ID).toBe("lightcc")
    expect(command.env.LIGHT_CC_TBENCH_CODER_STATUS).toBe("ready")
    expect(command.env.LIGHT_CC_TBENCH_CODER_MODEL).toBe("light-cc-coder/test")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUNTIME).toBe("lightcc-installed-agent")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUN_STATUS).toBe("ready")
    expect(command.env.LIGHT_CC_TBENCH_WORKSPACE).toBe("/workspace")
    expect(command.env.LIGHT_CC_TBENCH_ARTIFACT_DIR).toBe("/logs/agent")
    expect(command.env.LIGHT_CC_TBENCH_PROMPT_FILE).toBe("/logs/agent/prompt.md")
    expect(command.env.LIGHT_CC_TBENCH_TRANSCRIPT_PATH).toBe("/logs/agent/transcript.jsonl")
    expect(command.env.LIGHT_CC_MODEL).toBe("light-cc-coder/test")
    expect(command.env.LIGHT_CC_TBENCH_PROVIDER_BASE_URL).toBe("https://api.deepseek.com")

    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      mode: { dryRun: boolean; runHarbor: boolean }
      coder: { id: string; status: string; model: string; runtime: string; runStatus: string }
      totals: { selected: number; prepared: number }
    }
    expect(summary.mode.dryRun).toBe(true)
    expect(summary.mode.runHarbor).toBe(false)
    expect(summary.coder).toMatchObject({
      id: "lightcc",
      status: "ready",
      model: "light-cc-coder/test",
      runtime: "lightcc-installed-agent",
      runStatus: "ready",
    })
    expect(summary.totals.selected).toBe(1)
    expect(summary.totals.prepared).toBe(1)
  })

  test("dry-run marks built-in external coders as unverified until smoke is explicit", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "report")
    const result = await runTerminalBench([
      "--coder",
      "aider",
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--dry-run",
      "--report-dir",
      reportDir,
      "--model",
      "external/model",
      "--agent-profile",
    ])

    expect(result.exitCode).toBe(0)
    const command = JSON.parse(await readFile(join(reportDir, "harbor-command.json"), "utf8")) as { env: Record<string, string> }
    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      mode: { agentProfile: boolean }
      coder: { id: string; runtime: string; runStatus: string }
    }
    expect(command.env.LIGHT_CC_TBENCH_CODER_ID).toBe("aider")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUNTIME).toBe("planned-external-installed-agent")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUN_STATUS).toBe("dry-run-only")
    expect(command.env.LIGHT_CC_TBENCH_AGENT_PROFILE).toBe("1")
    expect(summary.mode.agentProfile).toBe(true)
    expect(summary.coder).toMatchObject({ id: "aider", runtime: "planned-external-installed-agent", runStatus: "dry-run-only" })
  })

  test("explicit unverified runtime flag prepares external installed-agent smoke", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "report")
    const result = await runTerminalBench([
      "--coder",
      "aider",
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--dry-run",
      "--report-dir",
      reportDir,
      "--model",
      "external/model",
      "--allow-unverified-runtime",
    ])

    expect(result.exitCode).toBe(0)
    const command = JSON.parse(await readFile(join(reportDir, "harbor-command.json"), "utf8")) as { env: Record<string, string> }
    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      coder: { id: string; runtime: string; runStatus: string }
    }
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUNTIME).toBe("external-installed-agent")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUN_STATUS).toBe("smoke-unverified")
    expect(summary.coder).toMatchObject({ id: "aider", runtime: "external-installed-agent", runStatus: "smoke-unverified" })
  })

  test("mounted external runtime auto adds a read-only runtime mount and provider profile path", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "report")
    const providerProfilePath = join(reportDir, "provider.profile.json")
    const result = await runTerminalBench([
      "--coder",
      "opencode",
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--dry-run",
      "--report-dir",
      reportDir,
      "--model",
      "external/model",
      "--allow-unverified-runtime",
      "--external-install-mode",
      "mounted",
      "--external-host-dir",
      "/host/runtime",
      "--external-container-bin-dir",
      "/container/runtime/bin",
      "--external-run-timeout-seconds",
      "900",
      "--provider-profile-path",
      providerProfilePath,
    ])

    expect(result.exitCode).toBe(0)
    const command = JSON.parse(await readFile(join(reportDir, "harbor-command.json"), "utf8")) as {
      args: string[]
      env: Record<string, string>
    }
    const mountsIndex = command.args.indexOf("--mounts")
    expect(mountsIndex).toBeGreaterThan(-1)
    const mounts = JSON.parse(command.args[mountsIndex + 1] ?? "[]") as Array<Record<string, unknown>>
    expect(mounts).toContainEqual({ type: "bind", source: "/host/runtime", target: "/container/runtime", read_only: true })
    expect(command.env.LIGHT_CC_TBENCH_EXTERNAL_INSTALL_MODE).toBe("mounted")
    expect(command.env.LIGHT_CC_TBENCH_EXTERNAL_BIN_DIR).toBe("/container/runtime/bin")
    expect(command.env.LIGHT_CC_TBENCH_EXTERNAL_RUN_TIMEOUT_SECONDS).toBe("900")

    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      providerProfilePaths: string[]
      coder: { id: string; runtime: string; runStatus: string }
    }
    expect(summary.providerProfilePaths).toEqual([providerProfilePath])
    expect(summary.coder).toMatchObject({ id: "opencode", runtime: "external-installed-agent", runStatus: "smoke-unverified" })
  })

  test("dry-run writes planning metadata for path-loaded external coders without leaking secrets", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "report")
    const result = await runTerminalBench(
      [
        "--coder",
        "evals/adapters/coders/drafts/aider.json",
        "--task",
        "terminal-bench/break-filter-js-from-html",
        "--dry-run",
        "--report-dir",
        reportDir,
        "--model",
        "external/model",
        "--api-key-env",
        "TBENCH_SECRET_KEY",
      ],
      { TBENCH_SECRET_KEY: "super-secret-tbench-value" },
    )

    expect(result.exitCode).toBe(0)
    const commandText = await readFile(join(reportDir, "harbor-command.json"), "utf8")
    const runText = await readFile(join(reportDir, "run.json"), "utf8")
    const summaryText = await readFile(join(reportDir, "summary.json"), "utf8")
    const command = JSON.parse(commandText) as { env: Record<string, string> }
    const summary = JSON.parse(summaryText) as {
      coder: { id: string; status: string; model: string; runtime: string; runStatus: string }
    }

    expect(command.env.LIGHT_CC_TBENCH_CODER_ID).toBe("aider")
    expect(command.env.LIGHT_CC_TBENCH_CODER_STATUS).toBe("ready")
    expect(command.env.LIGHT_CC_TBENCH_CODER_MODEL).toBe("external/model")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUNTIME).toBe("planned-external-installed-agent")
    expect(command.env.LIGHT_CC_TBENCH_CODER_RUN_STATUS).toBe("dry-run-only")
    expect(command.env.LIGHT_CC_API_KEY_ENV).toBe("TBENCH_SECRET_KEY")
    expect(summary.coder).toMatchObject({
      id: "aider",
      status: "ready",
      model: "external/model",
      runtime: "planned-external-installed-agent",
      runStatus: "dry-run-only",
    })
    expect(commandText).not.toContain("super-secret-tbench-value")
    expect(runText).not.toContain("super-secret-tbench-value")
    expect(summaryText).not.toContain("super-secret-tbench-value")
  })

  test("run rejects draft and unverified external coder adapters", async () => {
    const root = await createTempWorkspace()
    const draftResult = await runTerminalBench([
      "--coder",
      "deepseek-reasonix",
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--run",
      "--report-dir",
      join(root, "draft-report"),
    ])

    expect(draftResult.exitCode).toBe(1)
    expect(draftResult.stderr).toContain("Coder adapter deepseek-reasonix is draft; real --run requires a ready adapter")

    const readyExternalPath = join(root, "ready-external.json")
    await writeFile(
      readyExternalPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "ready-external",
          displayName: "Ready External",
          status: "ready",
          targets: ["terminal-bench"],
          install: { kind: "custom" },
          command: { executable: "ready-external", args: [] },
        },
        null,
        2,
      ),
      "utf8",
    )

    const readyExternalResult = await runTerminalBench([
      "--coder",
      readyExternalPath,
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--run",
      "--report-dir",
      join(root, "ready-external-report"),
    ])

    expect(readyExternalResult.exitCode).toBe(1)
    expect(readyExternalResult.stderr).toContain("verified installed-agent runtimes")
  })

  test("dry-run refuses accidental full split selection", async () => {
    const root = await createTempWorkspace()
    const result = await runTerminalBench(["--dry-run", "--report-dir", join(root, "report")])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Refusing to run the full Terminal-Bench split")
  })

  test("dry-run accepts a task list file", async () => {
    const root = await createTempWorkspace()
    const tasksFile = join(root, "tasks.txt")
    const reportDir = join(root, "report")
    await writeFile(tasksFile, "terminal-bench/break-filter-js-from-html\nterminal-bench/adaptive-rejection-sampler\n", "utf8")

    const result = await runTerminalBench(["--tasks-file", tasksFile, "--dry-run", "--report-dir", reportDir])

    expect(result.exitCode).toBe(0)
    const selected = await readFile(join(reportDir, "selected_tasks.jsonl"), "utf8")
    expect(selected).toContain("terminal-bench/break-filter-js-from-html")
    expect(selected).toContain("terminal-bench/adaptive-rejection-sampler")
    const command = JSON.parse(await readFile(join(reportDir, "harbor-command.json"), "utf8")) as { args: string[] }
    expect(command.args).toContain("-i")
    expect(command.args).toContain("terminal-bench/break-filter-js-from-html")
    expect(command.args).toContain("terminal-bench/adaptive-rejection-sampler")
    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as { totals: { selected: number } }
    expect(summary.totals.selected).toBe(2)
  })

  test("tbench-20 taskset is agent-safe and metadata hash matches", async () => {
    const tasksetPath = "evals/terminal-bench/tasksets/tbench-20.tasks.txt"
    const metadataPath = "evals/terminal-bench/tasksets/tbench-20.metadata.json"
    const tasksetText = await readFile(tasksetPath, "utf8")
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      taskFileSha256: string
      taskCount: number
    }
    const tasks = tasksetText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)

    expect(tasks).toHaveLength(20)
    expect(new Set(tasks).size).toBe(20)
    for (const task of tasks) {
      expect(task).toMatch(/^terminal-bench\/[A-Za-z0-9_.-]+$/)
      expect(task).not.toMatch(/FAIL_TO_PASS|PASS_TO_PASS|solution|verifier|answer/i)
    }
    expect(metadata.taskCount).toBe(20)
    expect(createHash("sha256").update(tasksetText).digest("hex")).toBe(metadata.taskFileSha256)
  })

  test("dry-run defaults model to DeepSeek V4 Flash", async () => {
    const root = await createTempWorkspace()
    const reportDir = join(root, "report")
    const result = await runTerminalBench([
      "--task",
      "terminal-bench/break-filter-js-from-html",
      "--dry-run",
      "--report-dir",
      reportDir,
    ])

    expect(result.exitCode).toBe(0)
    const command = JSON.parse(await readFile(join(reportDir, "harbor-command.json"), "utf8")) as {
      args: string[]
      env: Record<string, string>
    }
    expect(command.args).toContain("-m")
    expect(command.args).toContain("deepseek-v4-flash")
    expect(command.env.LIGHT_CC_MODEL).toBe("deepseek-v4-flash")
    expect(command.env.LIGHT_CC_TBENCH_CODER_MODEL).toBe("deepseek-v4-flash")
  })
})

async function runTerminalBench(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "evals/terminal-bench/run.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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
