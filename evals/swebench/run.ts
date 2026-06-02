#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { TokenUsage } from "../../src/core/messages"
import type { PermissionMode } from "../../src/permissions/types"
import { buildSweBenchPrompt } from "./prompt"
import {
  safeInstanceFromRecord,
  SWE_BENCH_LITE_DEFAULTS,
  type SweBenchCostEstimate,
  type SweBenchInstance,
  type SweBenchPrediction,
  type SweBenchTaskResult,
  type SweBenchUsageTotals,
} from "./types"

type SweBenchOptions = {
  instancesFile?: string
  instances: string[]
  limit?: number
  datasetName: string
  split: string
  datasetRevision: string
  runId?: string
  reportDir?: string
  workDir?: string
  keepWorkspaces: boolean
  preflight: boolean
  runAgent: boolean
  evaluate: boolean
  dryRunExplicit: boolean
  gold: boolean
  allowLargeRun: boolean
  predictionsPath?: string
  python: string
  maxWorkers: number
  model?: string
  modelNameOrPath?: string
  baseUrl?: string
  apiKeyEnv: string
  maxSteps: number
  permissionMode: PermissionMode
  evaluatorNamespace?: string
}

type RunContext = {
  runId: string
  reportDir: string
  workDir: string
  workDirIsDefault: boolean
  predictionsPath: string
  modelNameOrPath: string
}

type CommandResult = {
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

type PreflightCheck = {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
  command?: string[]
}

type PreflightReport = {
  schemaVersion: 1
  runId: string
  status: "passed" | "failed"
  startedAt: string
  endedAt: string
  durationMs: number
  reportDir: string
  checks: PreflightCheck[]
}

type InstanceMetrics = {
  schemaVersion: 1
  instanceId: string
  status: SweBenchTaskResult["status"]
  startedAt: string
  endedAt: string
  durationMs: number
  promptSha256: string
  patchSha256: string
  patchBytes: number
  patchLines: number
  changedFiles: string[]
  emptyPatch: boolean
  usage?: SweBenchUsageTotals
  cost?: SweBenchCostEstimate
  agentExitCode?: number
  agentFailed: boolean
  workspace?: string
  commands?: CommandResult[]
  error?: string
}

type RunSummary = {
  schemaVersion: 1
  runId: string
  status: "completed" | "failed"
  startedAt: string
  endedAt: string
  durationMs: number
  reportDir: string
  predictionsPath: string
  mode: {
    dryRun: boolean
    runAgent: boolean
    evaluate: boolean
    gold: boolean
  }
  swebench: {
    packageVersion: string
    datasetName: string
    split: string
    datasetRevision: string
  }
  environment: {
    bunVersion?: string
    platform: NodeJS.Platform
    arch: string
    cwd: string
    git?: {
      commit?: string
      branch?: string
      dirty?: boolean
    }
  }
  selectedInstances: string[]
  totals: {
    selected: number
    prepared: number
    completed: number
    failed: number
    skipped: number
    emptyPatch: number
    agentFailed: number
  }
  usage?: SweBenchUsageTotals
  cost?: SweBenchCostEstimate
  results: SweBenchTaskResult[]
  evaluator?: {
    commandPath: string
    stdoutPath: string
    stderrPath: string
    exitCode: number
  }
  error?: string
}

const DEEPSEEK_PRICING_USD_PER_1M: Record<string, Omit<SweBenchCostEstimate["pricing"], "source">> = {
  "deepseek-v4-pro": {
    inputCacheHitPer1M: 0.003625,
    inputCacheMissPer1M: 0.435,
    outputPer1M: 0.87,
  },
  "deepseek-v4-flash": {
    inputCacheHitPer1M: 0.0028,
    inputCacheMissPer1M: 0.14,
    outputPer1M: 0.28,
  },
}

const DEEPSEEK_PRICING_SOURCE =
  "DeepSeek API pricing, checked 2026-06-01; cost uses actual cache hit/miss tokens when provider usage is present."

async function main(argv: string[]): Promise<number> {
  const startedAt = new Date()
  const startedMs = Date.now()
  let options: SweBenchOptions
  try {
    options = normalizeOptions(parseArgs(argv))
  } catch (error) {
    console.error(stringifyError(error))
    return 2
  }

  const context = buildRunContext(options)
  await mkdir(context.reportDir, { recursive: true })
  await mkdir(dirname(context.predictionsPath), { recursive: true })

  const results: SweBenchTaskResult[] = []
  let instances: SweBenchInstance[] = []
  let evaluator: RunSummary["evaluator"] | undefined

  try {
    if (options.preflight) {
      const report = await runPreflight(options, context, startedAt, startedMs)
      await writeFile(join(context.reportDir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
      await writeFile(join(context.reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
      printPreflight(report)
      return report.status === "passed" ? 0 : 1
    }

    validateSelectionRequest(options)
    instances = await loadInstances(options, context.reportDir)
    validateRunSize(instances, options)
    await writeSelectedInstances(context.reportDir, instances)

    for (const instance of instances) {
      const result = options.runAgent
        ? await runAgentInstance(instance, options, context)
        : await prepareInstance(instance, context)
      results.push(result)
      const mark = result.status === "failed" ? "FAIL" : result.status === "completed" ? "DONE" : "PREP"
      console.log(`${mark} ${instance.instance_id}${result.error ? ` - ${result.error}` : ""}`)
    }

    if (shouldWritePredictions(options)) {
      await writePredictions(context.predictionsPath, results)
    } else if (options.evaluate && !options.gold && !existsSync(context.predictionsPath)) {
      throw new Error(`Missing predictions file: ${context.predictionsPath}`)
    }

    if (options.evaluate) {
      evaluator = await runEvaluator(options, context, instances)
    }

    const summary = await buildSummary({
      status: "completed",
      startedAt,
      startedMs,
      options,
      context,
      instances,
      results,
      evaluator,
    })
    await writeRunFiles(context.reportDir, summary)
    printSummary(summary)
    return summary.status === "completed" && summary.totals.failed === 0 ? 0 : 1
  } catch (error) {
    const summary = await buildSummary({
      status: "failed",
      startedAt,
      startedMs,
      options,
      context,
      instances,
      results,
      evaluator,
      error: stringifyError(error),
    })
    await writeRunFiles(context.reportDir, summary)
    console.error(summary.error)
    return 1
  }
}

async function prepareInstance(instance: SweBenchInstance, context: RunContext): Promise<SweBenchTaskResult> {
  const startedAt = new Date()
  const startedMs = Date.now()
  const artifactDir = join(context.reportDir, "instances", sanitizePathSegment(instance.instance_id))
  await mkdir(artifactDir, { recursive: true })
  const prompt = buildSweBenchPrompt(instance)
  const promptPath = join(artifactDir, "prompt.md")
  const patchPath = join(artifactDir, "patch.diff")
  await writeFile(join(artifactDir, "instance.json"), `${JSON.stringify(instance, null, 2)}\n`, "utf8")
  await writeFile(promptPath, prompt, "utf8")
  await writeFile(patchPath, "", "utf8")

  const prediction = makePrediction(instance.instance_id, context.modelNameOrPath, "")
  await writeInstanceMetrics(artifactDir, {
    schemaVersion: 1,
    instanceId: instance.instance_id,
    status: "prepared",
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    promptSha256: sha256(prompt),
    patchSha256: sha256(""),
    patchBytes: 0,
    patchLines: 0,
    changedFiles: [],
    emptyPatch: true,
    agentFailed: false,
  })

  return {
    instanceId: instance.instance_id,
    status: "prepared",
    artifactDir,
    promptPath,
    patchPath,
    prediction,
  }
}

async function runAgentInstance(
  instance: SweBenchInstance,
  options: SweBenchOptions,
  context: RunContext,
): Promise<SweBenchTaskResult> {
  const prepared = await prepareInstance(instance, context)
  const startedAt = new Date()
  const startedMs = Date.now()
  const artifactDir = prepared.artifactDir
  const workspaceRoot = join(context.workDir, sanitizePathSegment(instance.instance_id))
  const workspace = join(workspaceRoot, "repo")
  const commands: CommandResult[] = []
  let patch = ""
  let agentExitCode: number | undefined
  let error: string | undefined

  try {
    commands.push(...(await prepareWorkspace(instance, workspace)))
    const agentDir = join(artifactDir, "agent")
    await mkdir(agentDir, { recursive: true })
    const transcriptPath = join(agentDir, "transcript.jsonl")
    const agentCommand = buildAgentCommand(instance, options, prepared.promptPath ?? "", workspace, agentDir)
    const agent = await runCommand(agentCommand, process.cwd())
    commands.push(agent)
    agentExitCode = agent.exitCode
    const usage = await readAgentUsage(transcriptPath)
    const cost = estimateCost(usage, modelForCost(options, context))

    const addIntent = await runCommand(["git", "add", "-N", "."], workspace)
    commands.push(addIntent)
    const diff = await runCommand(["git", "diff", "--binary", "--no-ext-diff", "HEAD"], workspace)
    commands.push(diff)
    if (diff.exitCode === 0) patch = diff.stdout
    else error = `git diff failed: ${firstLine(diff.stderr) || `exit ${diff.exitCode}`}`

    await writeFile(prepared.patchPath ?? join(artifactDir, "patch.diff"), patch, "utf8")
    const patchSummary = summarizePatch(patch)
    const status: SweBenchTaskResult["status"] = error || agentExitCode !== 0 ? "failed" : "completed"
    await writeInstanceMetrics(artifactDir, {
      schemaVersion: 1,
      instanceId: instance.instance_id,
      status,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      promptSha256: sha256(await readFile(prepared.promptPath ?? "", "utf8")),
      patchSha256: sha256(patch),
      patchBytes: Buffer.byteLength(patch),
      patchLines: patchSummary.patchLines,
      changedFiles: patchSummary.changedFiles,
      emptyPatch: patch.length === 0,
      usage,
      cost,
      agentExitCode,
      agentFailed: agentExitCode !== 0,
      workspace,
      commands,
      error: error ?? (agentExitCode !== 0 ? `agent exited ${agentExitCode}` : undefined),
    })
    return {
      ...prepared,
      status,
      workspace,
      transcriptPath,
      agentSummaryPath: join(agentDir, "summary.json"),
      usage,
      cost,
      prediction: makePrediction(instance.instance_id, context.modelNameOrPath, patch),
      error: error ?? (agentExitCode !== 0 ? `agent exited ${agentExitCode}` : undefined),
    }
  } catch (caught) {
    error = stringifyError(caught)
    const transcriptPath = join(artifactDir, "agent", "transcript.jsonl")
    const usage = await readAgentUsage(transcriptPath)
    const cost = estimateCost(usage, modelForCost(options, context))
    await writeFile(prepared.patchPath ?? join(artifactDir, "patch.diff"), patch, "utf8")
    await writeInstanceMetrics(artifactDir, {
      schemaVersion: 1,
      instanceId: instance.instance_id,
      status: "failed",
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      promptSha256: prepared.promptPath ? sha256(await readFile(prepared.promptPath, "utf8")) : "",
      patchSha256: sha256(patch),
      patchBytes: Buffer.byteLength(patch),
      patchLines: summarizePatch(patch).patchLines,
      changedFiles: summarizePatch(patch).changedFiles,
      emptyPatch: patch.length === 0,
      usage,
      cost,
      agentExitCode,
      agentFailed: true,
      workspace,
      commands,
      error,
    })
    return {
      ...prepared,
      status: "failed",
      workspace,
      transcriptPath: existsSync(transcriptPath) ? transcriptPath : undefined,
      usage,
      cost,
      prediction: makePrediction(instance.instance_id, context.modelNameOrPath, patch),
      error,
    }
  } finally {
    if (!options.keepWorkspaces && context.workDirIsDefault) {
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function prepareWorkspace(instance: SweBenchInstance, workspace: string): Promise<CommandResult[]> {
  if (existsSync(workspace)) {
    throw new Error(`Workspace already exists for ${instance.instance_id}: ${workspace}`)
  }
  await mkdir(dirname(workspace), { recursive: true })
  const repoUrl = `https://github.com/${instance.repo}.git`
  const commands = [
    await runCommand(["git", "init", workspace], process.cwd()),
    await runCommand(["git", "-C", workspace, "remote", "add", "origin", repoUrl], process.cwd()),
    await runCommand(["git", "-C", workspace, "fetch", "--depth", "1", "origin", instance.base_commit], process.cwd()),
    await runCommand(["git", "-C", workspace, "checkout", "--detach", "FETCH_HEAD"], process.cwd()),
    await runCommand(["git", "-C", workspace, "remote", "remove", "origin"], process.cwd()),
  ]
  const failed = commands.find((command) => command.exitCode !== 0)
  if (failed) {
    throw new Error(`Workspace preparation failed: ${failed.args.join(" ")}: ${firstLine(failed.stderr)}`)
  }
  return commands
}

function buildAgentCommand(
  instance: SweBenchInstance,
  options: SweBenchOptions,
  promptPath: string,
  workspace: string,
  agentDir: string,
): string[] {
  const args = [
    process.execPath,
    "src/cli/main.ts",
    "--prompt-file",
    promptPath,
    "--cwd",
    workspace,
    "--artifact-dir",
    agentDir,
    "--quiet",
    "--permission-mode",
    options.permissionMode,
    "--max-steps",
    String(options.maxSteps),
  ]
  if (options.model) args.push("--model", options.model)
  if (options.baseUrl) args.push("--base-url", options.baseUrl)
  if (options.apiKeyEnv) args.push("--api-key-env", options.apiKeyEnv)
  return args
}

async function runEvaluator(
  options: SweBenchOptions,
  context: RunContext,
  instances: SweBenchInstance[],
): Promise<NonNullable<RunSummary["evaluator"]>> {
  const evaluatorDir = join(context.reportDir, "evaluator")
  await mkdir(evaluatorDir, { recursive: true })
  const predictionsPath = options.gold ? "gold" : resolve(context.predictionsPath)
  const args = [
    options.python,
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    options.datasetName,
    "--split",
    options.split,
    "--predictions_path",
    predictionsPath,
    "--max_workers",
    String(options.maxWorkers),
    "--run_id",
    context.runId,
    "--report_dir",
    evaluatorDir,
  ]
  if (options.evaluatorNamespace !== undefined) args.push("--namespace", options.evaluatorNamespace)
  if (instances.length > 0) args.push("--instance_ids", ...instances.map((instance) => instance.instance_id))
  const result = await runCommand(args, process.cwd())
  const commandPath = join(evaluatorDir, "command.json")
  const stdoutPath = join(evaluatorDir, "stdout.log")
  const stderrPath = join(evaluatorDir, "stderr.log")
  await writeFile(commandPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  await writeFile(stdoutPath, result.stdout, "utf8")
  await writeFile(stderrPath, result.stderr, "utf8")
  if (result.exitCode !== 0) {
    throw new Error(`SWE-bench evaluator failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  }
  return { commandPath, stdoutPath, stderrPath, exitCode: result.exitCode }
}

async function loadInstances(options: SweBenchOptions, reportDir: string): Promise<SweBenchInstance[]> {
  const datasetDir = join(reportDir, "dataset")
  await mkdir(datasetDir, { recursive: true })

  if (options.instancesFile) {
    const parsed = await parseInstancesFile(options.instancesFile)
    if (parsed.kind === "instances") {
      return selectInstances(parsed.instances, options)
    }
    const requested = [...new Set([...parsed.instanceIds, ...options.instances])]
    return loadInstancesFromDataset({ ...options, instances: requested }, datasetDir)
  }

  return loadInstancesFromDataset(options, datasetDir)
}

async function loadInstancesFromDataset(options: SweBenchOptions, datasetDir: string): Promise<SweBenchInstance[]> {
  const output = join(datasetDir, "loaded_instances.json")
  const loader = resolve("evals", "swebench", "load_instances.py")
  const args = [
    options.python,
    loader,
    "--dataset-name",
    options.datasetName,
    "--split",
    options.split,
    "--revision",
    options.datasetRevision,
    "--output",
    output,
  ]
  for (const instance of options.instances) args.push("--instance", instance)
  if (options.limit !== undefined) args.push("--limit", String(options.limit))
  const result = await runCommand(args, process.cwd())
  await writeFile(join(datasetDir, "loader-command.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
  if (result.exitCode !== 0) {
    throw new Error(`Failed to load SWE-bench instances: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  }
  const records = JSON.parse(await readFile(output, "utf8")) as unknown[]
  return selectInstances(records.map(assertRecord).map(safeInstanceFromRecord), options)
}

async function parseInstancesFile(
  path: string,
): Promise<{ kind: "instances"; instances: SweBenchInstance[] } | { kind: "ids"; instanceIds: string[] }> {
  const content = await readFile(resolve(path), "utf8")
  const trimmed = content.trim()
  if (!trimmed) return { kind: "instances", instances: [] }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return { kind: "instances", instances: records.map(assertRecord).map(safeInstanceFromRecord) }
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const records = Array.isArray(parsed) ? parsed : [parsed]
      return { kind: "instances", instances: records.map(assertRecord).map(safeInstanceFromRecord) }
    } catch {
      // Fall through to JSONL parsing below.
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
  if (lines.every((line) => line.startsWith("{"))) {
    return { kind: "instances", instances: lines.map((line) => safeInstanceFromRecord(assertRecord(JSON.parse(line)))) }
  }
  return { kind: "ids", instanceIds: lines }
}

function selectInstances(instances: SweBenchInstance[], options: SweBenchOptions): SweBenchInstance[] {
  let selected = instances
  if (options.instances.length > 0) {
    const wanted = new Set(options.instances)
    selected = selected.filter((instance) => wanted.has(instance.instance_id))
    const found = new Set(selected.map((instance) => instance.instance_id))
    const missing = [...wanted].filter((id) => !found.has(id))
    if (missing.length > 0) throw new Error(`Missing requested instances: ${missing.join(", ")}`)
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit)
  if (selected.length === 0) throw new Error("No SWE-bench instances selected")
  return selected
}

function validateRunSize(instances: SweBenchInstance[], options: SweBenchOptions): void {
  const expensive = options.runAgent || options.evaluate || options.gold
  if (expensive && instances.length > 5 && !options.allowLargeRun) {
    throw new Error(`Refusing to run ${instances.length} instances without --allow-large-run`)
  }
  if (options.gold && instances.length !== 1 && !options.allowLargeRun) {
    throw new Error("--gold is limited to one instance unless --allow-large-run is set")
  }
}

function validateSelectionRequest(options: SweBenchOptions): void {
  if (!options.instancesFile && options.instances.length === 0 && options.limit === undefined) {
    throw new Error("Refusing to load the full split; pass --instance, --limit, or --instances-file")
  }
}

async function writeSelectedInstances(reportDir: string, instances: SweBenchInstance[]): Promise<void> {
  const datasetDir = join(reportDir, "dataset")
  await mkdir(datasetDir, { recursive: true })
  await writeFile(join(datasetDir, "instances.json"), `${JSON.stringify(instances, null, 2)}\n`, "utf8")
  await writeFile(
    join(reportDir, "selected_instances.jsonl"),
    `${instances.map((instance) => JSON.stringify(instance)).join("\n")}\n`,
    "utf8",
  )
}

async function writePredictions(path: string, results: SweBenchTaskResult[]): Promise<void> {
  const predictions = results.map((result) => result.prediction).filter((prediction): prediction is SweBenchPrediction =>
    Boolean(prediction),
  )
  await writeFile(resolve(path), `${predictions.map((prediction) => JSON.stringify(prediction)).join("\n")}\n`, "utf8")
}

function shouldWritePredictions(options: SweBenchOptions): boolean {
  return options.runAgent || isDryRun(options)
}

function isDryRun(options: SweBenchOptions): boolean {
  return options.dryRunExplicit || (!options.runAgent && !options.evaluate && !options.gold)
}

function makePrediction(instanceId: string, modelNameOrPath: string, patch: string): SweBenchPrediction {
  return {
    instance_id: instanceId,
    model_name_or_path: modelNameOrPath,
    model_patch: patch,
  }
}

async function writeInstanceMetrics(artifactDir: string, metrics: InstanceMetrics): Promise<void> {
  await writeFile(join(artifactDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8")
}

async function readAgentUsage(transcriptPath: string): Promise<SweBenchUsageTotals | undefined> {
  if (!existsSync(transcriptPath)) return undefined
  const totals = emptyUsageTotals()
  for (const line of (await readFile(transcriptPath, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line) as unknown
    } catch {
      continue
    }
    const usage = usageFromEvent(event)
    if (usage) addUsage(totals, usage)
  }
  return totals.requests > 0 ? totals : undefined
}

function usageFromEvent(event: unknown): TokenUsage | undefined {
  const record = event as { type?: unknown; message?: { usage?: TokenUsage } }
  if (record?.type !== "assistant.message") return undefined
  const usage = record.message?.usage
  if (!usage || typeof usage !== "object") return undefined
  return usage
}

function emptyUsageTotals(): SweBenchUsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    reasoningTokens: 0,
  }
}

function addUsage(totals: SweBenchUsageTotals, usage: TokenUsage | SweBenchUsageTotals): void {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens
  const hit = usage.promptCacheHitTokens ?? 0
  const miss = usage.promptCacheMissTokens ?? (hit > 0 ? Math.max(0, inputTokens - hit) : inputTokens)
  totals.requests += "requests" in usage ? usage.requests : 1
  totals.inputTokens += inputTokens
  totals.outputTokens += outputTokens
  totals.totalTokens += totalTokens
  totals.promptCacheHitTokens += hit
  totals.promptCacheMissTokens += miss
  totals.reasoningTokens += usage.reasoningTokens ?? 0
}

function sumUsage(results: SweBenchTaskResult[]): SweBenchUsageTotals | undefined {
  const totals = emptyUsageTotals()
  for (const result of results) {
    if (result.usage) addUsage(totals, result.usage)
  }
  return totals.requests > 0 ? totals : undefined
}

function estimateCost(
  usage: SweBenchUsageTotals | undefined,
  model: string | undefined,
): SweBenchCostEstimate | undefined {
  if (!usage || !model) return undefined
  const normalizedModel = normalizeModelName(model)
  const pricing = DEEPSEEK_PRICING_USD_PER_1M[normalizedModel]
  if (!pricing) return undefined
  const inputCacheHitUsd = (usage.promptCacheHitTokens / 1_000_000) * pricing.inputCacheHitPer1M
  const inputCacheMissUsd = (usage.promptCacheMissTokens / 1_000_000) * pricing.inputCacheMissPer1M
  const outputUsd = (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  return {
    currency: "USD",
    model: normalizedModel,
    inputCacheHitUsd: roundUsd(inputCacheHitUsd),
    inputCacheMissUsd: roundUsd(inputCacheMissUsd),
    outputUsd: roundUsd(outputUsd),
    totalUsd: roundUsd(inputCacheHitUsd + inputCacheMissUsd + outputUsd),
    pricing: {
      ...pricing,
      source: DEEPSEEK_PRICING_SOURCE,
    },
  }
}

function modelForCost(options: SweBenchOptions, context: RunContext): string | undefined {
  return options.model ?? process.env.LIGHT_CC_MODEL ?? process.env.OPENAI_MODEL ?? context.modelNameOrPath
}

function normalizeModelName(model: string): string {
  return model.replace(/^light-cc-coder\//, "").toLowerCase()
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8))
}

async function writeRunFiles(reportDir: string, summary: RunSummary): Promise<void> {
  await writeFile(join(reportDir, "run.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  await writeFile(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
}

async function buildSummary(input: {
  status: RunSummary["status"]
  startedAt: Date
  startedMs: number
  options: SweBenchOptions
  context: RunContext
  instances: SweBenchInstance[]
  results: SweBenchTaskResult[]
  evaluator?: RunSummary["evaluator"]
  error?: string
}): Promise<RunSummary> {
  const usage = sumUsage(input.results)
  const totals = {
    selected: input.instances.length,
    prepared: input.results.filter((result) => result.status === "prepared").length,
    completed: input.results.filter((result) => result.status === "completed").length,
    failed: input.results.filter((result) => result.status === "failed").length,
    skipped: input.results.filter((result) => result.status === "skipped").length,
    emptyPatch: input.results.filter((result) => !result.prediction?.model_patch).length,
    agentFailed: input.results.filter((result) => result.status === "failed").length,
  }
  return {
    schemaVersion: 1,
    runId: input.context.runId,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - input.startedMs,
    reportDir: input.context.reportDir,
    predictionsPath: input.context.predictionsPath,
    mode: {
      dryRun: isDryRun(input.options),
      runAgent: input.options.runAgent,
      evaluate: input.options.evaluate,
      gold: input.options.gold,
    },
    swebench: {
      ...SWE_BENCH_LITE_DEFAULTS,
      datasetName: input.options.datasetName,
      split: input.options.split,
      datasetRevision: input.options.datasetRevision,
    },
    environment: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      git: await readGitState(),
    },
    selectedInstances: input.instances.map((instance) => instance.instance_id),
    totals,
    usage,
    cost: estimateCost(usage, modelForCost(input.options, input.context)),
    results: input.results,
    evaluator: input.evaluator,
    error: input.error,
  }
}

async function readGitState(): Promise<RunSummary["environment"]["git"]> {
  const commit = await runCommand(["git", "rev-parse", "HEAD"], process.cwd()).catch(() => undefined)
  const branch = await runCommand(["git", "branch", "--show-current"], process.cwd()).catch(() => undefined)
  const status = await runCommand(["git", "status", "--porcelain"], process.cwd()).catch(() => undefined)
  return {
    commit: commit?.exitCode === 0 ? commit.stdout.trim() : undefined,
    branch: branch?.exitCode === 0 ? branch.stdout.trim() : undefined,
    dirty: status?.exitCode === 0 ? status.stdout.trim().length > 0 : undefined,
  }
}

function printSummary(summary: RunSummary): void {
  console.log(
    `SWE-bench ${summary.mode.dryRun ? "dry-run" : "run"}: selected=${summary.totals.selected} completed=${summary.totals.completed} failed=${summary.totals.failed} empty_patch=${summary.totals.emptyPatch}`,
  )
  if (summary.usage) {
    const cost = summary.cost ? ` cost=$${summary.cost.totalUsd.toFixed(6)}` : ""
    console.log(
      `Usage: requests=${summary.usage.requests} input=${summary.usage.inputTokens} output=${summary.usage.outputTokens} cache_hit=${summary.usage.promptCacheHitTokens} cache_miss=${summary.usage.promptCacheMissTokens}${cost}`,
    )
  }
  console.log(`Artifacts: ${summary.reportDir}`)
}

async function runPreflight(
  options: SweBenchOptions,
  context: RunContext,
  startedAt: Date,
  startedMs: number,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = []

  const python = await runCheck([options.python, "--version"])
  checks.push({
    name: "python",
    status: python.ok && python.stdoutOrStderr.includes("Python 3.") ? "pass" : "fail",
    detail: python.ok ? python.stdoutOrStderr.trim() : python.error,
    command: [options.python, "--version"],
  })

  const swebench = await runCheck([
    options.python,
    "-c",
    "import importlib.metadata as m; print(m.version('swebench'))",
  ])
  const swebenchVersion = swebench.stdoutOrStderr.trim()
  checks.push({
    name: "swebench-package",
    status: !swebench.ok ? "fail" : swebenchVersion === "4.1.0" ? "pass" : "warn",
    detail: !swebench.ok
      ? "Missing swebench package; install swebench==4.1.0 before evaluator smoke."
      : swebenchVersion === "4.1.0"
        ? "swebench==4.1.0"
        : `Installed swebench ${swebenchVersion}; expected 4.1.0.`,
    command: [options.python, "-c", "import importlib.metadata as m; print(m.version('swebench'))"],
  })

  const datasets = await runCheck([
    options.python,
    "-c",
    "import importlib.metadata as m; print(m.version('datasets'))",
  ])
  checks.push({
    name: "datasets-package",
    status: datasets.ok ? "pass" : "fail",
    detail: datasets.ok ? `datasets==${datasets.stdoutOrStderr.trim()}` : "Missing datasets package; needed to load pinned instances.",
    command: [options.python, "-c", "import importlib.metadata as m; print(m.version('datasets'))"],
  })

  const dockerVersion = await runCheck(["docker", "--version"])
  checks.push({
    name: "docker-cli",
    status: dockerVersion.ok ? "pass" : "fail",
    detail: dockerVersion.ok ? dockerVersion.stdoutOrStderr.trim() : dockerVersion.error,
    command: ["docker", "--version"],
  })

  const dockerInfo = await runCheck(["docker", "info"])
  const dockerInfoText = dockerInfo.stdoutOrStderr
  checks.push({
    name: "docker-daemon",
    status: dockerInfo.ok && !/Cannot connect to the Docker daemon/i.test(dockerInfoText) ? "pass" : "fail",
    detail:
      dockerInfo.ok && !/Cannot connect to the Docker daemon/i.test(dockerInfoText)
        ? "Docker daemon is reachable."
        : "Docker daemon is not reachable; start Docker Desktop before evaluator smoke.",
    command: ["docker", "info"],
  })

  const disk = await runCheck(["df", "-k", "."])
  const availableGiB = disk.ok ? parseAvailableGiB(disk.stdoutOrStderr) : undefined
  checks.push({
    name: "disk-space",
    status: availableGiB === undefined ? "warn" : availableGiB >= 120 ? "pass" : "fail",
    detail:
      availableGiB === undefined
        ? "Could not parse available disk space."
        : `${availableGiB.toFixed(1)} GiB available; SWE-bench Docker smoke should have roughly 120 GiB free.`,
    command: ["df", "-k", "."],
  })

  if (process.platform === "darwin" && process.arch === "arm64") {
    checks.push({
      name: "mac-arm-note",
      status: "warn",
      detail: "This machine is darwin/arm64. If evaluator image pulls fail, retry with --namespace \"\" to force local image namespace behavior.",
    })
  }

  const failed = checks.some((check) => check.status === "fail")
  return {
    schemaVersion: 1,
    runId: context.runId,
    status: failed ? "failed" : "passed",
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    reportDir: context.reportDir,
    checks,
  }
}

function printPreflight(report: PreflightReport): void {
  for (const check of report.checks) {
    const mark = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL"
    console.log(`${mark} ${check.name} - ${check.detail}`)
  }
  console.log(`Artifacts: ${report.reportDir}`)
}

async function runCheck(args: string[]): Promise<{ ok: boolean; stdoutOrStderr: string; error: string }> {
  try {
    const result = await runCommand(args, process.cwd())
    const stdoutOrStderr = result.stdout.trim() ? result.stdout : result.stderr
    return {
      ok: result.exitCode === 0,
      stdoutOrStderr,
      error: stdoutOrStderr.trim() || `exit ${result.exitCode}`,
    }
  } catch (error) {
    return { ok: false, stdoutOrStderr: "", error: stringifyError(error) }
  }
}

function parseAvailableGiB(dfOutput: string): number | undefined {
  const lines = dfOutput.trim().split(/\r?\n/)
  const data = lines[1]
  if (!data) return undefined
  const parts = data.trim().split(/\s+/)
  const availableKb = Number(parts[3])
  if (!Number.isFinite(availableKb)) return undefined
  return availableKb / 1024 / 1024
}

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
  const startedMs = Date.now()
  const proc = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    args,
    cwd,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedMs,
  }
}

function normalizeOptions(options: SweBenchOptions): SweBenchOptions {
  if (options.dryRunExplicit && (options.runAgent || options.evaluate || options.gold)) {
    throw new Error("Use --dry-run separately from --run-agent, --evaluate, or --gold")
  }
  if (options.gold) options.evaluate = true
  if (options.evaluate && !options.runAgent && !options.gold && !options.predictionsPath) {
    throw new Error("--evaluate without --run-agent requires --predictions-path or --gold")
  }
  return options
}

function parseArgs(argv: string[]): SweBenchOptions {
  const options: SweBenchOptions = {
    instances: [],
    datasetName: SWE_BENCH_LITE_DEFAULTS.datasetName,
    split: SWE_BENCH_LITE_DEFAULTS.split,
    datasetRevision: SWE_BENCH_LITE_DEFAULTS.datasetRevision,
    keepWorkspaces: false,
    preflight: false,
    runAgent: false,
    evaluate: false,
    dryRunExplicit: false,
    gold: false,
    allowLargeRun: false,
    python: "python3",
    maxWorkers: 1,
    apiKeyEnv: process.env.LIGHT_CC_API_KEY_ENV ?? "OPENAI_API_KEY",
    maxSteps: 80,
    permissionMode: "danger-full-access",
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--instances-file") options.instancesFile = requireValue(argv, ++index, arg)
    else if (arg === "--instance") options.instances.push(requireValue(argv, ++index, arg))
    else if (arg === "--limit") options.limit = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--dataset-name") options.datasetName = requireValue(argv, ++index, arg)
    else if (arg === "--split") options.split = requireValue(argv, ++index, arg)
    else if (arg === "--dataset-revision") options.datasetRevision = requireValue(argv, ++index, arg)
    else if (arg === "--run-id") options.runId = requireValue(argv, ++index, arg)
    else if (arg === "--report-dir") options.reportDir = requireValue(argv, ++index, arg)
    else if (arg === "--work-dir") options.workDir = requireValue(argv, ++index, arg)
    else if (arg === "--keep-workspaces") options.keepWorkspaces = true
    else if (arg === "--preflight") options.preflight = true
    else if (arg === "--run-agent") options.runAgent = true
    else if (arg === "--evaluate") options.evaluate = true
    else if (arg === "--no-evaluate") options.evaluate = false
    else if (arg === "--dry-run") options.dryRunExplicit = true
    else if (arg === "--gold") options.gold = true
    else if (arg === "--allow-large-run") options.allowLargeRun = true
    else if (arg === "--predictions-path") options.predictionsPath = requireValue(argv, ++index, arg)
    else if (arg === "--python") options.python = requireValue(argv, ++index, arg)
    else if (arg === "--max-workers") options.maxWorkers = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--model") options.model = requireValue(argv, ++index, arg)
    else if (arg === "--model-name" || arg === "--model-name-or-path")
      options.modelNameOrPath = requireValue(argv, ++index, arg)
    else if (arg === "--base-url") options.baseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--max-steps") options.maxSteps = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--permission-mode") options.permissionMode = parsePermissionMode(requireValue(argv, ++index, arg))
    else if (arg === "--namespace") options.evaluatorNamespace = requireValueAllowEmpty(argv, ++index, arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function buildRunContext(options: SweBenchOptions): RunContext {
  const runId = options.runId ?? defaultRunId()
  const reportDir = resolve(options.reportDir ?? join(process.cwd(), ".light-cc", "evals", runId, "swebench"))
  const workDirIsDefault = !options.workDir
  const workDir = resolve(options.workDir ?? join(reportDir, "workspaces"))
  const predictionsPath = resolve(options.predictionsPath ?? join(reportDir, "predictions.jsonl"))
  return {
    runId,
    reportDir,
    workDir,
    workDirIsDefault,
    predictionsPath,
    modelNameOrPath:
      options.modelNameOrPath ??
      (options.model ? `light-cc-coder/${options.model}` : process.env.OPENAI_MODEL ? `light-cc-coder/${process.env.OPENAI_MODEL}` : "light-cc-coder"),
  }
}

function summarizePatch(patch: string): { patchLines: number; changedFiles: string[] } {
  const changedFiles: string[] = []
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    changedFiles.push(match[2])
  }
  return {
    patchLines: patch.length === 0 ? 0 : patch.split(/\r?\n/).length,
    changedFiles,
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_")
}

function defaultRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")
  const suffix = createHash("sha256").update(`${timestamp}-${Math.random()}`).digest("hex").slice(0, 8)
  return `swebench-${timestamp}-${suffix}`
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected SWE-bench instance record")
  }
  return value as Record<string, unknown>
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ""
}

function parsePermissionMode(value: string): PermissionMode {
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

function requireValueAllowEmpty(argv: string[], index: number, flag: string): string {
  if (index >= argv.length) throw new Error(`${flag} requires a value`)
  return argv[index]
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(): string {
  return [
    "Usage: bun run eval:swebench -- --instance <id> [--dry-run|--run-agent|--evaluate]",
    "       bun run eval:swebench -- --instances-file evals/swebench/fixtures/sample-instance.json --dry-run",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
