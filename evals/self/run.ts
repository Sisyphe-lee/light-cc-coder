#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import type { ContextBudgetInput } from "../../src/context/contextBudget"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { makeAssistantMessage, type ToolCall } from "../../src/core/messages"
import { readJsonlTranscript } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import type { PermissionMode } from "../../src/permissions/types"

type SelfEvalOptions = {
  fixture?: string
  list: boolean
  keepWorkspaces: boolean
  reportDir?: string
  runId?: string
  verbose: boolean
  model: "fake"
}

type FixtureDefinition = {
  name?: string
  description?: string
  prompt: string
  permissionMode?: PermissionMode
  maxSteps?: number
  contextBudget?: ContextBudgetInput
  compactTailMessages?: number
  autoApprove?: "allow" | "deny"
  initialFiles?: Record<string, string>
  providerSteps: Array<{
    content?: string
    contentRepeat?: { text: string; count: number }
    toolCalls?: ToolCall[]
  }>
  expect?: {
    files?: Array<
      | { path: string; equals: string }
      | { path: string; contains: string }
      | { path: string; notExists: true }
    >
    events?: {
      toolCalls?: number
      toolResults?: number
      minToolCalls?: number
      minToolResults?: number
      toolErrors?: number
      minToolErrors?: number
      permissionDenials?: number
      minPermissionDenials?: number
      bashObservations?: number
      minBashObservations?: number
      compactStarted?: number
      minCompactStarted?: number
      compactSucceeded?: number
      minCompactSucceeded?: number
      replayValid?: boolean
      toolResultsMatchToolCalls?: boolean
    }
  }
}

type FixtureRecord = {
  name: string
  dir: string
  definition: FixtureDefinition
}

type SelfEvalSummary = {
  schemaVersion: 1
  runId: string
  startedAt: string
  endedAt: string
  durationMs: number
  reportDir: string
  passed: number
  failed: number
  results: FixtureResult[]
}

type FixtureResult = {
  name: string
  status: "passed" | "failed"
  durationMs: number
  workspace: string
  artifactDir: string
  transcript: string
  metrics: FixtureMetrics
  failureReason?: string
}

type FixtureMetrics = {
  events: {
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
    compactStarted: number
    compactSucceeded: number
    compactFailed: number
    compactTriggers: Record<string, number>
    turnEndReasons: Record<string, number>
  }
  replayValid: boolean
  toolResultsMatchToolCalls: boolean
}

async function main(argv: string[]): Promise<number> {
  const startedAt = new Date()
  const startedMs = Date.now()
  let options: SelfEvalOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(stringifyError(error))
    return 2
  }

  const fixtures = await loadFixtures()
  if (options.list) {
    for (const fixture of fixtures) {
      console.log(`${fixture.name}${fixture.definition.description ? ` - ${fixture.definition.description}` : ""}`)
    }
    return 0
  }

  const selected = options.fixture ? fixtures.filter((fixture) => fixture.name === options.fixture) : fixtures
  if (selected.length === 0) {
    console.error(`Unknown fixture: ${options.fixture}`)
    return 2
  }

  const runId = options.runId ?? defaultRunId()
  const reportDir = resolve(options.reportDir ?? join(process.cwd(), ".light-cc", "evals", runId, "self"))
  await mkdir(reportDir, { recursive: true })

  const results: FixtureResult[] = []
  for (const fixture of selected) {
    const result = await runFixture(fixture, { ...options, runId, reportDir })
    results.push(result)
    const mark = result.status === "passed" ? "PASS" : "FAIL"
    console.log(`${mark} ${fixture.name}${result.failureReason ? ` - ${result.failureReason}` : ""}`)
  }

  const summary: SelfEvalSummary = {
    schemaVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    reportDir,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  }
  await writeFile(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  return summary.failed === 0 ? 0 : 1
}

async function loadFixtures(): Promise<FixtureRecord[]> {
  const fixturesRoot = resolve("evals", "self", "fixtures")
  const entries = await readdir(fixturesRoot, { withFileTypes: true })
  const fixtures: FixtureRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(fixturesRoot, entry.name)
    const path = join(dir, "fixture.json")
    if (!existsSync(path)) continue
    const definition = JSON.parse(await readFile(path, "utf8")) as FixtureDefinition
    fixtures.push({ name: definition.name ?? entry.name, dir, definition })
  }
  return fixtures.sort((a, b) => a.name.localeCompare(b.name))
}

async function runFixture(
  fixture: FixtureRecord,
  options: SelfEvalOptions & { runId: string; reportDir: string },
): Promise<FixtureResult> {
  const startedMs = Date.now()
  const artifactDir = join(options.reportDir, fixture.name)
  const transcript = join(artifactDir, "transcript.jsonl")
  await rm(artifactDir, { recursive: true, force: true })
  await mkdir(artifactDir, { recursive: true })
  await writeFile(join(artifactDir, "prompt.md"), fixture.definition.prompt, "utf8")

  const workspace = await mkdtemp(join(tmpdir(), `light-cc-self-${fixture.name}-`))
  try {
    await writeInitialFiles(workspace, fixture.definition.initialFiles ?? {})
    const events: SessionEvent[] = []
    const todoState = new TodoState()
    const workspaceFs = await WorkspaceFs.create(workspace)
    const runtime = await LocalRuntime.create({ workspaceRoot: workspaceFs.root, initialCwd: workspaceFs.root })
    const provider = new FakeProvider({
      steps: fixture.definition.providerSteps.map((step, index) => ({
        message: makeAssistantMessage({
          id: `assistant_${index + 1}`,
          content: step.content ?? (step.contentRepeat ? step.contentRepeat.text.repeat(step.contentRepeat.count) : ""),
          toolCalls: step.toolCalls ?? [],
        }),
      })),
    })
    const session = await AgentSession.create({
      id: `${options.runId}-${fixture.name}`,
      cwd: workspaceFs.root,
      provider,
      transcript,
      maxSteps: fixture.definition.maxSteps ?? Math.max(1, fixture.definition.providerSteps.length + 1),
      contextBudget: fixture.definition.contextBudget,
      compactTailMessages: fixture.definition.compactTailMessages,
      toolRuntime: new RealToolRuntime({
        registry: createBuiltinToolRegistry({ todoState }),
        workspace: workspaceFs,
        runtime,
        permissionMode: fixture.definition.permissionMode ?? "danger-full-access",
      }),
      todoState,
    })

    const collect = collectEvents(session, events, fixture.definition.autoApprove)
    await session.submit({ type: "user_message", content: fixture.definition.prompt })
    await session.close()
    await collect

    const transcriptEvents = await readJsonlTranscript(transcript)
    const metrics = buildMetrics(transcriptEvents)
    const failureReason = await verifyFixture(fixture, workspace, metrics)
    const status = failureReason ? "failed" : "passed"
    const result: FixtureResult = {
      name: fixture.name,
      status,
      durationMs: Date.now() - startedMs,
      workspace,
      artifactDir,
      transcript,
      metrics,
      failureReason,
    }
    await writeFile(join(artifactDir, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    return result
  } catch (error) {
    const failureReason = stringifyError(error)
    const result: FixtureResult = {
      name: fixture.name,
      status: "failed",
      durationMs: Date.now() - startedMs,
      workspace,
      artifactDir,
      transcript,
      metrics: emptyMetrics(),
      failureReason,
    }
    await writeFile(join(artifactDir, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    return result
  } finally {
    if (!options.keepWorkspaces) await rm(workspace, { recursive: true, force: true })
  }
}

async function collectEvents(
  session: AgentSession,
  events: SessionEvent[],
  autoApprove: "allow" | "deny" | undefined,
): Promise<void> {
  for await (const event of session.events()) {
    events.push(event)
    if (event.type === "approval.requested" && autoApprove) {
      await session.submit({ type: "approval.respond", approvalId: event.approvalId, decision: autoApprove })
    }
  }
}

async function writeInitialFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, "utf8")
  }
}

function buildMetrics(events: SessionEvent[]): FixtureMetrics {
  const metrics = emptyMetrics()
  metrics.events.total = events.length
  for (const event of events) {
    metrics.events.byType[event.type] = (metrics.events.byType[event.type] ?? 0) + 1
    if (event.type === "tool.call") metrics.events.toolCalls += 1
    if (event.type === "tool.result") {
      metrics.events.toolResults += 1
      if (event.result.isError) metrics.events.toolErrors += 1
    }
    if (event.type === "permission.decision" && event.decision === "deny") metrics.events.permissionDenials += 1
    if (event.type === "approval.requested") metrics.events.approvalsRequested += 1
    if (event.type === "approval.responded" && event.decision === "allow") metrics.events.approvalsAllowed += 1
    if (event.type === "approval.responded" && event.decision === "deny") metrics.events.approvalsDenied += 1
    if (event.type === "bash.observation") metrics.events.bashObservations += 1
    if (event.type === "error") metrics.events.errors += 1
    if (event.type === "turn.ended") {
      metrics.events.turnEndReasons[event.reason] = (metrics.events.turnEndReasons[event.reason] ?? 0) + 1
    }
    if (event.type === "compact.started") {
      metrics.events.compactStarted += 1
      metrics.events.compactTriggers[event.trigger] = (metrics.events.compactTriggers[event.trigger] ?? 0) + 1
    }
    if (event.type === "compact.ended" && event.status === "succeeded") metrics.events.compactSucceeded += 1
    if (event.type === "compact.ended" && event.status === "failed") metrics.events.compactFailed += 1
  }
  metrics.replayValid = canReplay(events)
  metrics.toolResultsMatchToolCalls = validateToolEventPairing(events)
  return metrics
}

async function verifyFixture(
  fixture: FixtureRecord,
  workspace: string,
  metrics: FixtureMetrics,
): Promise<string | undefined> {
  const expected = fixture.definition.expect
  for (const check of expected?.files ?? []) {
    const path = join(workspace, check.path)
    if ("notExists" in check) {
      if (existsSync(path)) return `Expected ${check.path} not to exist`
      continue
    }
    if (!existsSync(path)) return `Expected ${check.path} to exist`
    const file = await stat(path)
    if (!file.isFile()) return `Expected ${check.path} to be a file`
    const content = await readFile(path, "utf8")
    if ("equals" in check && content !== check.equals) return `Expected ${check.path} to equal fixture content`
    if ("contains" in check && !content.includes(check.contains)) return `Expected ${check.path} to contain fixture text`
  }

  const events = expected?.events
  if (!events) return undefined
  const checks: Array<[boolean, string]> = [
    [events.toolCalls === undefined || metrics.events.toolCalls === events.toolCalls, `Expected toolCalls=${events.toolCalls}`],
    [events.toolResults === undefined || metrics.events.toolResults === events.toolResults, `Expected toolResults=${events.toolResults}`],
    [events.minToolCalls === undefined || metrics.events.toolCalls >= events.minToolCalls, `Expected toolCalls>=${events.minToolCalls}`],
    [events.minToolResults === undefined || metrics.events.toolResults >= events.minToolResults, `Expected toolResults>=${events.minToolResults}`],
    [events.toolErrors === undefined || metrics.events.toolErrors === events.toolErrors, `Expected toolErrors=${events.toolErrors}`],
    [events.minToolErrors === undefined || metrics.events.toolErrors >= events.minToolErrors, `Expected toolErrors>=${events.minToolErrors}`],
    [
      events.permissionDenials === undefined || metrics.events.permissionDenials === events.permissionDenials,
      `Expected permissionDenials=${events.permissionDenials}`,
    ],
    [
      events.minPermissionDenials === undefined || metrics.events.permissionDenials >= events.minPermissionDenials,
      `Expected permissionDenials>=${events.minPermissionDenials}`,
    ],
    [
      events.bashObservations === undefined || metrics.events.bashObservations === events.bashObservations,
      `Expected bashObservations=${events.bashObservations}`,
    ],
    [
      events.minBashObservations === undefined || metrics.events.bashObservations >= events.minBashObservations,
      `Expected bashObservations>=${events.minBashObservations}`,
    ],
    [
      events.compactStarted === undefined || metrics.events.compactStarted === events.compactStarted,
      `Expected compactStarted=${events.compactStarted}`,
    ],
    [
      events.minCompactStarted === undefined || metrics.events.compactStarted >= events.minCompactStarted,
      `Expected compactStarted>=${events.minCompactStarted}`,
    ],
    [
      events.compactSucceeded === undefined || metrics.events.compactSucceeded === events.compactSucceeded,
      `Expected compactSucceeded=${events.compactSucceeded}`,
    ],
    [
      events.minCompactSucceeded === undefined || metrics.events.compactSucceeded >= events.minCompactSucceeded,
      `Expected compactSucceeded>=${events.minCompactSucceeded}`,
    ],
    [events.replayValid === undefined || metrics.replayValid === events.replayValid, `Expected replayValid=${events.replayValid}`],
    [
      events.toolResultsMatchToolCalls === undefined || metrics.toolResultsMatchToolCalls === events.toolResultsMatchToolCalls,
      `Expected toolResultsMatchToolCalls=${events.toolResultsMatchToolCalls}`,
    ],
  ]
  return checks.find(([ok]) => !ok)?.[1]
}

function canReplay(events: SessionEvent[]): boolean {
  try {
    AgentSession.replayProviderMessages(events)
    return true
  } catch {
    return false
  }
}

function validateToolEventPairing(events: SessionEvent[]): boolean {
  const assistantSteps = new Set<string>()
  for (const event of events) {
    if (event.type !== "assistant.message" || event.message.toolCalls.length === 0) continue
    const stepKey = `${event.turnId}:${event.stepId}`
    assistantSteps.add(stepKey)
    const calls = events.filter(
      (item): item is Extract<SessionEvent, { type: "tool.call" }> =>
        item.type === "tool.call" && item.turnId === event.turnId && item.stepId === event.stepId,
    )
    const results = events.filter(
      (item): item is Extract<SessionEvent, { type: "tool.result" }> =>
        item.type === "tool.result" && item.turnId === event.turnId && item.stepId === event.stepId,
    )
    if (calls.length !== event.message.toolCalls.length || results.length !== event.message.toolCalls.length) return false
    for (let index = 0; index < event.message.toolCalls.length; index++) {
      const expected = event.message.toolCalls[index]
      if (calls[index].call.id !== expected.id || calls[index].call.name !== expected.name) return false
      if (results[index].result.toolCallId !== expected.id || results[index].result.toolName !== expected.name) return false
    }
  }
  for (const event of events) {
    if (event.type !== "tool.call" && event.type !== "tool.result") continue
    if (!assistantSteps.has(`${event.turnId}:${event.stepId}`)) return false
  }
  return true
}

function emptyMetrics(): FixtureMetrics {
  return {
    events: {
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
      compactStarted: 0,
      compactSucceeded: 0,
      compactFailed: 0,
      compactTriggers: {},
      turnEndReasons: {},
    },
    replayValid: false,
    toolResultsMatchToolCalls: false,
  }
}

function parseArgs(argv: string[]): SelfEvalOptions {
  const options: SelfEvalOptions = {
    list: false,
    keepWorkspaces: false,
    verbose: false,
    model: "fake",
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--fixture") options.fixture = requireValue(argv, ++index, arg)
    else if (arg === "--list") options.list = true
    else if (arg === "--keep-workspaces") options.keepWorkspaces = true
    else if (arg === "--report-dir") options.reportDir = requireValue(argv, ++index, arg)
    else if (arg === "--run-id") options.runId = requireValue(argv, ++index, arg)
    else if (arg === "--verbose") options.verbose = true
    else if (arg === "--model") {
      const model = requireValue(argv, ++index, arg)
      if (model !== "fake") throw new Error("self-eval currently supports --model fake only")
      options.model = model
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function defaultRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")
  const suffix = createHash("sha256").update(`${timestamp}-${Math.random()}`).digest("hex").slice(0, 8)
  return `self-${timestamp}-${suffix}`
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
