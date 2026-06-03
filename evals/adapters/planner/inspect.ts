import { writeFile } from "node:fs/promises"
import { DEFAULT_EVAL_MODEL } from "../defaults"
import { createEvalMatrixPlan, type EvalMatrixRequest } from "./plan"

async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    const plan = await createEvalMatrixPlan(options.request)
    const json = `${JSON.stringify(plan, null, 2)}\n`
    if (options.output) await writeFile(options.output, json, "utf8")
    else process.stdout.write(json)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

type Options = {
  request: EvalMatrixRequest
  output?: string
}

function parseArgs(argv: string[]): Options {
  const request: EvalMatrixRequest = {
    runId: "adapter-matrix-dry-run",
    benchmark: "terminal-bench",
    coders: [],
    tasks: [],
    models: [DEFAULT_EVAL_MODEL],
    attempts: 1,
  }
  let output: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--run-id") request.runId = requireValue(argv, ++index, arg)
    else if (arg === "--benchmark") request.benchmark = parseBenchmark(requireValue(argv, ++index, arg))
    else if (arg === "--coder") request.coders.push(requireValue(argv, ++index, arg))
    else if (arg === "--task") request.tasks.push(requireValue(argv, ++index, arg))
    else if (arg === "--model") request.models.push(requireValue(argv, ++index, arg))
    else if (arg === "--attempts") request.attempts = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--artifact-root") request.artifactRoot = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") request.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--allow-draft") request.allowDraft = true
    else if (arg === "--max-entries") request.maxEntries = parsePositiveInteger(requireValue(argv, ++index, arg), arg)
    else if (arg === "--output") output = requireValue(argv, ++index, arg)
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return { request, output }
}

function parseBenchmark(value: string): EvalMatrixRequest["benchmark"] {
  if (value === "swebench" || value === "terminal-bench") return value
  throw new Error(`Invalid benchmark: ${value}`)
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

function usage(): string {
  return [
    "Usage: bun evals/adapters/planner/inspect.ts --coder lightcc --benchmark terminal-bench --task <id>",
    "       bun evals/adapters/planner/inspect.ts --allow-draft --coder openhands --task <id> --model <model>",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
