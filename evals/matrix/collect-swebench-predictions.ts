#!/usr/bin/env bun
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { mkdir } from "node:fs/promises"

type Options = {
  matrixDir: string
  coder: string
  output: string
}

type Summary = {
  coder?: { id?: string }
  selectedInstances?: string[]
  predictionsPath?: string
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    const count = await collectPredictions(options)
    console.log(`Collected ${count} predictions for ${options.coder}: ${resolve(options.output)}`)
    return count > 0 ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export async function collectPredictions(options: Options): Promise<number> {
  const matrixDir = resolve(options.matrixDir)
  const jobsDir = join(matrixDir, "jobs")
  const entries = await readdir(jobsDir, { withFileTypes: true })
  const predictions = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const reportDir = join(jobsDir, entry.name, "report")
    const summary = await readSummary(join(reportDir, "summary.json"))
    if (summary?.coder?.id !== options.coder) continue
    const predictionPath = summary.predictionsPath ?? join(reportDir, "predictions.jsonl")
    const text = await readFile(predictionPath, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = JSON.parse(trimmed) as { instance_id?: string }
      if (!parsed.instance_id) throw new Error(`Prediction missing instance_id in ${predictionPath}`)
      predictions.set(parsed.instance_id, trimmed)
    }
  }

  await mkdir(dirname(resolve(options.output)), { recursive: true })
  await writeFile(resolve(options.output), `${[...predictions.values()].join("\n")}\n`, "utf8")
  return predictions.size
}

async function readSummary(path: string): Promise<Summary | undefined> {
  const text = await readFile(path, "utf8").catch(() => "")
  if (!text) return undefined
  return JSON.parse(text) as Summary
}

function parseArgs(argv: string[]): Options {
  let matrixDir = ""
  let coder = ""
  let output = ""
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--matrix-dir") matrixDir = requireValue(argv, ++index, arg)
    else if (arg === "--coder") coder = requireValue(argv, ++index, arg)
    else if (arg === "--output") output = requireValue(argv, ++index, arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!matrixDir) throw new Error("--matrix-dir is required")
  if (!coder) throw new Error("--coder is required")
  if (!output) throw new Error("--output is required")
  return { matrixDir, coder, output }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function usage(): string {
  return "Usage: bun evals/matrix/collect-swebench-predictions.ts --matrix-dir <dir> --coder <id> --output <predictions.jsonl>"
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
