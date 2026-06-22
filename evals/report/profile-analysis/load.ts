import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { ArtifactPathSummary, BenchmarkName, OfficialOutcome, OutcomeSummary } from "./types"
import {
  arrayRecords,
  arrayStrings,
  asRecord,
  booleanValue,
  firstString,
  normalizePathKey,
  numberValue,
  readJsonFile,
  readJsonlFile,
  recordValue,
  stringValue,
  uniqueSorted,
  type JsonRecord,
} from "./utils"

export type ProfileAnalysisLoadOptions = {
  runRoot?: string
  summaryPath?: string
  profilePaths?: string[]
}

export type LoadedOutcomeSource = Partial<OutcomeSummary> & {
  costUsd?: number | null
  costSource?: string | null
}

export type LoadedRowSource = {
  benchmark: BenchmarkName
  runId: string
  itemId: string
  coderId: string
  coderDisplayName: string | null
  outcome: LoadedOutcomeSource
  paths: ArtifactPathSummary
  warnings: string[]
}

export type LoadedProfileAnalysis = {
  rootPaths: string[]
  rowSources: LoadedRowSource[]
  warnings: string[]
}

type DiscoveredFiles = {
  summaries: string[]
  metrics: string[]
  providerProfiles: string[]
  wrapperProfiles: string[]
  internalProfiles: string[]
  sweAnalysisRows: string[]
}

export async function loadEvalArtifacts(options: ProfileAnalysisLoadOptions): Promise<LoadedProfileAnalysis> {
  const rootPaths = uniqueSorted([
    options.runRoot ? resolve(options.runRoot) : null,
    options.summaryPath ? resolve(dirname(options.summaryPath)) : null,
    ...(options.profilePaths ?? []).map((path) => resolve(dirname(path))),
  ])
  const warnings: string[] = []
  const files = emptyDiscoveredFiles()

  if (options.runRoot) mergeDiscoveredFiles(files, await discoverFiles(resolve(options.runRoot)))
  if (options.summaryPath) files.summaries.push(resolve(options.summaryPath))
  for (const profilePath of options.profilePaths ?? []) files.internalProfiles.push(resolve(profilePath))

  const rowSources: LoadedRowSource[] = []
  const known = new Map<string, LoadedRowSource>()

  for (const path of uniqueSorted(files.sweAnalysisRows)) {
    for (const source of await loadSweAnalysisRows(path)) mergeRowSource(known, source)
  }

  const hasSweAnalysisRows = [...known.values()].some((source) => source.benchmark === "swebench")
  if (!hasSweAnalysisRows) {
    for (const path of uniqueSorted(files.summaries)) {
      for (const source of await loadSweSummaryRows(path)) mergeRowSource(known, source)
    }
  }

  for (const path of uniqueSorted(files.summaries)) {
    for (const source of await loadTerminalSummaryRows(path, files)) mergeRowSource(known, source)
  }

  for (const path of uniqueSorted([...files.internalProfiles, ...files.wrapperProfiles])) {
    if (profileAlreadyReferenced(known, path)) continue
    const source = inferSourceFromProfilePath(path, options.runRoot ? resolve(options.runRoot) : null)
    if (source) mergeRowSource(known, source)
    else warnings.push(`unable to associate profile path: ${path}`)
  }

  for (const providerPath of uniqueSorted(files.providerProfiles)) {
    if (!providerPathCanBeAssociated(providerPath)) warnings.push(`provider profile is run-level or unassociated: ${providerPath}`)
  }

  rowSources.push(...[...known.values()].sort(compareRowSources))
  return { rootPaths, rowSources, warnings }
}

async function discoverFiles(root: string): Promise<DiscoveredFiles> {
  const files = emptyDiscoveredFiles()
  if (!existsSync(root)) return files
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name === "summary.json") files.summaries.push(path)
      else if (entry.name === "metrics.json") files.metrics.push(path)
      else if (entry.name === "provider.profile.json") files.providerProfiles.push(path)
      else if (entry.name === "wrapper.profile.json") files.wrapperProfiles.push(path)
      else if (entry.name === "profile.report.json") files.internalProfiles.push(path)
      else if (entry.name === "swebench-analysis.rows.jsonl") files.sweAnalysisRows.push(path)
    }
  }
  await walk(root)
  return files
}

async function loadSweAnalysisRows(path: string): Promise<LoadedRowSource[]> {
  const rows = await readJsonlFile(path)
  const sources: LoadedRowSource[] = []
  for (const row of rows) {
    const itemId = stringValue(row, "instanceId") ?? stringValue(row, "itemId")
    const coderId = stringValue(row, "coderId")
    if (!itemId || !coderId) continue
    const artifactPaths = recordValue(row, "artifactPaths") ?? recordValue(row, "paths")
    const provider = recordValue(row, "provider")
    sources.push({
      benchmark: "swebench",
      runId: stringValue(row, "runId") ?? inferRunIdFromPath(path),
      itemId,
      coderId,
      coderDisplayName: stringValue(row, "coderDisplayName") ?? null,
      outcome: {
        officialOutcome: officialOutcomeValue(row, "officialOutcome"),
        completed: booleanValue(row, "completed") ?? null,
        submitted: booleanValue(row, "submitted") ?? null,
        status: stringValue(row, "status") ?? null,
        patchBytes: numberValue(row, "patchBytes") ?? null,
        patchLines: numberValue(row, "patchLines") ?? null,
        patchSha256: stringValue(row, "patchSha256") ?? null,
        changedFiles: arrayStrings(row.changedFiles),
        emptyPatch: booleanValue(row, "emptyPatch") ?? null,
        costUsd: numberValue(provider, "estimatedUsd") ?? null,
        costSource: stringValue(provider, "costSource") ?? null,
      },
      paths: {
        summaryJson: stringValue(artifactPaths, "summaryJson") ?? null,
        metricsJson: stringValue(artifactPaths, "metricsJson") ?? null,
        providerProfile: stringValue(artifactPaths, "providerProfile") ?? null,
        wrapperProfile: stringValue(artifactPaths, "wrapperProfile") ?? null,
        internalProfile: stringValue(artifactPaths, "internalProfile") ?? null,
        patch: stringValue(artifactPaths, "patch") ?? null,
        transcript: stringValue(artifactPaths, "transcript") ?? null,
      },
      warnings: [],
    })
  }
  return sources
}

async function loadSweSummaryRows(path: string): Promise<LoadedRowSource[]> {
  const read = await readJsonFile(path)
  if (!read.ok) return []
  const summary = asRecord(read.value)
  if (!summary) return []
  const results = arrayRecords(summary.results)
  if (results.length === 0) return []
  if (!looksLikeSweSummary(path, summary, results)) return []

  const coder = recordValue(summary, "coder")
  const coderId = stringValue(coder, "id") ?? inferCoderIdFromPath(path)
  if (!coderId) return []
  const reportDir = stringValue(summary, "reportDir") ?? dirname(path)
  const providerProfilePath = existsSync(join(reportDir, "provider.profile.json")) ? join(reportDir, "provider.profile.json") : null
  const sources: LoadedRowSource[] = []
  for (const result of results) {
    const itemId = stringValue(result, "instanceId")
    if (!itemId) continue
    const artifactDir = stringValue(result, "artifactDir")
    const cost = recordValue(result, "cost") ?? recordValue(summary, "cost")
    const pricing = recordValue(cost, "pricing")
    sources.push({
      benchmark: "swebench",
      runId: stringValue(summary, "runId") ?? inferRunIdFromPath(path),
      itemId,
      coderId,
      coderDisplayName: stringValue(coder, "displayName") ?? coderId,
      outcome: {
        officialOutcome: null,
        completed: stringValue(result, "status") === "completed" ? true : null,
        submitted: null,
        status: stringValue(result, "status") ?? stringValue(summary, "status") ?? null,
        patchBytes: numberValue(result, "patchBytes") ?? null,
        patchLines: numberValue(result, "patchLines") ?? null,
        patchSha256: stringValue(result, "patchSha256") ?? null,
        changedFiles: arrayStrings(result.changedFiles),
        emptyPatch: booleanValue(result, "emptyPatch") ?? null,
        costUsd: numberValue(cost, "totalUsd") ?? null,
        costSource: stringValue(pricing, "source") ?? null,
      },
      paths: {
        summaryJson: path,
        metricsJson: artifactDir ? join(artifactDir, "metrics.json") : null,
        providerProfile: providerProfilePath,
        wrapperProfile: stringValue(result, "wrapperProfilePath") ?? null,
        internalProfile: stringValue(result, "profileReportPath") ?? null,
        patch: stringValue(result, "patchPath") ?? null,
        transcript: stringValue(result, "transcriptPath") ?? null,
      },
      warnings: [],
    })
  }
  return sources
}

async function loadTerminalSummaryRows(path: string, files: DiscoveredFiles): Promise<LoadedRowSource[]> {
  const read = await readJsonFile(path)
  if (!read.ok) return []
  const summary = asRecord(read.value)
  if (!summary) return []
  const tasks = arrayRecords(summary.tasks)
  if (tasks.length === 0) return []

  const coder = recordValue(summary, "coder")
  const coderId = stringValue(coder, "id") ?? inferCoderIdFromPath(path) ?? "lightcc"
  const runId = stringValue(summary, "runId") ?? inferRunIdFromPath(path)
  const internalByItem = indexProfilesByTerminalItem([
    ...arrayRecords(summary.profileReports).map((profile) => stringValue(profile, "reportPath")).filter((item): item is string => Boolean(item)),
    ...files.internalProfiles,
  ])
  const wrapperByItem = indexProfilesByTerminalItem([...arrayStrings(summary.wrapperProfilePaths), ...files.wrapperProfiles])
  const metricsByItem = indexMetricsByTerminalItem(files.metrics)
  const providerPaths = arrayStrings(summary.providerProfilePaths)
  const rowProviderByItem = providerPaths.length === tasks.length ? indexProfilesByTerminalItem(providerPaths) : new Map<string, string>()
  const warnings = providerPaths.length > 0 && rowProviderByItem.size === 0 ? [`provider profile is not row-associated: ${providerPaths.join(", ")}`] : []

  return tasks.flatMap((task): LoadedRowSource[] => {
    const rawTaskId = stringValue(task, "taskId")
    const itemId = normalizeTerminalItemId(rawTaskId ?? stringValue(task, "id") ?? "")
    if (!itemId) return []
    const artifactDir = stringValue(task, "artifactDir")
    return [
      {
        benchmark: "terminal-bench",
        runId,
        itemId,
        coderId,
        coderDisplayName: stringValue(coder, "displayName") ?? coderId,
        outcome: {
          officialOutcome: null,
          tbenchReward: numberValue(task, "reward") ?? null,
          completed: null,
          submitted: null,
          status: stringValue(task, "status") ?? null,
          patchBytes: null,
          patchLines: null,
          patchSha256: null,
          changedFiles: [],
          emptyPatch: null,
        },
        paths: {
          summaryJson: path,
          metricsJson: metricsByItem.get(itemId) ?? (artifactDir ? join(artifactDir, "metrics.json") : null),
          providerProfile: rowProviderByItem.get(itemId) ?? null,
          wrapperProfile: wrapperByItem.get(itemId) ?? null,
          internalProfile: internalByItem.get(itemId) ?? null,
          patch: null,
          transcript: null,
        },
        warnings,
      },
    ]
  })
}

function inferSourceFromProfilePath(path: string, runRoot: string | null): LoadedRowSource | null {
  const normalized = normalizePathKey(path)
  const benchmark = normalized.includes("terminal-bench") || normalized.includes("/tbench") ? "terminal-bench" : "swebench"
  const itemId = benchmark === "terminal-bench" ? extractTerminalItemIdFromPath(path) : extractSweItemIdFromPath(path)
  if (!itemId) return null
  const coderId = inferCoderIdFromPath(path) ?? (benchmark === "terminal-bench" ? "lightcc" : null)
  if (!coderId) return null
  const isWrapper = basename(path) === "wrapper.profile.json"
  const isInternal = basename(path) === "profile.report.json"
  const providerProfile = providerPathForProfile(path)
  return {
    benchmark,
    runId: runRoot ? basename(runRoot) : inferRunIdFromPath(path),
    itemId,
    coderId,
    coderDisplayName: coderId,
    outcome: {
      officialOutcome: null,
      tbenchReward: null,
      completed: null,
      submitted: null,
      status: null,
      patchBytes: null,
      patchLines: null,
      patchSha256: null,
      changedFiles: [],
      emptyPatch: null,
    },
    paths: {
      summaryJson: null,
      metricsJson: metricsPathForProfile(path, benchmark, itemId),
      providerProfile: providerProfile && providerPathCanBeAssociated(providerProfile) ? providerProfile : null,
      wrapperProfile: isWrapper ? path : siblingProfile(path, "wrapper.profile.json"),
      internalProfile: isInternal ? path : siblingProfile(path, "profile.report.json"),
      patch: null,
      transcript: null,
    },
    warnings: [],
  }
}

function mergeRowSource(targets: Map<string, LoadedRowSource>, source: LoadedRowSource): void {
  const key = rowKey(source)
  const existing = targets.get(key)
  if (!existing) {
    targets.set(key, source)
    return
  }
  existing.coderDisplayName = firstString(existing.coderDisplayName, source.coderDisplayName)
  existing.outcome = {
    ...source.outcome,
    ...Object.fromEntries(Object.entries(existing.outcome).filter(([, value]) => value !== null && value !== undefined)),
    changedFiles: existing.outcome.changedFiles?.length ? existing.outcome.changedFiles : source.outcome.changedFiles ?? [],
  }
  existing.paths = {
    summaryJson: firstString(existing.paths.summaryJson, source.paths.summaryJson),
    metricsJson: firstString(existing.paths.metricsJson, source.paths.metricsJson),
    providerProfile: firstString(existing.paths.providerProfile, source.paths.providerProfile),
    wrapperProfile: firstString(existing.paths.wrapperProfile, source.paths.wrapperProfile),
    internalProfile: firstString(existing.paths.internalProfile, source.paths.internalProfile),
    patch: firstString(existing.paths.patch, source.paths.patch),
    transcript: firstString(existing.paths.transcript, source.paths.transcript),
  }
  existing.warnings = uniqueSorted([...existing.warnings, ...source.warnings])
}

function profileAlreadyReferenced(targets: Map<string, LoadedRowSource>, path: string): boolean {
  for (const source of targets.values()) {
    if (source.paths.wrapperProfile === path || source.paths.internalProfile === path) return true
  }
  return false
}

function rowKey(source: LoadedRowSource): string {
  return [source.benchmark, source.runId, source.coderId, source.itemId].join("\0")
}

function compareRowSources(left: LoadedRowSource, right: LoadedRowSource): number {
  return (
    left.benchmark.localeCompare(right.benchmark) ||
    left.itemId.localeCompare(right.itemId) ||
    left.coderId.localeCompare(right.coderId) ||
    left.runId.localeCompare(right.runId)
  )
}

function emptyDiscoveredFiles(): DiscoveredFiles {
  return {
    summaries: [],
    metrics: [],
    providerProfiles: [],
    wrapperProfiles: [],
    internalProfiles: [],
    sweAnalysisRows: [],
  }
}

function mergeDiscoveredFiles(target: DiscoveredFiles, source: DiscoveredFiles): void {
  target.summaries.push(...source.summaries)
  target.metrics.push(...source.metrics)
  target.providerProfiles.push(...source.providerProfiles)
  target.wrapperProfiles.push(...source.wrapperProfiles)
  target.internalProfiles.push(...source.internalProfiles)
  target.sweAnalysisRows.push(...source.sweAnalysisRows)
}

function looksLikeSweSummary(path: string, summary: JsonRecord, results: JsonRecord[]): boolean {
  if (normalizePathKey(path).includes("/evaluator/") && !normalizePathKey(path).includes("/matrix/jobs/")) return false
  if (recordValue(summary, "swebench")) return true
  return results.some((result) => Boolean(stringValue(result, "instanceId")))
}

function providerPathForProfile(path: string): string | null {
  let dir = dirname(path)
  for (let index = 0; index < 5; index++) {
    const candidate = join(dir, "provider.profile.json")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}

function providerPathCanBeAssociated(path: string): boolean {
  const normalized = normalizePathKey(path)
  return normalized.includes("/matrix/jobs/") || normalized.includes("/instances/") || normalized.includes("/agent/")
}

function siblingProfile(path: string, filename: string): string | null {
  const candidate = join(dirname(path), filename)
  return existsSync(candidate) ? candidate : null
}

function metricsPathForProfile(path: string, benchmark: BenchmarkName, itemId: string): string | null {
  if (benchmark === "swebench") {
    let dir = dirname(path)
    for (let index = 0; index < 4; index++) {
      const candidate = join(dir, "metrics.json")
      if (existsSync(candidate)) return candidate
      dir = dirname(dir)
    }
    return null
  }
  const runRoot = extractRunRootFromTerminalPath(path)
  if (!runRoot) return null
  const slug = itemId.replace(/^terminal-bench\//, "")
  const candidate = join(runRoot, "terminal-bench", "tasks", `terminal-bench_${slug}`, "metrics.json")
  return existsSync(candidate) ? candidate : null
}

function extractRunRootFromTerminalPath(path: string): string | null {
  const normalized = normalizePathKey(path)
  const marker = "/jobs/"
  const index = normalized.indexOf(marker)
  if (index < 0) return null
  return path.slice(0, index)
}

function indexProfilesByTerminalItem(paths: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const path of paths) {
    const itemId = extractTerminalItemIdFromPath(path)
    if (itemId && !result.has(itemId)) result.set(itemId, path)
  }
  return result
}

function indexMetricsByTerminalItem(paths: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const path of paths) {
    const parent = basename(dirname(path))
    if (!parent.startsWith("terminal-bench_")) continue
    result.set(`terminal-bench/${parent.slice("terminal-bench_".length)}`, path)
  }
  return result
}

function extractTerminalItemIdFromPath(path: string): string | null {
  const normalized = normalizePathKey(path)
  const match = /\/jobs\/[^/]+\/([^/]+?)__[A-Za-z0-9]+(?:\/|$)/.exec(normalized)
  if (match) return `terminal-bench/${match[1]}`
  const taskMatch = /\/terminal-bench\/tasks\/terminal-bench_([^/]+)(?:\/|$)/.exec(normalized)
  return taskMatch ? `terminal-bench/${taskMatch[1]}` : null
}

function normalizeTerminalItemId(value: string): string | null {
  if (!value) return null
  if (value.startsWith("terminal-bench/")) return value
  if (value.startsWith("terminal-bench_")) return `terminal-bench/${value.slice("terminal-bench_".length)}`
  return `terminal-bench/${value}`
}

function extractSweItemIdFromPath(path: string): string | null {
  const normalized = normalizePathKey(path)
  const match = /([A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+)/.exec(normalized)
  return match?.[1] ?? null
}

function inferCoderIdFromPath(path: string): string | null {
  const normalized = normalizePathKey(path)
  const matrixMatch = /\/matrix\/jobs\/\d+-(.+?)-(?:swebench|tbench)-/.exec(normalized)
  if (matrixMatch) return matrixMatch[1]
  const evaluatorMatch = /\/evaluator\/([^/]+)\//.exec(normalized)
  if (evaluatorMatch) return evaluatorMatch[1]
  if (normalized.includes("kimi-cli")) return "kimi-cli"
  if (normalized.includes("lightcc")) return "lightcc"
  if (normalized.includes("openhands")) return "openhands"
  if (normalized.includes("opencode")) return "opencode"
  if (normalized.includes("aider")) return "aider"
  return null
}

function inferRunIdFromPath(path: string): string {
  const normalized = normalizePathKey(path)
  const matrixMatch = /\/matrix\/jobs\/([^/]+)\//.exec(normalized)
  if (matrixMatch) return matrixMatch[1]
  const jobsMatch = /\/jobs\/([^/]+)\//.exec(normalized)
  if (jobsMatch) return jobsMatch[1]
  const evalsMatch = /\/\.light-cc\/evals\/([^/]+)/.exec(normalized)
  if (evalsMatch) return evalsMatch[1]
  return basename(dirname(path))
}

function officialOutcomeValue(record: JsonRecord | undefined, key: string): OfficialOutcome | null {
  const value = stringValue(record, key)
  return value === "resolved" || value === "unresolved" || value === "empty_patch" || value === "error" || value === "incomplete"
    ? value
    : null
}
