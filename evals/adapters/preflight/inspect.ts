import { runAdapterPreflight } from "./check"
import { DEFAULT_EVAL_MODEL } from "../defaults"
import type { CoderAdapterVariables, CoderEvalTarget } from "../coders/types"

async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    const checks = await runAdapterPreflight(options)
    console.log(JSON.stringify({ checks }, null, 2))
    return checks.some((check) => check.status === "fail") ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function parseArgs(argv: string[]): {
  adapter: string
  benchmark: CoderEvalTarget
  variables: CoderAdapterVariables
  checkExecutable: boolean
} {
  const options = {
    adapter: "",
    benchmark: "terminal-bench" as CoderEvalTarget,
    variables: {
      instruction: "Preflight render.",
      promptFile: "/logs/agent/prompt.md",
      workspace: "/workspace",
      artifactDir: "/logs/agent",
      transcriptPath: "/logs/agent/transcript.jsonl",
      patchPath: "/logs/agent/patch.diff",
      resultPath: "/logs/agent/result.json",
      model: DEFAULT_EVAL_MODEL,
      baseUrl: "",
      apiKeyEnv: "OPENAI_API_KEY",
      maxSteps: "120",
      permissionMode: "danger-full-access",
      osSandbox: "off",
      sandboxSettings: "",
      executable: "coder",
    } satisfies CoderAdapterVariables,
    checkExecutable: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--adapter") options.adapter = requireValue(argv, ++index, arg)
    else if (arg === "--benchmark") options.benchmark = parseBenchmark(requireValue(argv, ++index, arg))
    else if (arg === "--model") options.variables.model = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.variables.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--workspace") options.variables.workspace = requireValue(argv, ++index, arg)
    else if (arg === "--instruction") options.variables.instruction = requireValue(argv, ++index, arg)
    else if (arg === "--executable") options.variables.executable = requireValue(argv, ++index, arg)
    else if (arg === "--check-executable") options.checkExecutable = true
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!options.adapter) throw new Error(usage())
  return options
}

function parseBenchmark(value: string): CoderEvalTarget {
  if (value === "swebench" || value === "terminal-bench") return value
  throw new Error(`Invalid benchmark: ${value}`)
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function usage(): string {
  return "Usage: bun evals/adapters/preflight/inspect.ts --adapter lightcc --benchmark terminal-bench --api-key-env DEEPSEEK_API_KEY"
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
