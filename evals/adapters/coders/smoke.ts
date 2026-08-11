#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { collectGitPatchSinceBase } from "../../git-patch"
import { DEFAULT_EVAL_MODEL } from "../defaults"
import { buildCoderCommand, loadCoderAdapter } from "./loader"

type SmokeOptions = {
  coder: string
  model: string
  baseUrl: string
  apiKeyEnv: string
  envFile?: string
  reportDir?: string
  timeoutMs: number
  permissionMode: "read-only" | "workspace-write" | "danger-full-access"
  maxSteps: number
}

type CommandResult = {
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

type EnvFile = {
  names: string[]
  values: Record<string, string>
}

export async function main(argv: string[]): Promise<number> {
  try {
    const summary = await runCoderSmoke(normalizeOptions(parseArgs(argv)))
    console.log(`Coder smoke ${summary.status}: ${summary.coderId}`)
    console.log(`Artifacts: ${summary.reportDir}`)
    return summary.status === "passed" ? 0 : 1
  } catch (error) {
    console.error(stringifyError(error))
    return 1
  }
}

export async function runCoderSmoke(options: SmokeOptions): Promise<Record<string, unknown>> {
  const startedAt = new Date()
  const startedMs = Date.now()
  const adapter = await loadCoderAdapter(options.coder)
  const reportDir = resolve(options.reportDir ?? join(process.cwd(), ".light-cc", "evals", "coder-smoke", defaultRunId(adapter.id)))
  const workspace = join(reportDir, "workspace")
  const agentDir = join(reportDir, "agent")
  const promptPath = join(agentDir, "prompt.md")
  const transcriptPath = join(agentDir, "transcript.jsonl")
  const patchPath = join(agentDir, "patch.diff")
  const envFile = options.envFile ? await readEnvFile(options.envFile) : { names: [], values: {} }

  await mkdir(workspace, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(workspace, "hello.txt"), "status: broken\n", "utf8")
  await writeFile(
    promptPath,
    [
      "You are running a non-interactive coder adapter conformance smoke.",
      "Edit hello.txt in the current workspace so its complete contents are exactly:",
      "",
      "status: fixed",
      "",
      "Do not create extra files unless your tool needs internal metadata.",
      "Exit after making the edit.",
      "",
    ].join("\n"),
    "utf8",
  )

  const setupCommands = [
    await runCommand(["git", "init"], workspace, {}, options.timeoutMs, []),
    await runCommand(["git", "config", "user.email", "lightcc-eval@example.invalid"], workspace, {}, options.timeoutMs, []),
    await runCommand(["git", "config", "user.name", "LightCC Eval"], workspace, {}, options.timeoutMs, []),
    await runCommand(["git", "add", "hello.txt"], workspace, {}, options.timeoutMs, []),
    await runCommand(["git", "commit", "-m", "initial smoke fixture"], workspace, {}, options.timeoutMs, []),
  ]
  const setupFailed = setupCommands.find((command) => command.exitCode !== 0)
  if (setupFailed) throw new Error(`Smoke git setup failed: ${firstLine(setupFailed.stderr) || `exit ${setupFailed.exitCode}`}`)
  const baseHeadCommand = await runCommand(["git", "rev-parse", "HEAD"], workspace, {}, options.timeoutMs, [])
  if (baseHeadCommand.exitCode !== 0) {
    throw new Error(`Smoke git setup failed: ${firstLine(baseHeadCommand.stderr) || `exit ${baseHeadCommand.exitCode}`}`)
  }
  const baseHead = baseHeadCommand.stdout.trim()
  if (!baseHead) throw new Error("Smoke git setup failed: empty base HEAD")

  const rendered = buildCoderCommand(adapter, {
    instruction: "",
    promptFile: promptPath,
    workspace,
    artifactDir: agentDir,
    transcriptPath,
    patchPath,
    resultPath: join(agentDir, "result.json"),
    model: options.model,
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv,
    maxSteps: String(options.maxSteps),
    permissionMode: options.permissionMode,
    osSandbox: "off",
    sandboxSettings: "",
    executable: adapter.command.executable,
  })

  const env = buildRuntimeEnv(rendered.env, envFile, options)
  const secretValues = Object.values(envFile.values).filter(Boolean)
  const command = await runCommand([rendered.executable, ...rendered.args], rendered.cwd ?? workspace, env, options.timeoutMs, secretValues)
  const patchCollection = await collectGitPatchSinceBase(workspace, baseHead, { timeoutMs: options.timeoutMs })
  const finalText = await readFile(join(workspace, "hello.txt"), "utf8").catch(() => "")
  await writeFile(patchPath, patchCollection.patch, "utf8")
  await writeFile(join(reportDir, "stdout.log"), command.stdout, "utf8")
  await writeFile(join(reportDir, "stderr.log"), command.stderr, "utf8")
  await writeJson(join(reportDir, "command.json"), {
    args: [rendered.executable, ...rendered.args],
    cwd: rendered.cwd ?? workspace,
    envNames: Object.keys(env).sort(),
    requiredEnv: rendered.requiredEnv,
    timeoutMs: options.timeoutMs,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    timedOut: command.timedOut,
  })

  const changed = finalText.trim() === "status: fixed"
  const patchBytes = Buffer.byteLength(patchCollection.patch)
  const status =
    command.exitCode === 0 && !command.timedOut && changed && patchBytes > 0 && !patchCollection.error ? "passed" : "failed"
  const summary = {
    schemaVersion: 1,
    status,
    coderId: adapter.id,
    coderStatus: adapter.status,
    model: options.model,
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv,
    envFileNames: envFile.names,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    reportDir,
    workspace,
    command: {
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      timedOut: command.timedOut,
      stdoutBytes: Buffer.byteLength(command.stdout),
      stderrBytes: Buffer.byteLength(command.stderr),
    },
    patch: {
      path: patchPath,
      bytes: patchBytes,
      sha256: sha256(patchCollection.patch),
      baseHead,
      committedChangesCollected: patchCollection.committedChangesCollected,
      headDiffMissedChanges: patchCollection.headDiffMissedChanges,
    },
    conformance: {
      editedExpectedFile: changed,
      producedPatch: patchBytes > 0,
    },
    error:
      status === "passed"
        ? undefined
        : [
            command.exitCode !== 0 ? `command exited ${command.exitCode}` : undefined,
            command.timedOut ? "command timed out" : undefined,
            changed ? undefined : "hello.txt did not contain expected content",
            patchBytes > 0 ? undefined : "empty patch",
            patchCollection.error,
          ]
            .filter(Boolean)
            .join("; "),
  }
  await writeJson(join(reportDir, "summary.json"), summary)
  return summary
}

function buildRuntimeEnv(renderedEnv: Record<string, string>, envFile: EnvFile, options: SmokeOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...stringEnv(process.env),
    ...envFile.values,
    ...renderedEnv,
  }
  if (!env[options.apiKeyEnv] && process.env[options.apiKeyEnv]) {
    env[options.apiKeyEnv] = process.env[options.apiKeyEnv] ?? ""
  }
  if (!env.LLM_API_KEY && env[options.apiKeyEnv]) {
    env.LLM_API_KEY = env[options.apiKeyEnv]
  }
  if (!env.OPENAI_API_KEY && env[options.apiKeyEnv]) {
    env.OPENAI_API_KEY = env[options.apiKeyEnv]
  }
  if (!env.DEEPSEEK_API_KEY && env[options.apiKeyEnv]) {
    env.DEEPSEEK_API_KEY = env[options.apiKeyEnv]
  }
  if (!env.KIMI_MODEL_API_KEY && env[options.apiKeyEnv]) {
    env.KIMI_MODEL_API_KEY = env[options.apiKeyEnv]
  }
  return env
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

async function runCommand(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  secretValues: string[],
): Promise<CommandResult> {
  const startedMs = Date.now()
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  return {
    args,
    cwd,
    exitCode,
    stdout: redact(stdout, secretValues),
    stderr: redact(stderr, secretValues),
    durationMs: Date.now() - startedMs,
    timedOut,
  }
}

async function readEnvFile(path: string): Promise<EnvFile> {
  const text = await readFile(path, "utf8")
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf("=")
    if (index <= 0) continue
    const key = trimmed.slice(0, index)
    const value = trimmed.slice(index + 1)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values[key] = value
  }
  return { names: Object.keys(values), values }
}

function parseArgs(argv: string[]): Partial<SmokeOptions> {
  const options: Partial<SmokeOptions> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--coder") options.coder = requireValue(argv, ++index, arg)
    else if (arg === "--model") options.model = requireValue(argv, ++index, arg)
    else if (arg === "--base-url") options.baseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--env-file") options.envFile = requireValue(argv, ++index, arg)
    else if (arg === "--report-dir") options.reportDir = requireValue(argv, ++index, arg)
    else if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--permission-mode") options.permissionMode = parsePermissionMode(requireValue(argv, ++index, arg))
    else if (arg === "--max-steps") options.maxSteps = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function normalizeOptions(options: Partial<SmokeOptions>): SmokeOptions {
  if (!options.coder) throw new Error("--coder is required")
  return {
    coder: options.coder,
    model: options.model ?? DEFAULT_EVAL_MODEL,
    baseUrl: options.baseUrl ?? "https://api.deepseek.com",
    apiKeyEnv: options.apiKeyEnv ?? "DEEPSEEK_API_KEY",
    envFile: options.envFile,
    reportDir: options.reportDir,
    timeoutMs: options.timeoutMs ?? 300_000,
    permissionMode: options.permissionMode ?? "danger-full-access",
    maxSteps: options.maxSteps ?? 40,
  }
}

function parsePermissionMode(value: string): SmokeOptions["permissionMode"] {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value
  throw new Error(`Invalid --permission-mode: ${value}`)
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function defaultRunId(coderId: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")
  const suffix = createHash("sha256").update(`${timestamp}-${Math.random()}`).digest("hex").slice(0, 8)
  return `${coderId}-${timestamp}-${suffix}`
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? ""
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function redact(value: string, secretValues: string[]): string {
  let redacted = value
  for (const secret of secretValues) {
    if (secret.length < 8) continue
    redacted = redacted.split(secret).join("[REDACTED]")
  }
  return redacted
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(): string {
  return [
    "Usage: bun evals/adapters/coders/smoke.ts --coder <adapter-id-or-json> [options]",
    "Options: --model <id> --base-url <url> --api-key-env <name> --env-file <path> --timeout-ms <ms>",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
