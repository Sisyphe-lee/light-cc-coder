// Stage 2 live N-run profiling runner (Regime B: real provider / real network).
//
// This is an OPTIONAL developer dogfood tool. It is NOT a benchmark, evaluation,
// leaderboard, or CI gate, and it is deliberately decoupled from the normal
// runtime dependency path: src/ never imports this, and nothing here is required
// for a normal `lightcc` run. See spec/phase-8-stage-2.md.
//
// For each run it spawns the existing CLI as a subprocess with profiling enabled
// and its own transcript, then runs the existing offline reducer to produce one
// stable single-run ProfileReport. Finally it aggregates all included reports into
// a separately-versioned live-runs.summary.json. Runs are serial by default so
// provider rate limits and prompt-cache behavior are not distorted.
//
// Privacy: it captures only bounded timing/counts and high-level errors. It never
// records raw provider payloads, prompt text (beyond passing the provided prompt
// to the CLI), tool output, stdout/stderr bodies, file contents, or credentials.

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { summarizeProfile, type AnyEvent } from "../report/summarize"
import { renderJson } from "../report/renderJson"
import type { ProfileReport } from "../report/types"
import { aggregateLiveRuns, type LiveRunConfigEcho, type LiveRunRecord, type LiveRunsSummary } from "./aggregate"
import { renderLiveRunsSummary } from "./renderSummary"
import { resolveScenario, scenarioNames } from "./scenarios"

const DEFAULT_RUNS = 5
const DEFAULT_RUN_TIMEOUT_MS = 600_000

export type LiveRunOptions = {
  scenario?: string
  promptFile?: string
  cwd: string
  runs: number
  warmup: number
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  maxSteps?: number
  permissionMode?: string
  osSandbox?: string
  outDir: string
  json: boolean
  fake: boolean
  // Override the command used to launch the CLI. Defaults to running the repo
  // source entry with the current runtime (bun). Useful for an installed binary.
  binCommand?: string[]
  timeoutMs: number
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
}

function defaultBinCommand(): string[] {
  return [process.execPath, resolve(repoRoot(), "src", "cli", "main.ts")]
}

export function parseLiveRunArgs(argv: string[]): LiveRunOptions {
  const options: LiveRunOptions = {
    cwd: process.cwd(),
    runs: DEFAULT_RUNS,
    warmup: 0,
    outDir: join(process.cwd(), "profiling-live-runs"),
    json: false,
    fake: false,
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--scenario") options.scenario = requireValue(argv, ++index, arg)
    else if (arg === "--prompt-file") options.promptFile = requireValue(argv, ++index, arg)
    else if (arg === "--cwd") options.cwd = requireValue(argv, ++index, arg)
    else if (arg === "--runs") options.runs = parsePositiveInt(requireValue(argv, ++index, arg), arg)
    else if (arg === "--warmup") options.warmup = parseNonNegativeInt(requireValue(argv, ++index, arg), arg)
    else if (arg === "--model") options.model = requireValue(argv, ++index, arg)
    else if (arg === "--base-url") options.baseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--max-steps") options.maxSteps = parsePositiveInt(requireValue(argv, ++index, arg), arg)
    else if (arg === "--permission-mode") options.permissionMode = requireValue(argv, ++index, arg)
    else if (arg === "--os-sandbox") options.osSandbox = requireValue(argv, ++index, arg)
    else if (arg === "--out-dir") options.outDir = requireValue(argv, ++index, arg)
    else if (arg === "--bin-command") options.binCommand = requireValue(argv, ++index, arg).split(/\s+/).filter(Boolean)
    else if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInt(requireValue(argv, ++index, arg), arg)
    else if (arg === "--json") options.json = true
    else if (arg === "--fake") options.fake = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!options.scenario && !options.promptFile) {
    throw new Error("live runner requires --scenario <name> or --prompt-file <path>")
  }
  if (options.scenario && options.promptFile) {
    throw new Error("specify only one of --scenario or --prompt-file")
  }
  return options
}

type ResolvedRun = {
  prompt: string
  permissionMode?: string
  promptFileAbsolute?: string
}

async function resolvePrompt(options: LiveRunOptions): Promise<ResolvedRun> {
  if (options.scenario) {
    const scenario = resolveScenario(options.scenario)
    if (!scenario) {
      throw new Error(`unknown scenario "${options.scenario}"; known scenarios: ${scenarioNames().join(", ")}`)
    }
    return { prompt: scenario.prompt, permissionMode: options.permissionMode ?? scenario.permissionMode }
  }
  const promptFileAbsolute = resolve(options.promptFile as string)
  const prompt = (await readFile(promptFileAbsolute, "utf8")).trim()
  if (prompt.length === 0) throw new Error(`prompt file ${promptFileAbsolute} is empty`)
  return { prompt, permissionMode: options.permissionMode, promptFileAbsolute }
}

export async function runLive(options: LiveRunOptions): Promise<{ summary: LiveRunsSummary; summaryPath: string }> {
  const resolved = await resolvePrompt(options)
  const outDir = resolve(options.outDir)
  await mkdir(outDir, { recursive: true })

  const binCommand = options.binCommand && options.binCommand.length > 0 ? options.binCommand : defaultBinCommand()
  const totalRuns = options.warmup + options.runs
  const records: LiveRunRecord[] = []

  for (let index = 0; index < totalRuns; index++) {
    const warmup = index < options.warmup
    const label = warmup ? `warmup-${index + 1}` : `run-${index - options.warmup + 1}`
    const transcriptPath = join(outDir, `${label}.transcript.jsonl`)
    const reportPath = join(outDir, `${label}.report.json`)
    if (!options.json) process.stderr.write(`[live] ${label}: starting (serial)\n`)

    const record = await executeOneRun({
      index,
      warmup,
      transcriptPath,
      reportPath,
      prompt: resolved.prompt,
      permissionMode: resolved.permissionMode,
      binCommand,
      options,
    })
    records.push(record)

    if (!options.json) {
      const detail = record.status === "ok" ? `${fmtWall(record.wallClockMs)} wall-clock` : `${record.status}: ${record.error ?? "no detail"}`
      process.stderr.write(`[live] ${label}: ${detail}\n`)
    }
  }

  const config: LiveRunConfigEcho = {
    runsRequested: options.runs,
    warmupRequested: options.warmup,
    model: options.model ?? null,
    baseUrl: options.baseUrl ?? null,
    apiKeyEnv: options.apiKeyEnv ?? null,
    permissionMode: resolved.permissionMode ?? null,
    osSandbox: options.osSandbox ?? null,
    maxSteps: options.maxSteps ?? null,
    cwd: resolve(options.cwd),
    fake: options.fake,
  }

  const summary = aggregateLiveRuns({
    scenario: options.scenario ?? null,
    promptFile: resolved.promptFileAbsolute ?? null,
    runs: records,
    generatedAt: new Date().toISOString(),
    config,
  })

  const summaryPath = join(outDir, "live-runs.summary.json")
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  return { summary, summaryPath }
}

type ExecuteRunInput = {
  index: number
  warmup: boolean
  transcriptPath: string
  reportPath: string
  prompt: string
  permissionMode?: string
  binCommand: string[]
  options: LiveRunOptions
}

async function executeOneRun(input: ExecuteRunInput): Promise<LiveRunRecord> {
  const args = buildCliArgs(input)
  const command = [...input.binCommand, ...args]
  const start = performance.now()
  let spawnResult: { code: number | null; error: Error | null; timedOut: boolean }
  try {
    spawnResult = await runProcess(command[0], command.slice(1), input.options.timeoutMs)
  } catch (error) {
    return failedRecord(input, null, `spawn failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const wallClockMs = round(performance.now() - start)

  if (spawnResult.error) {
    return failedRecord(input, wallClockMs, `spawn failed: ${spawnResult.error.message}`)
  }
  if (spawnResult.timedOut) {
    return failedRecord(input, wallClockMs, `timed out after ${input.options.timeoutMs}ms`)
  }
  if (spawnResult.code !== 0) {
    return failedRecord(input, wallClockMs, `CLI exited with code ${spawnResult.code ?? "null"}`)
  }

  // Reduce the transcript into a single-run ProfileReport using the existing
  // offline reducer. The aggregate later flags reports with no profile.span data.
  let report: ProfileReport
  try {
    const events = await readTranscriptEvents(input.transcriptPath)
    report = summarizeProfile(events, { sourceTranscript: input.transcriptPath, generatedAt: new Date().toISOString() })
  } catch (error) {
    return failedRecord(input, wallClockMs, `report reduction failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await writeFile(input.reportPath, `${renderJson(report)}\n`, "utf8")
  } catch (error) {
    return failedRecord(input, wallClockMs, `report write failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    index: input.index,
    warmup: input.warmup,
    status: "ok",
    wallClockMs,
    transcriptPath: input.transcriptPath,
    reportPath: input.reportPath,
    report,
    error: null,
  }
}

function buildCliArgs(input: ExecuteRunInput): string[] {
  const { options } = input
  const args = ["-p", input.prompt, "--profile", "--transcript", input.transcriptPath, "--cwd", resolve(options.cwd)]
  if (options.fake) args.push("--fake")
  if (options.model) args.push("--model", options.model)
  if (options.baseUrl) args.push("--base-url", options.baseUrl)
  if (options.apiKeyEnv) args.push("--api-key-env", options.apiKeyEnv)
  if (typeof options.maxSteps === "number") args.push("--max-steps", String(options.maxSteps))
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode)
  if (options.osSandbox) args.push("--os-sandbox", options.osSandbox)
  return args
}

function failedRecord(input: ExecuteRunInput, wallClockMs: number | null, error: string): LiveRunRecord {
  return {
    index: input.index,
    warmup: input.warmup,
    status: "failed",
    wallClockMs,
    transcriptPath: input.transcriptPath,
    reportPath: null,
    report: null,
    error,
  }
}

// Spawns a child process, inheriting stdio for stdin/stdout but discarding child
// stdout/stderr capture: we only keep the exit code and timeout state, never the
// output body (privacy red line). The child writes its own transcript to disk.
function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; error: Error | null; timedOut: boolean }> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] })
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProcess({ code: null, error, timedOut })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProcess({ code, error: null, timedOut })
    })
  })
}

async function readTranscriptEvents(path: string): Promise<AnyEvent[]> {
  const content = await readFile(path, "utf8")
  const events: AnyEvent[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as AnyEvent)
    } catch {
      // Tolerate partial/malformed lines; the reducer warns when no spans are found.
    }
  }
  return events
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined) throw new Error(`${flag} requires a value`)
  return value
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative integer`)
  return parsed
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function fmtWall(value: number | null): string {
  return value === null ? "?" : `${value}ms`
}

export function usage(): string {
  return [
    "Optional live N-run profiling (Regime B). NOT a benchmark or CI gate.",
    "",
    "Usage:",
    "  bun profiling/liveRuns/runner.ts --scenario <name> [options]",
    "  bun profiling/liveRuns/runner.ts --prompt-file <path> [options]",
    "",
    `Scenarios: ${scenarioNames().join(", ")}`,
    "",
    "Options:",
    "  --scenario <name>        Named live prompt (see list above).",
    "  --prompt-file <path>     Use the file contents as the prompt.",
    "  --cwd <path>             Workspace root (default: current directory).",
    "  --runs <N>               Measured runs (default: 5).",
    "  --warmup <n>             Warmup runs excluded from statistics (default: 0).",
    "  --model <name>           Provider model.",
    "  --base-url <url>         OpenAI-compatible provider base URL.",
    "  --api-key-env <name>     Environment variable holding the API key.",
    "  --max-steps <n>          Max agent steps per run.",
    "  --permission-mode <mode> read-only | workspace-write | danger-full-access.",
    "  --os-sandbox <mode>      off | auto | required.",
    "  --out-dir <path>         Where transcripts/reports/summary are written.",
    "  --bin-command <cmd>      Override CLI launch command (default: bun src/cli/main.ts).",
    "  --timeout-ms <n>         Per-run timeout (default: 600000).",
    "  --json                   Print the aggregate JSON instead of a human summary.",
    "  --fake                   Use the FakeProvider (smoke test; no real provider).",
  ].join("\n")
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  let options: LiveRunOptions
  try {
    options = parseLiveRunArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  try {
    const { summary, summaryPath } = await runLive(options)
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else {
      process.stdout.write(`${renderLiveRunsSummary(summary)}\n`)
      process.stdout.write(`\nWrote aggregate to ${summaryPath}\n`)
    }
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry)
  } catch {
    return false
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2))
}
