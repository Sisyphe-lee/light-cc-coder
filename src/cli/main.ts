#!/usr/bin/env bun
import { realpathSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { parseCliArgs, usage, type ParsedCliArgs } from "./args"
import { resolveConfig, type EffectiveConfig } from "./config"
import { renderDryRun, runDoctor } from "./doctor"
import { ApprovalPrompt } from "./approvalPrompt"
import { EventRenderer } from "./eventRenderer"
import { createProvider, createSession, type CreatedSession } from "./sessionFactory"
import { runRepl } from "./repl"
import { SessionMetadataUpdater, SessionStore } from "./sessionStore"
import type { SessionEvent } from "../core/events"

type EventStats = {
  total: number
  byType: Record<string, number>
  toolCalls: number
  toolResults: number
  toolErrors: number
  permissionDenials: number
  approvalsRequested: number
  approvalsAllowed: number
  approvalsDenied: number
  bashObservations: number
  errors: number
  turnEndReasons: Record<string, number>
}

type RunSummary = {
  schemaVersion: 1
  runId?: string
  sessionId?: string
  status: "completed" | "failed"
  exitCode: number
  startedAt: string
  endedAt: string
  durationMs: number
  cwd: string
  promptSource?: "inline" | "file"
  promptFile?: string
  artifactDir?: string
  transcript?: string
  options: {
    model?: string
    baseUrl?: string
    apiKeyEnv: string
    permissionMode: string
    maxSteps: number
    maxContextTokens?: number
    compactThreshold?: number
    fake: boolean
  }
  events: EventStats
  error?: string
}

export async function main(argv: string[]): Promise<number> {
  const startedAt = new Date()
  const startedMs = Date.now()
  let args: ParsedCliArgs
  try {
    args = parseCliArgs(argv, { stdinIsTty: process.stdin.isTTY })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  let config: EffectiveConfig
  try {
    config = await resolveConfig(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  const store = new SessionStore(config.dataRoot.value)

  if (args.mode === "help") {
    process.stdout.write(usage())
    process.stdout.write("\n")
    return 0
  }

  if (args.mode === "doctor") {
    const result = await runDoctor(config, store, { sandboxOnly: args.doctorSandbox, json: args.json })
    process.stdout.write(result.output)
    if (!result.output.endsWith("\n")) process.stdout.write("\n")
    return result.exitCode
  }

  if (args.mode === "sessions") {
    process.stdout.write(await store.renderSessions(config.cwd.value))
    process.stdout.write("\n")
    return 0
  }

  if (args.mode === "dry-run") {
    process.stdout.write(renderDryRun(config, store, args.prompt))
    process.stdout.write("\n")
    return 0
  }

  if (args.mode === "resume") {
    try {
      const resume = await store.resolveResume(args.resume ?? { last: true }, config.cwd.value)
      const created = await createSession({ config, store, resume })
      await runInteractive(created, config, store)
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  if (args.mode === "repl") {
    try {
      const created = await createSession({ config, store })
      await runInteractive(created, config, store)
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  return runOneShot(args, config, store, startedAt, startedMs)
}

async function runOneShot(
  args: ParsedCliArgs,
  config: EffectiveConfig,
  store: SessionStore,
  startedAt: Date,
  startedMs: number,
): Promise<number> {
  const artifactDir = args.artifactDir ? resolve(args.artifactDir) : undefined
  const runId = artifactDir ? basename(artifactDir) : undefined
  const output = createRunOutput(args)
  let prompt = ""
  let created: CreatedSession | undefined
  let events = emptyEventStats()

  try {
    if (artifactDir) await mkdir(artifactDir, { recursive: true })
    prompt = await loadOneShotPrompt(args)
    // Validate provider configuration before creating a default session transcript.
    createProvider(config)
    created = await createSession({ config, store })
  } catch (error) {
    const message = stringifyError(error)
    output.writeError(`${message}\n`)
    const summary = buildSummary({
      args,
      config,
      runId,
      artifactDir,
      startedAt,
      startedMs,
      events,
      status: "failed",
      exitCode: 2,
      error: message,
    })
    await writeRunArtifacts({ artifactDir, output, summary }).catch((artifactError) =>
      output.writeError(`${stringifyError(artifactError)}\n`),
    )
    writeMachineSummary(summary, output, args)
    return 2
  }

  const updater = new SessionMetadataUpdater(store, created.plan)
  const renderer = new EventRenderer({
    stdout: output.stdoutStream,
    stderr: output.stderrStream,
    verbose: config.verbose.value,
    json: args.json,
    permissionMode: config.permissionMode.value,
    jsonEvents: args.jsonEvents,
    approvalPrompt: new ApprovalPrompt(),
    onEvent: async (event) => {
      recordEvent(events, event)
      await updater.handle(event)
    },
  })
  const consume = renderer.consume(created.session)
  try {
    await created.session.submit({ type: "user_message", content: prompt })
    await created.session.close()
    await consume
    const summary = buildSummary({
      args,
      config,
      runId,
      sessionId: created.session.id,
      artifactDir,
      transcriptPath: created.plan.transcriptPath,
      startedAt,
      startedMs,
      events,
      status: "completed",
      exitCode: 0,
    })
    await writeRunArtifacts({ artifactDir, output, summary })
    writeMachineSummary(summary, output, args)
    return 0
  } catch (error) {
    await created.session.close().catch(() => undefined)
    await consume.catch(() => undefined)
    const message = stringifyError(error)
    output.writeError(`${message}\n`)
    const summary = buildSummary({
      args,
      config,
      runId,
      sessionId: created.session.id,
      artifactDir,
      transcriptPath: created.plan.transcriptPath,
      startedAt,
      startedMs,
      events,
      status: "failed",
      exitCode: 1,
      error: message,
    })
    await writeRunArtifacts({ artifactDir, output, summary }).catch((artifactError) =>
      output.writeError(`${stringifyError(artifactError)}\n`),
    )
    writeMachineSummary(summary, output, args)
    return 1
  }
}

async function loadOneShotPrompt(args: ParsedCliArgs): Promise<string> {
  if (args.prompt && args.promptFile) throw new Error("Use either -p or --prompt-file, not both")
  if (args.prompt) return args.prompt
  if (args.promptFile) return readFile(resolve(args.promptFile), "utf8")
  throw new Error(usage())
}

async function runInteractive(
  initial: CreatedSession,
  config: Awaited<ReturnType<typeof resolveConfig>>,
  store: SessionStore,
): Promise<void> {
  await runRepl({
    initial,
    makeRenderer: (created, onHostAction, approvalPrompt) => {
      const updater = new SessionMetadataUpdater(store, created.plan)
      return new EventRenderer({
        verbose: config.verbose.value,
        permissionMode: config.permissionMode.value,
        showTurnStatus: true,
        showActivityIndicator: true,
        approvalPrompt,
        onEvent: (event) => updater.handle(event),
        onHostAction,
      })
    },
    createFresh: () => createSession({ config, store }),
    resume: async (target) => {
      const resume = await store.resolveResume(target === "last" ? { last: true } : { id: target }, config.cwd.value)
      return createSession({ config, store, resume })
    },
  })
}

function createRunOutput(args: ParsedCliArgs): {
  stdoutStream: RecordingStream
  stderrStream: RecordingStream
  writeError: (text: string) => void
  stdout: () => string
  stderr: () => string
} {
  const suppressHuman = args.quiet || args.outputJson || args.jsonEvents
  const stdoutStream = new RecordingStream(process.stdout, args.jsonEvents || !suppressHuman)
  const stderrStream = new RecordingStream(process.stderr, !suppressHuman)
  return {
    stdoutStream,
    stderrStream,
    writeError: (text) => stderrStream.writeForced(text),
    stdout: () => stdoutStream.content,
    stderr: () => stderrStream.content,
  }
}

class RecordingStream extends Writable {
  content = ""

  constructor(
    private readonly target: NodeJS.WritableStream,
    private readonly forward: boolean,
  ) {
    super()
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = String(chunk)
    this.content += text
    if (this.forward) this.target.write(text)
    callback()
  }

  writeForced(text: string): void {
    this.content += text
    this.target.write(text)
  }
}

function emptyEventStats(): EventStats {
  return {
    total: 0,
    byType: {},
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    permissionDenials: 0,
    approvalsRequested: 0,
    approvalsAllowed: 0,
    approvalsDenied: 0,
    bashObservations: 0,
    errors: 0,
    turnEndReasons: {},
  }
}

function recordEvent(stats: EventStats, event: SessionEvent): void {
  stats.total += 1
  stats.byType[event.type] = (stats.byType[event.type] ?? 0) + 1
  if (event.type === "tool.call") stats.toolCalls += 1
  if (event.type === "tool.result") {
    stats.toolResults += 1
    if (event.result.isError) stats.toolErrors += 1
  }
  if (event.type === "permission.decision" && event.decision === "deny") stats.permissionDenials += 1
  if (event.type === "approval.requested") stats.approvalsRequested += 1
  if (event.type === "approval.responded" && event.decision === "allow") stats.approvalsAllowed += 1
  if (event.type === "approval.responded" && event.decision === "deny") stats.approvalsDenied += 1
  if (event.type === "bash.observation") stats.bashObservations += 1
  if (event.type === "error") stats.errors += 1
  if (event.type === "turn.ended") {
    stats.turnEndReasons[event.reason] = (stats.turnEndReasons[event.reason] ?? 0) + 1
  }
}

function buildSummary(input: {
  args: ParsedCliArgs
  config: EffectiveConfig
  runId?: string
  sessionId?: string
  artifactDir?: string
  transcriptPath?: string
  startedAt: Date
  startedMs: number
  events: EventStats
  status: "completed" | "failed"
  exitCode: number
  error?: string
}): RunSummary {
  return {
    schemaVersion: 1,
    runId: input.runId,
    sessionId: input.sessionId,
    status: input.status,
    exitCode: input.exitCode,
    startedAt: input.startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - input.startedMs,
    cwd: input.config.cwd.value,
    promptSource: input.args.promptFile ? "file" : input.args.prompt ? "inline" : undefined,
    promptFile: input.args.promptFile ? resolve(input.args.promptFile) : undefined,
    artifactDir: input.artifactDir,
    transcript: input.transcriptPath ?? input.config.transcript.value,
    options: {
      model: input.config.model.value,
      baseUrl: input.config.baseUrl.value,
      apiKeyEnv: input.config.apiKeyEnv.value,
      permissionMode: input.config.permissionMode.value,
      maxSteps: input.config.maxSteps.value,
      maxContextTokens: input.config.maxContextTokens.value,
      compactThreshold: input.config.compactThreshold.value,
      fake: input.config.fake.value,
    },
    events: input.events,
    error: input.error,
  }
}

async function writeRunArtifacts(input: {
  artifactDir?: string
  output: ReturnType<typeof createRunOutput>
  summary: RunSummary
}): Promise<void> {
  if (!input.artifactDir) return
  await mkdir(input.artifactDir, { recursive: true })
  await writeFile(join(input.artifactDir, "run.json"), `${JSON.stringify(input.summary, null, 2)}\n`, "utf8")
  await writeFile(join(input.artifactDir, "summary.json"), `${JSON.stringify(input.summary, null, 2)}\n`, "utf8")
  await writeFile(join(input.artifactDir, "stdout.log"), input.output.stdout(), "utf8")
  await writeFile(join(input.artifactDir, "stderr.log"), input.output.stderr(), "utf8")
}

function writeMachineSummary(summary: RunSummary, output: ReturnType<typeof createRunOutput>, args: ParsedCliArgs): void {
  if (!args.outputJson) return
  output.stdoutStream.writeForced(`${JSON.stringify(summary)}\n`)
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMainModule(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean }
  if (typeof meta.main === "boolean") return meta.main
  const entry = process.argv[1]
  if (!entry) return false
  const modulePath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(modulePath) === realpathSync(entry)
  } catch {
    return modulePath === resolve(entry)
  }
}

if (isMainModule()) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
