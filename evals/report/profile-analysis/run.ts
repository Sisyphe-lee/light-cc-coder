#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { aggregateEvalProfileRows } from "./aggregate"
import { loadEvalArtifacts, type ProfileAnalysisLoadOptions } from "./load"
import { normalizeEvalProfileRows } from "./normalize"
import { renderProfileAnalysisMarkdown } from "./renderMarkdown"
import type { EvalProfileAnalysisResult } from "./types"

export type ProfileAnalysisCliOptions = ProfileAnalysisLoadOptions & {
  outDir: string
}

export async function buildProfileAnalysis(options: ProfileAnalysisLoadOptions): Promise<EvalProfileAnalysisResult> {
  const loaded = await loadEvalArtifacts(options)
  const rows = await normalizeEvalProfileRows(loaded)
  return aggregateEvalProfileRows(rows, loaded.warnings)
}

export async function writeProfileAnalysisArtifacts(result: EvalProfileAnalysisResult, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, "eval-profile.rows.jsonl"), `${result.rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
  await writeJson(join(outDir, "eval-profile.summary.json"), result.summary)
  await writeJson(join(outDir, "eval-profile.coder-summary.json"), result.coderSummary)
  await writeJson(join(outDir, "eval-profile.item-matrix.json"), result.itemMatrix)
  await writeJson(join(outDir, "eval-profile.outliers.json"), result.outliers)
  await writeJson(join(outDir, "eval-profile.outcome-splits.json"), result.outcomeSplits)
  await writeFile(join(outDir, "eval-profile-analysis.zh-CN.md"), renderProfileAnalysisMarkdown(result), "utf8")
}

export async function runProfileAnalysis(options: ProfileAnalysisCliOptions): Promise<EvalProfileAnalysisResult> {
  const result = await buildProfileAnalysis(options)
  await writeProfileAnalysisArtifacts(result, options.outDir)
  return result
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    if (!options) {
      console.log(usage())
      return 0
    }
    const result = await runProfileAnalysis(options)
    console.log(`Profile analysis rows: ${result.rows.length}`)
    console.log(`Output: ${options.outDir}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export function parseArgs(argv: string[]): ProfileAnalysisCliOptions | null {
  const options: Partial<ProfileAnalysisCliOptions> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return null
    if (arg === "--run-root") options.runRoot = resolve(requireValue(argv, ++index, arg))
    else if (arg === "--summary") options.summaryPath = resolve(requireValue(argv, ++index, arg))
    else if (arg === "--profiles") options.profilePaths = requireValue(argv, ++index, arg).split(",").map((path) => resolve(path)).filter(Boolean)
    else if (arg === "--out") options.outDir = resolve(requireValue(argv, ++index, arg))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.runRoot && !options.summaryPath && (!options.profilePaths || options.profilePaths.length === 0)) {
    throw new Error("One of --run-root, --summary, or --profiles is required")
  }
  const defaultRoot = options.runRoot ?? (options.summaryPath ? dirname(options.summaryPath) : process.cwd())
  return {
    runRoot: options.runRoot,
    summaryPath: options.summaryPath,
    profilePaths: options.profilePaths,
    outDir: options.outDir ?? join(defaultRoot, "profile-analysis"),
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function usage(): string {
  return [
    "Usage:",
    "  bun evals/report/profile-analysis/run.ts --run-root <eval-run-root> [--out <dir>]",
    "  bun evals/report/profile-analysis/run.ts --summary <summary.json> [--out <dir>]",
    "  bun evals/report/profile-analysis/run.ts --profiles <profile.report.json[,..]> [--out <dir>]",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
