import { describe, expect, test } from "bun:test"
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
    expect(command.env.LIGHT_CC_MODEL).toBe("light-cc-coder/test")

    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as {
      mode: { dryRun: boolean; runHarbor: boolean }
      totals: { selected: number; prepared: number }
    }
    expect(summary.mode.dryRun).toBe(true)
    expect(summary.mode.runHarbor).toBe(false)
    expect(summary.totals.selected).toBe(1)
    expect(summary.totals.prepared).toBe(1)
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
    const summary = JSON.parse(await readFile(join(reportDir, "summary.json"), "utf8")) as { totals: { selected: number } }
    expect(summary.totals.selected).toBe(2)
  })
})

async function runTerminalBench(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "evals/terminal-bench/run.ts", ...args], {
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
