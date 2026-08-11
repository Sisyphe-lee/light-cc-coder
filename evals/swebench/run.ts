#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { TokenUsage } from "../../src/core/messages"
import type { PermissionMode } from "../../src/permissions/types"
import type { ProfileReport } from "../../profiling/report/types"
import { DEFAULT_EVAL_MODEL } from "../adapters/defaults"
import { buildCoderCommand, loadCoderAdapter } from "../adapters/coders/loader"
import type { CoderAdapter, RenderedCoderCommand } from "../adapters/coders/types"
import { collectGitPatchSinceBase, type GitPatchCollection } from "../git-patch"
import { WRAPPER_PROFILE_SCHEMA_VERSION, type WrapperProfile, type WrapperProfileArtifactRef } from "../wrapper-profile/types"
import { buildSweBenchPrompt } from "./prompt"
import {
  SWE_BENCH_DEFAULT_PROFILE,
  safeInstanceFromRecord,
  SWE_BENCH_PROFILES,
  type SweBenchCostEstimate,
  type EvalAgentProfileSummary,
  type SweBenchInstance,
  type SweBenchPrediction,
  type SweBenchProfile,
  type SweBenchTaskResult,
  type SweBenchUsageTotals,
} from "./types"

type SweBenchOptions = {
  profile: SweBenchProfile
  instancesFile?: string
  tasksetFile?: string
  writeTasksetFile?: string
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
  coder: string
  maxSteps: number
  agentTimeoutMs?: number
  permissionMode: PermissionMode
  evaluatorNamespace?: string
  evaluatorCacheLevel?: string
  evaluatorClean?: boolean
  evaluatorTimeout?: number
  evaluatorInstanceImageTag?: string
  evaluatorEnvImageTag?: string
  agentProfile: boolean
  repoCacheDir?: string
  offline: boolean
}

export type SweBenchRepoCheckoutOptions = {
  repoCacheDir?: string
  offline?: boolean
}

type RunContext = {
  runId: string
  reportDir: string
  workDir: string
  workDirIsDefault: boolean
  predictionsPath: string
  modelNameOrPath: string
}

export type CommandResult = {
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut?: boolean
}

type RunCommandOptions = {
  timeoutMs?: number
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

type RepoCacheEntry = {
  repo: string
  mirrorPath?: string
  status: "available" | "missing" | "not-configured"
}

type SweBenchReadiness = {
  offline: boolean
  taskset: {
    source?: string
    sourceKind?: "instances" | "ids" | "dataset"
    writePath?: string
    selected: number
  }
  repoCache: {
    dir?: string
    ready: boolean
    repos: RepoCacheEntry[]
  }
}

type LoadedInstances = {
  instances: SweBenchInstance[]
  source?: string
  sourceKind: SweBenchReadiness["taskset"]["sourceKind"]
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
  patchBaseHead?: string
  committedChangesCollected?: boolean
  headDiffMissedChanges?: boolean
  usage?: SweBenchUsageTotals
  cost?: SweBenchCostEstimate
  profileReportPath?: string
  wrapperProfilePath?: string
  profile?: EvalAgentProfileSummary
  agentExitCode?: number
  agentFailed: boolean
  agentStdoutPath?: string
  agentStderrPath?: string
  workspace?: string
  commands?: CommandResult[]
  error?: string
}

type AgentCommand = {
  args: string[]
  cwd: string
  env: Record<string, string>
  transcriptPath?: string
  usage: RenderedCoderCommand["artifacts"]["usage"]
  requiredEnv: string[]
  forwardedEnv: string[]
}

export type LightccSweBenchAgentArgsInput = {
  promptPath: string
  workspace: string
  agentDir: string
  transcriptPath: string
  permissionMode: PermissionMode
  maxSteps: number
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  agentProfile?: boolean
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
    agentProfile: boolean
  }
  coder: {
    id: string
    displayName: string
    status: CoderAdapter["status"]
    installKind: string
    installPackage?: string
  }
  swebench: {
    benchmarkProfile: SweBenchProfile
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
  readiness?: SweBenchReadiness
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
  let loadedInstances: LoadedInstances | undefined
  let evaluator: RunSummary["evaluator"] | undefined
  let coderAdapter: CoderAdapter | undefined

  try {
    coderAdapter = await loadCoderAdapter(options.coder)
    context.modelNameOrPath = defaultModelNameOrPath(options, coderAdapter)
    validateCoderForSweBenchRun(options, coderAdapter)

    if (options.preflight) {
      const report = await runPreflight(options, context, startedAt, startedMs)
      await writeFile(join(context.reportDir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
      await writeFile(join(context.reportDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
      printPreflight(report)
      return report.status === "passed" ? 0 : 1
    }

    validateSelectionRequest(options)
    loadedInstances = await loadInstances(options, context.reportDir)
    instances = loadedInstances.instances
    validateRunSize(instances, options)
    await writeSelectedInstances(context.reportDir, instances, options)

    for (const instance of instances) {
      const result = options.runAgent
        ? await runAgentInstance(instance, options, context, coderAdapter)
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
      coderAdapter,
      instances,
      loadedInstances,
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
      coderAdapter,
      instances,
      loadedInstances,
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
    patchSha256: sha256(""),
    patchBytes: 0,
    patchLines: 0,
    changedFiles: [],
    emptyPatch: true,
    prediction,
  }
}

async function runAgentInstance(
  instance: SweBenchInstance,
  options: SweBenchOptions,
  context: RunContext,
  coderAdapter: CoderAdapter,
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
  let agentCommand: AgentCommand | undefined
  let baseHead: string | undefined
  let patchCollection: GitPatchCollection | undefined

  try {
    validateCoderForAgentRun(coderAdapter)
    commands.push(...(await checkoutSweBenchRepo(instance, workspace, options)))
    const baseHeadCommand = await runCommand(["git", "rev-parse", "HEAD"], workspace)
    commands.push(baseHeadCommand)
    if (baseHeadCommand.exitCode !== 0) {
      throw new Error(`Unable to read workspace base HEAD: ${firstLine(baseHeadCommand.stderr) || `exit ${baseHeadCommand.exitCode}`}`)
    }
    baseHead = baseHeadCommand.stdout.trim()
    if (!baseHead) throw new Error("Unable to read workspace base HEAD: empty rev-parse output")

    const agentDir = join(artifactDir, "agent")
    await mkdir(agentDir, { recursive: true })
    const transcriptPath = join(agentDir, "transcript.jsonl")
    agentCommand = buildAgentCommand(coderAdapter, options, prepared.promptPath ?? "", workspace, agentDir)
    await prepareAgentEnvironment(agentCommand.env)
    const agent = await runCommand(agentCommand.args, agentCommand.cwd, agentCommand.env, {
      timeoutMs: options.agentTimeoutMs,
    })
    commands.push(agent)
    const agentLogs = await persistAgentCommandOutput(agentDir, agentCommand.transcriptPath ?? transcriptPath, agent)
    agentExitCode = agent.exitCode
    const profile =
      options.agentProfile && coderAdapter.id === "lightcc"
        ? await writeAgentProfileReport(agentCommand.transcriptPath ?? transcriptPath, join(agentDir, "profile.report.json"))
        : undefined
    const usage =
      agentCommand.usage === "lightcc-transcript" ? await readAgentUsage(agentCommand.transcriptPath ?? transcriptPath) : undefined
    const cost = estimateCost(usage, modelForCost(options, context))

    patchCollection = await collectGitPatchSinceBase(workspace, baseHead)
    commands.push(...patchCollection.commands)
    patch = patchCollection.patch
    if (patchCollection.error) error = patchCollection.error

    await writeFile(prepared.patchPath ?? join(artifactDir, "patch.diff"), patch, "utf8")
    const patchSummary = summarizePatch(patch)
    const status: SweBenchTaskResult["status"] = error || agentExitCode !== 0 ? "failed" : "completed"
    const wrapperProfilePath = await writeSweBenchWrapperProfile({
      coderAdapter,
      context,
      instance,
      agentCommand,
      agent,
      agentDir,
      artifactDir,
      workspace,
      promptPath: prepared.promptPath,
      patchPath: prepared.patchPath ?? join(artifactDir, "patch.diff"),
      transcriptPath: agentCommand.transcriptPath ?? transcriptPath,
      stdoutPath: agentLogs.stdoutPath,
      stderrPath: agentLogs.stderrPath,
      resultPath: join(agentDir, "result.json"),
      profileReportPath: profile?.reportPath,
      warnings: [
        ...(agent.timedOut && options.agentTimeoutMs ? [`agent_timed_out_after_ms=${options.agentTimeoutMs}`] : []),
        ...patchCollectionWarnings(patchCollection),
      ],
    })
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
      patchBaseHead: baseHead,
      committedChangesCollected: patchCollection.committedChangesCollected,
      headDiffMissedChanges: patchCollection.headDiffMissedChanges,
      usage,
      cost,
      profileReportPath: profile?.reportPath,
      wrapperProfilePath,
      profile,
      agentExitCode,
      agentFailed: agentExitCode !== 0,
      agentStdoutPath: agentLogs.stdoutPath,
      agentStderrPath: agentLogs.stderrPath,
      workspace,
      commands,
      error: error ?? (agentExitCode !== 0 ? `agent exited ${agentExitCode}` : undefined),
    })
    return {
      ...prepared,
      status,
      workspace,
      transcriptPath: agentCommand.transcriptPath ?? transcriptPath,
      profileReportPath: profile?.reportPath,
      wrapperProfilePath,
      profile,
      agentSummaryPath: join(agentDir, "summary.json"),
      patchSha256: sha256(patch),
      patchBytes: Buffer.byteLength(patch),
      patchLines: patchSummary.patchLines,
      changedFiles: patchSummary.changedFiles,
      emptyPatch: patch.length === 0,
      patchBaseHead: baseHead,
      committedChangesCollected: patchCollection.committedChangesCollected,
      headDiffMissedChanges: patchCollection.headDiffMissedChanges,
      usage,
      cost,
      prediction: makePrediction(instance.instance_id, context.modelNameOrPath, patch),
      error: error ?? (agentExitCode !== 0 ? `agent exited ${agentExitCode}` : undefined),
    }
  } catch (caught) {
    error = stringifyError(caught)
    const transcriptPath = join(artifactDir, "agent", "transcript.jsonl")
    const profile =
      options.agentProfile && coderAdapter.id === "lightcc"
        ? await writeAgentProfileReport(transcriptPath, join(artifactDir, "agent", "profile.report.json"))
        : undefined
    const usage = coderAdapter.artifacts?.usage === "lightcc-transcript" ? await readAgentUsage(transcriptPath) : undefined
    const cost = estimateCost(usage, modelForCost(options, context))
    await writeFile(prepared.patchPath ?? join(artifactDir, "patch.diff"), patch, "utf8")
    const agentDir = join(artifactDir, "agent")
    const wrapperProfilePath = agentCommand
      ? await writeSweBenchWrapperProfile({
          coderAdapter,
          context,
          instance,
          agentCommand,
          agent: {
            args: agentCommand.args,
            cwd: agentCommand.cwd,
            exitCode: agentExitCode ?? -1,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - startedMs,
          },
          agentDir,
          artifactDir,
          workspace,
          promptPath: prepared.promptPath,
          patchPath: prepared.patchPath ?? join(artifactDir, "patch.diff"),
          transcriptPath,
          stdoutPath: join(agentDir, "stdout.log"),
          stderrPath: join(agentDir, "stderr.log"),
          resultPath: join(agentDir, "result.json"),
          profileReportPath: profile?.reportPath,
          warnings: ["agent command failed before normal wrapper profile finalization"],
        })
      : undefined
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
      patchBaseHead: baseHead,
      committedChangesCollected: patchCollection?.committedChangesCollected,
      headDiffMissedChanges: patchCollection?.headDiffMissedChanges,
      usage,
      cost,
      profileReportPath: profile?.reportPath,
      wrapperProfilePath,
      profile,
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
      profileReportPath: profile?.reportPath,
      wrapperProfilePath,
      profile,
      patchSha256: sha256(patch),
      patchBytes: Buffer.byteLength(patch),
      patchLines: summarizePatch(patch).patchLines,
      changedFiles: summarizePatch(patch).changedFiles,
      emptyPatch: patch.length === 0,
      patchBaseHead: baseHead,
      committedChangesCollected: patchCollection?.committedChangesCollected,
      headDiffMissedChanges: patchCollection?.headDiffMissedChanges,
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

export async function checkoutSweBenchRepo(
  instance: SweBenchInstance,
  workspace: string,
  options: SweBenchRepoCheckoutOptions = {},
): Promise<CommandResult[]> {
  if (existsSync(workspace)) {
    throw new Error(`Workspace already exists for ${instance.instance_id}: ${workspace}`)
  }
  await mkdir(dirname(workspace), { recursive: true })
  const mirror = await findRepoMirror(instance.repo, options.repoCacheDir)
  if (mirror.status === "available" && mirror.mirrorPath) {
    return checkoutWorkspaceFromMirror(instance, workspace, mirror.mirrorPath)
  }
  if (options.offline) {
    const cacheHint = options.repoCacheDir ? ` in ${resolve(options.repoCacheDir)}` : "; pass --repo-cache-dir"
    throw new Error(`Missing cached repo mirror for ${instance.repo}${cacheHint}`)
  }
  return checkoutWorkspaceFromGitHub(instance, workspace)
}

async function checkoutWorkspaceFromGitHub(instance: SweBenchInstance, workspace: string): Promise<CommandResult[]> {
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

async function checkoutWorkspaceFromMirror(
  instance: SweBenchInstance,
  workspace: string,
  mirrorPath: string,
): Promise<CommandResult[]> {
  const commands = [
    await runCommand(["git", "clone", "--no-checkout", "--local", mirrorPath, workspace], process.cwd()),
    await runCommand(["git", "-C", workspace, "checkout", "--detach", instance.base_commit], process.cwd()),
    await runCommand(["git", "-C", workspace, "remote", "remove", "origin"], process.cwd()),
  ]
  const failed = commands.find((command) => command.exitCode !== 0)
  if (failed) {
    throw new Error(`Workspace preparation failed: ${failed.args.join(" ")}: ${firstLine(failed.stderr)}`)
  }
  return commands
}

async function findRepoMirror(repo: string, repoCacheDir: string | undefined): Promise<RepoCacheEntry> {
  if (!repoCacheDir) return { repo, status: "not-configured" }
  for (const candidate of repoMirrorCandidates(repo, resolve(repoCacheDir))) {
    if (await isDirectory(candidate)) {
      return { repo, mirrorPath: candidate, status: "available" }
    }
  }
  return { repo, status: "missing" }
}

function repoMirrorCandidates(repo: string, repoCacheDir: string): string[] {
  const [owner, name] = repo.split("/")
  const candidates = [
    join(repoCacheDir, `${owner}__${name}.git`),
    join(repoCacheDir, owner, `${name}.git`),
    join(repoCacheDir, `${owner}__${name}`),
    join(repoCacheDir, owner, name),
    join(repoCacheDir, `${sanitizePathSegment(repo)}.git`),
    join(repoCacheDir, sanitizePathSegment(repo)),
  ]
  return [...new Set(candidates)]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function validateCoderForAgentRun(adapter: CoderAdapter): void {
  if (adapter.status !== "ready") {
    throw new Error(`Coder adapter ${adapter.id} is ${adapter.status}; real --run-agent requires a ready adapter`)
  }
  if (!adapter.targets.includes("swebench")) {
    throw new Error(`Coder adapter ${adapter.id} does not support swebench`)
  }
}

function validateCoderForSweBenchRun(options: SweBenchOptions, adapter: CoderAdapter): void {
  if (!adapter.targets.includes("swebench")) {
    throw new Error(`Coder adapter ${adapter.id} does not support swebench`)
  }
  if (options.runAgent && adapter.status !== "ready") {
    throw new Error(`Coder adapter ${adapter.id} is ${adapter.status}; real --run-agent requires a ready adapter`)
  }
}

function buildAgentCommand(
  adapter: CoderAdapter,
  options: SweBenchOptions,
  promptPath: string,
  workspace: string,
  agentDir: string,
): AgentCommand {
  if (adapter.id === "lightcc") {
    const transcriptPath = join(agentDir, "transcript.jsonl")
    const args = buildLightccSweBenchAgentArgs({
      promptPath,
      workspace,
      agentDir,
      transcriptPath,
      permissionMode: options.permissionMode,
      maxSteps: options.maxSteps,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKeyEnv: options.apiKeyEnv,
      agentProfile: options.agentProfile,
    })
    return {
      args,
      cwd: process.cwd(),
      env: {},
      transcriptPath,
      usage: "lightcc-transcript",
      requiredEnv: [options.apiKeyEnv],
      forwardedEnv: [options.apiKeyEnv],
    }
  }

  const transcriptPath = join(agentDir, "transcript.jsonl")
  const patchPath = join(agentDir, "patch.diff")
  const rendered = buildCoderCommand(adapter, {
    instruction: "",
    promptFile: promptPath,
    workspace,
    artifactDir: agentDir,
    transcriptPath,
    patchPath,
    resultPath: join(agentDir, "result.json"),
    model: options.model ?? process.env.LIGHT_CC_MODEL ?? process.env.OPENAI_MODEL ?? "",
    baseUrl: options.baseUrl ?? process.env.LIGHT_CC_BASE_URL ?? "",
    apiKeyEnv: options.apiKeyEnv,
    maxSteps: String(options.maxSteps),
    permissionMode: options.permissionMode,
    osSandbox: "off",
    sandboxSettings: "",
    executable: adapter.command.executable,
  })
  const env = Object.fromEntries(Object.entries(rendered.env).filter(([, value]) => value.length > 0))
  const apiKeyValue = process.env[options.apiKeyEnv]
  if (apiKeyValue) {
    for (const requiredEnv of rendered.requiredEnv) {
      if (!env[requiredEnv] && requiredEnv !== options.apiKeyEnv) {
        env[requiredEnv] = apiKeyValue
      }
    }
  }
  return {
    args: [rendered.executable, ...rendered.args],
    cwd: rendered.cwd ?? workspace,
    env: isolateExternalAgentEnv(env, agentDir),
    transcriptPath: rendered.artifacts.transcript,
    usage: rendered.artifacts.usage,
    requiredEnv: [...new Set([options.apiKeyEnv, ...rendered.requiredEnv])],
    forwardedEnv: [...new Set(Object.keys(env))],
  }
}

export function buildLightccSweBenchAgentArgs(input: LightccSweBenchAgentArgsInput): string[] {
  const args = [
    process.execPath,
    "src/cli/main.ts",
    "--prompt-file",
    input.promptPath,
    "--cwd",
    input.workspace,
    "--artifact-dir",
    input.agentDir,
    "--transcript",
    input.transcriptPath,
    "--quiet",
    "--permission-mode",
    input.permissionMode,
    "--max-steps",
    String(input.maxSteps),
    "--os-sandbox",
    "off",
  ]
  if (input.model) args.push("--model", input.model)
  if (input.baseUrl) args.push("--base-url", input.baseUrl)
  if (input.apiKeyEnv) args.push("--api-key-env", input.apiKeyEnv)
  if (input.agentProfile) args.push("--profile")
  return args
}

async function prepareAgentEnvironment(env: Record<string, string>): Promise<void> {
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "KIMI_CODE_HOME"]) {
    const value = env[key]
    if (value) await mkdir(value, { recursive: true })
  }
}

async function persistAgentCommandOutput(
  agentDir: string,
  transcriptPath: string,
  agent: CommandResult,
): Promise<{ stdoutPath: string; stderrPath: string }> {
  await mkdir(dirname(transcriptPath), { recursive: true })
  const stdoutPath = join(agentDir, "stdout.log")
  const stderrPath = join(agentDir, "stderr.log")
  await writeFile(stdoutPath, agent.stdout, "utf8")
  await writeFile(stderrPath, agent.stderr, "utf8")
  if (!existsSync(transcriptPath) && agent.stdout.trim().length > 0) {
    await writeFile(transcriptPath, agent.stdout, "utf8")
  }
  return { stdoutPath, stderrPath }
}

async function writeSweBenchWrapperProfile(input: {
  coderAdapter: CoderAdapter
  context: RunContext
  instance: SweBenchInstance
  agentCommand: AgentCommand
  agent: CommandResult
  agentDir: string
  artifactDir: string
  workspace: string
  promptPath?: string
  patchPath?: string
  transcriptPath?: string
  stdoutPath?: string
  stderrPath?: string
  resultPath?: string
  profileReportPath?: string
  warnings?: string[]
}): Promise<string> {
  const profilePath = join(input.agentDir, "wrapper.profile.json")
  await mkdir(input.agentDir, { recursive: true })
  const requiredNames = uniqueEnvNames(input.agentCommand.requiredEnv)
  const forwardedNames = uniqueEnvNames([...input.agentCommand.forwardedEnv, ...Object.keys(input.agentCommand.env)])
  const presentNames = requiredNames.filter((name) => process.env[name] !== undefined || input.agentCommand.env[name] !== undefined)
  const missingNames = requiredNames.filter((name) => !presentNames.includes(name))
  const artifacts = (
    await Promise.all([
      artifactRef("prompt", input.promptPath),
      artifactRef("transcript", input.transcriptPath),
      artifactRef("stdout", input.stdoutPath),
      artifactRef("stderr", input.stderrPath),
      artifactRef("patch", input.patchPath),
      artifactRef("result", input.resultPath),
      artifactRef("summary", input.profileReportPath),
    ])
  ).filter((artifact): artifact is WrapperProfileArtifactRef => Boolean(artifact))
  artifacts.push({ kind: "workspace", path: input.workspace, bytes: null, sha256: null })

  const profile: WrapperProfile = {
    schemaVersion: WRAPPER_PROFILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    wrapper: {
      id: input.coderAdapter.id,
      displayName: input.coderAdapter.displayName,
      runtime: input.coderAdapter.id === "lightcc" ? "lightcc-swebench-runner" : "external-swebench-runner",
    },
    run: {
      benchmark: "swebench",
      runId: input.context.runId,
      itemId: input.instance.instance_id,
    },
    command: {
      executablePath: input.agentCommand.args[0],
      cwd: input.agentCommand.cwd,
      argCount: input.agentCommand.args.length,
      argsSha256: sha256(JSON.stringify(input.agentCommand.args)),
    },
    artifacts,
    environment: {
      requiredNames,
      forwardedNames,
      presentNames,
      missingNames,
    },
    process: {
      exitCode: input.agent.exitCode,
      durationMs: input.agent.durationMs,
    },
    warnings: input.warnings ?? [],
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8")
  return profilePath
}

async function artifactRef(
  kind: WrapperProfileArtifactRef["kind"],
  path: string | undefined,
): Promise<WrapperProfileArtifactRef | undefined> {
  if (!path || !existsSync(path)) return undefined
  const info = await stat(path)
  if (!info.isFile()) return { kind, path, bytes: null, sha256: null }
  const content = await readFile(path)
  return {
    kind,
    path,
    bytes: info.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  }
}

function uniqueEnvNames(names: string[]): string[] {
  return [...new Set(names.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))].sort()
}

function isolateExternalAgentEnv(env: Record<string, string>, agentDir: string): Record<string, string> {
  return {
    ...env,
    HOME: join(agentDir, "home"),
    XDG_CONFIG_HOME: join(agentDir, "xdg-config"),
    XDG_CACHE_HOME: join(agentDir, "xdg-cache"),
    PYTHONNOUSERSITE: "1",
  }
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
  if (options.evaluatorCacheLevel) args.push("--cache_level", options.evaluatorCacheLevel)
  if (options.evaluatorClean !== undefined) args.push("--clean", String(options.evaluatorClean))
  if (options.evaluatorTimeout !== undefined) args.push("--timeout", String(options.evaluatorTimeout))
  if (options.evaluatorInstanceImageTag) args.push("--instance_image_tag", options.evaluatorInstanceImageTag)
  if (options.evaluatorEnvImageTag) args.push("--env_image_tag", options.evaluatorEnvImageTag)
  if (instances.length > 0) args.push("--instance_ids", ...instances.map((instance) => instance.instance_id))
  const result = await runCommand(args, process.cwd(), offlineEnv(options))
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

async function loadInstances(options: SweBenchOptions, reportDir: string): Promise<LoadedInstances> {
  const datasetDir = join(reportDir, "dataset")
  await mkdir(datasetDir, { recursive: true })

  const tasksetPath = options.tasksetFile ?? options.instancesFile
  if (tasksetPath) {
    const parsed = await parseTasksetFile(tasksetPath)
    if (parsed.kind === "instances") {
      return {
        instances: selectInstances(parsed.instances, options),
        source: resolve(tasksetPath),
        sourceKind: "instances",
      }
    }
    if (options.offline) {
      throw new Error(`--offline requires ${tasksetPath} to contain safe SWE-bench instance records, not only ids`)
    }
    const requested = [...new Set([...parsed.instanceIds, ...options.instances])]
    return {
      instances: await loadInstancesFromDataset({ ...options, instances: requested }, datasetDir),
      source: resolve(tasksetPath),
      sourceKind: "ids",
    }
  }

  if (options.offline) {
    throw new Error("--offline requires --taskset-file or --instances-file with safe SWE-bench instance records")
  }

  return {
    instances: await loadInstancesFromDataset(options, datasetDir),
    sourceKind: "dataset",
  }
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
  const result = await runCommand(args, process.cwd(), offlineEnv(options))
  await writeFile(join(datasetDir, "loader-command.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
  if (result.exitCode !== 0) {
    throw new Error(`Failed to load SWE-bench instances: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  }
  const records = JSON.parse(await readFile(output, "utf8")) as unknown[]
  return selectInstances(records.map(assertRecord).map(safeInstanceFromRecord), options)
}

async function parseTasksetFile(
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
  if (!options.instancesFile && !options.tasksetFile && options.instances.length === 0 && options.limit === undefined) {
    throw new Error("Refusing to load the full split; pass --instance, --limit, --instances-file, or --taskset-file")
  }
}

async function writeSelectedInstances(reportDir: string, instances: SweBenchInstance[], options: SweBenchOptions): Promise<void> {
  const datasetDir = join(reportDir, "dataset")
  await mkdir(datasetDir, { recursive: true })
  await writeFile(join(datasetDir, "instances.json"), `${JSON.stringify(instances, null, 2)}\n`, "utf8")
  await writeFile(
    join(reportDir, "selected_instances.jsonl"),
    `${instances.map((instance) => JSON.stringify(instance)).join("\n")}\n`,
    "utf8",
  )
  await writeSafeTasksetFile(join(reportDir, "taskset.json"), instances)
  await writeSafeTasksetJsonl(join(reportDir, "taskset.jsonl"), instances)
  if (options.writeTasksetFile) {
    await writeSafeTasksetFile(options.writeTasksetFile, instances)
  }
}

async function writeSafeTasksetFile(path: string, instances: SweBenchInstance[]): Promise<void> {
  const resolvedPath = resolve(path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  if (resolvedPath.endsWith(".jsonl")) {
    await writeSafeTasksetJsonl(resolvedPath, instances)
    return
  }
  await writeFile(resolvedPath, `${JSON.stringify(instances, null, 2)}\n`, "utf8")
}

async function writeSafeTasksetJsonl(path: string, instances: SweBenchInstance[]): Promise<void> {
  const resolvedPath = resolve(path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  await writeFile(resolvedPath, `${instances.map((instance) => JSON.stringify(instance)).join("\n")}\n`, "utf8")
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

function offlineEnv(options: SweBenchOptions): Record<string, string> {
  return options.offline
    ? {
        HF_DATASETS_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HF_HUB_OFFLINE: "1",
      }
    : {}
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
  const safeMetrics = {
    ...metrics,
    commands: metrics.commands?.map(redactCommandResultForMetrics),
  }
  await writeFile(join(artifactDir, "metrics.json"), `${JSON.stringify(safeMetrics, null, 2)}\n`, "utf8")
}

function redactCommandResultForMetrics(command: CommandResult): Record<string, unknown> {
  return {
    executablePath: command.args[0],
    argCount: command.args.length,
    argsSha256: sha256(JSON.stringify(command.args)),
    cwd: command.cwd,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    timedOut: command.timedOut === true,
    stdoutBytes: Buffer.byteLength(command.stdout),
    stdoutSha256: sha256(command.stdout),
    stderrBytes: Buffer.byteLength(command.stderr),
    stderrSha256: sha256(command.stderr),
  }
}

async function writeAgentProfileReport(
  transcriptPath: string,
  reportPath: string,
): Promise<EvalAgentProfileSummary | undefined> {
  if (!existsSync(transcriptPath)) return undefined
  const events: Record<string, unknown>[] = []
  for (const line of (await readFile(transcriptPath, "utf8")).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // Ignore partial or malformed transcript lines; the profile reducer records warnings.
    }
  }
  const { summarizeProfile, renderJson } = await import("../../profiling/index")
  const report = summarizeProfile(events, {
    sourceTranscript: transcriptPath,
    generatedAt: new Date().toISOString(),
  }) as ProfileReport
  await writeFile(reportPath, `${renderJson(report)}\n`, "utf8")
  return summarizeAgentProfile(report, reportPath)
}

function summarizeAgentProfile(report: ProfileReport, reportPath: string): EvalAgentProfileSummary {
  return {
    reportPath,
    sourceTranscript: report.sourceTranscript,
    observedDurationMs: report.summary.observedDurationMs,
    profileSpanCount: report.summary.profileSpanCount,
    topBottleneck: report.summary.topBottleneck,
    provider: {
      callCount: report.provider.callCount,
      totalDurationMs: report.provider.totalDurationMs,
      firstTokenMsP50: report.provider.firstTokenMsP50,
      streamMsP50: report.provider.streamMsP50,
      inputTokens: report.provider.inputTokens,
      outputTokens: report.provider.outputTokens,
      cacheReadInputTokens: report.provider.cacheReadInputTokens,
    },
    context: {
      assembleCount: report.context.assembleCount,
      totalDurationMs: report.context.totalDurationMs,
      maxEstimatedTokens: report.context.maxEstimatedTokens,
    },
    runtime: {
      bashCount: report.runtime.bashCount,
      durationMsP50: report.runtime.durationMsP50,
      durationMsMax: report.runtime.durationMsMax,
      nonzeroExitCount: report.runtime.nonzeroExitCount,
    },
    transcriptWrite: {
      writeCount: report.transcriptWrite.writeCount,
      totalDurationMs: report.transcriptWrite.totalDurationMs,
      profilerSpanWriteCount: report.transcriptWrite.profilerSpanWriteCount,
      profilerSpanWriteDurationMs: report.transcriptWrite.profilerSpanWriteDurationMs,
    },
    topSlowSpans: report.topSlowSpans.slice(0, 5).map((span) => ({
      name: span.name,
      category: span.category,
      status: span.status,
      durationMs: span.durationMs,
    })),
    warnings: report.warnings,
  }
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
  const safeSummary = redactRunSummary(summary)
  await writeFile(join(reportDir, "run.json"), `${JSON.stringify(safeSummary, null, 2)}\n`, "utf8")
  await writeFile(join(reportDir, "summary.json"), `${JSON.stringify(safeSummary, null, 2)}\n`, "utf8")
}

function redactRunSummary(summary: RunSummary): Record<string, unknown> {
  return {
    ...summary,
    results: summary.results.map(redactTaskResultForSummary),
  }
}

function redactTaskResultForSummary(result: SweBenchTaskResult): Record<string, unknown> {
  const { prediction, ...safeResult } = result
  if (!prediction) return safeResult
  return {
    ...safeResult,
    prediction: {
      instance_id: prediction.instance_id,
      model_name_or_path: prediction.model_name_or_path,
      model_patch_bytes: Buffer.byteLength(prediction.model_patch),
      model_patch_sha256: sha256(prediction.model_patch),
    },
  }
}

async function buildSummary(input: {
  status: RunSummary["status"]
  startedAt: Date
  startedMs: number
  options: SweBenchOptions
  context: RunContext
  coderAdapter?: CoderAdapter
  instances: SweBenchInstance[]
  loadedInstances?: LoadedInstances
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
    emptyPatch: input.results.filter((result) => result.emptyPatch ?? !result.prediction?.model_patch).length,
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
      agentProfile: input.options.agentProfile,
    },
    coder: coderSummary(input.coderAdapter),
    swebench: {
      packageVersion: SWE_BENCH_PROFILES[input.options.profile].packageVersion,
      benchmarkProfile: input.options.profile,
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
    readiness: await buildReadiness(input.options, input.instances, input.loadedInstances),
    error: input.error,
  }
}

async function buildReadiness(
  options: SweBenchOptions,
  instances: SweBenchInstance[],
  loadedInstances: LoadedInstances | undefined,
): Promise<SweBenchReadiness> {
  const repos = [...new Set(instances.map((instance) => instance.repo))]
  const repoCacheEntries: RepoCacheEntry[] = []
  for (const repo of repos) repoCacheEntries.push(await findRepoMirror(repo, options.repoCacheDir))
  return {
    offline: options.offline,
    taskset: {
      source: loadedInstances?.source,
      sourceKind: loadedInstances?.sourceKind ?? "dataset",
      writePath: options.writeTasksetFile ? resolve(options.writeTasksetFile) : undefined,
      selected: instances.length,
    },
    repoCache: {
      dir: options.repoCacheDir ? resolve(options.repoCacheDir) : undefined,
      ready: repoCacheEntries.length > 0 && repoCacheEntries.every((entry) => entry.status === "available"),
      repos: repoCacheEntries,
    },
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

function coderSummary(adapter: CoderAdapter | undefined): RunSummary["coder"] {
  return {
    id: adapter?.id ?? "lightcc",
    displayName: adapter?.displayName ?? "Light CC Coder",
    status: adapter?.status ?? "ready",
    installKind: adapter?.install.kind ?? "source",
    installPackage: adapter?.install.package,
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
  checks.push(...(await runLocalReadinessChecks(options)))

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

async function runLocalReadinessChecks(options: SweBenchOptions): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  if (options.offline) {
    checks.push({
      name: "offline-mode",
      status: "pass",
      detail: "Offline mode is enabled; dataset loading requires safe taskset records and Python calls receive offline environment variables.",
    })
  }

  const tasksetPath = options.tasksetFile ?? options.instancesFile
  let tasksetInstances: SweBenchInstance[] = []
  if (tasksetPath) {
    try {
      const parsed = await parseTasksetFile(tasksetPath)
      if (parsed.kind === "instances") tasksetInstances = parsed.instances
      checks.push({
        name: "swebench-taskset",
        status: options.offline && parsed.kind === "ids" ? "fail" : "pass",
        detail:
          parsed.kind === "instances"
            ? `${parsed.instances.length} safe SWE-bench instance records in ${resolve(tasksetPath)}.`
            : `${parsed.instanceIds.length} instance ids in ${resolve(tasksetPath)}; dataset loading is required to expand them.`,
      })
    } catch (error) {
      checks.push({
        name: "swebench-taskset",
        status: "fail",
        detail: stringifyError(error),
      })
    }
  } else if (options.offline) {
    checks.push({
      name: "swebench-taskset",
      status: "fail",
      detail: "--offline requires --taskset-file or --instances-file with safe SWE-bench instance records.",
    })
  }

  if (options.repoCacheDir) {
    const cacheDir = resolve(options.repoCacheDir)
    const cacheDirExists = await isDirectory(cacheDir)
    checks.push({
      name: "repo-cache-dir",
      status: cacheDirExists ? "pass" : "fail",
      detail: cacheDirExists ? `Repo cache directory exists: ${cacheDir}` : `Repo cache directory does not exist: ${cacheDir}`,
    })
    if (cacheDirExists && tasksetInstances.length > 0) {
      const entries: RepoCacheEntry[] = []
      for (const repo of [...new Set(tasksetInstances.map((instance) => instance.repo))]) {
        entries.push(await findRepoMirror(repo, cacheDir))
      }
      const missing = entries.filter((entry) => entry.status !== "available")
      checks.push({
        name: "repo-cache-mirrors",
        status: missing.length === 0 ? "pass" : "fail",
        detail:
          missing.length === 0
            ? `${entries.length} repo mirror(s) available for the safe taskset.`
            : `Missing repo mirror(s): ${missing.map((entry) => entry.repo).join(", ")}`,
      })
    }
  } else if (options.offline && options.runAgent) {
    checks.push({
      name: "repo-cache-dir",
      status: "fail",
      detail: "--offline --run-agent requires --repo-cache-dir with local repo mirrors.",
    })
  }

  return checks
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

async function runCommand(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const startedMs = Date.now()
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let terminateTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs && options.timeoutMs > 0) {
    terminateTimer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000)
    }, options.timeoutMs)
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (terminateTimer) clearTimeout(terminateTimer)
  if (killTimer) clearTimeout(killTimer)
  const timeoutMessage = options.timeoutMs ? `Timed out after ${options.timeoutMs}ms` : "Timed out"
  const finalStderr = timedOut ? [stderr.trimEnd(), timeoutMessage].filter(Boolean).join("\n") : stderr
  return {
    args,
    cwd,
    exitCode: timedOut && exitCode === 0 ? 124 : exitCode,
    stdout,
    stderr: finalStderr,
    durationMs: Date.now() - startedMs,
    timedOut,
  }
}

function normalizeOptions(options: SweBenchOptions): SweBenchOptions {
  if (options.instancesFile && options.tasksetFile) {
    throw new Error("Use only one of --instances-file or --taskset-file")
  }
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
    profile: SWE_BENCH_DEFAULT_PROFILE,
    instances: [],
    datasetName: SWE_BENCH_PROFILES[SWE_BENCH_DEFAULT_PROFILE].datasetName,
    split: SWE_BENCH_PROFILES[SWE_BENCH_DEFAULT_PROFILE].split,
    datasetRevision: SWE_BENCH_PROFILES[SWE_BENCH_DEFAULT_PROFILE].datasetRevision,
    keepWorkspaces: false,
    preflight: false,
    runAgent: false,
    evaluate: false,
    dryRunExplicit: false,
    gold: false,
    allowLargeRun: false,
    python: "python3",
    maxWorkers: 1,
    model: DEFAULT_EVAL_MODEL,
    apiKeyEnv: process.env.LIGHT_CC_API_KEY_ENV ?? "OPENAI_API_KEY",
    coder: "lightcc",
    maxSteps: 80,
    permissionMode: "danger-full-access",
    agentProfile: false,
    offline: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--profile") applyProfile(options, parseProfile(requireValue(argv, ++index, arg)))
    else if (arg === "--instances-file") options.instancesFile = requireValue(argv, ++index, arg)
    else if (arg === "--taskset-file") options.tasksetFile = requireValue(argv, ++index, arg)
    else if (arg === "--write-taskset-file") options.writeTasksetFile = requireValue(argv, ++index, arg)
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
    else if (arg === "--coder") options.coder = requireValue(argv, ++index, arg)
    else if (arg === "--max-steps") options.maxSteps = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--agent-timeout-ms") options.agentTimeoutMs = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--permission-mode") options.permissionMode = parsePermissionMode(requireValue(argv, ++index, arg))
    else if (arg === "--agent-profile") options.agentProfile = true
    else if (arg === "--repo-cache-dir") options.repoCacheDir = requireValue(argv, ++index, arg)
    else if (arg === "--offline") options.offline = true
    else if (arg === "--namespace") options.evaluatorNamespace = requireValueAllowEmpty(argv, ++index, arg)
    else if (arg === "--evaluator-cache-level") options.evaluatorCacheLevel = parseEvaluatorCacheLevel(requireValue(argv, ++index, arg))
    else if (arg === "--evaluator-clean") options.evaluatorClean = parseBooleanFlagValue(requireValue(argv, ++index, arg), arg)
    else if (arg === "--evaluator-timeout") options.evaluatorTimeout = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--evaluator-instance-image-tag") options.evaluatorInstanceImageTag = requireValue(argv, ++index, arg)
    else if (arg === "--evaluator-env-image-tag") options.evaluatorEnvImageTag = requireValue(argv, ++index, arg)
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
    modelNameOrPath: options.modelNameOrPath ?? "lightcc",
  }
}

function parseProfile(value: string): SweBenchProfile {
  if (value === "lite" || value === "verified") return value
  throw new Error(`Invalid --profile: ${value}`)
}

function applyProfile(options: SweBenchOptions, profile: SweBenchProfile): void {
  const defaults = SWE_BENCH_PROFILES[profile]
  options.profile = profile
  options.datasetName = defaults.datasetName
  options.split = defaults.split
  options.datasetRevision = defaults.datasetRevision
}

function defaultModelNameOrPath(options: SweBenchOptions, adapter: CoderAdapter): string {
  if (options.modelNameOrPath) return options.modelNameOrPath
  const model = options.model ?? process.env.OPENAI_MODEL ?? process.env.LIGHT_CC_MODEL
  return model ? `${adapter.id}/${model}` : adapter.id
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

function patchCollectionWarnings(collection: GitPatchCollection | undefined): string[] {
  if (!collection) return []
  const warnings: string[] = []
  if (collection.committedChangesCollected) warnings.push("committed_changes_collected_from_base_head")
  if (collection.headDiffMissedChanges) warnings.push("head_diff_empty_but_base_diff_nonempty")
  if (collection.headDiff.exitCode !== 0) {
    warnings.push(`head_diff_diagnostic_failed=${firstLine(collection.headDiff.stderr) || `exit ${collection.headDiff.exitCode}`}`)
  }
  if (collection.committedDiff.exitCode !== 0) {
    warnings.push(
      `committed_diff_diagnostic_failed=${firstLine(collection.committedDiff.stderr) || `exit ${collection.committedDiff.exitCode}`}`,
    )
  }
  return warnings
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

function parseEvaluatorCacheLevel(value: string): string {
  if (value === "none" || value === "base" || value === "env" || value === "instance") return value
  throw new Error(`Invalid --evaluator-cache-level: ${value}`)
}

function parseBooleanFlagValue(value: string, flag: string): boolean {
  if (value === "true" || value === "1" || value === "yes") return true
  if (value === "false" || value === "0" || value === "no") return false
  throw new Error(`${flag} must be true or false`)
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
    "Usage: bun run eval:swebench -- --profile verified --instance <id> [--dry-run|--run-agent|--evaluate]",
    "       bun run eval:swebench -- --instances-file evals/swebench/fixtures/sample-instance.json --dry-run",
    "       bun run eval:swebench -- --taskset-file safe-taskset.jsonl --repo-cache-dir .cache/swebench/repos --offline --run-agent",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
