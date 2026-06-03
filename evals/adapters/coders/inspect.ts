import { loadCoderAdapter, buildCoderCommand } from "./loader"
import { DEFAULT_EVAL_MODEL } from "../defaults"
import { listBuiltInCoderAdapters } from "./registry"
import type { CoderAdapterVariables } from "./types"

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    if (options.list) {
      console.log(JSON.stringify(listBuiltInCoderAdapters().map(summaryOf), null, 2))
      return 0
    }

    if (!options.adapter) throw new Error(usage())
    const adapter = await loadCoderAdapter(options.adapter)
    const rendered = buildCoderCommand(adapter, options.variables)
    console.log(JSON.stringify({ adapter: summaryOf(adapter), command: rendered }, null, 2))
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

type Options = {
  list: boolean
  adapter?: string
  variables: CoderAdapterVariables
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    list: false,
    variables: defaultVariables(),
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--list") options.list = true
    else if (arg === "--adapter") options.adapter = requireValue(argv, ++index, arg)
    else if (arg === "--instruction") options.variables.instruction = requireValue(argv, ++index, arg)
    else if (arg === "--prompt-file") options.variables.promptFile = requireValue(argv, ++index, arg)
    else if (arg === "--workspace") options.variables.workspace = requireValue(argv, ++index, arg)
    else if (arg === "--artifact-dir") options.variables.artifactDir = requireValue(argv, ++index, arg)
    else if (arg === "--transcript") options.variables.transcriptPath = requireValue(argv, ++index, arg)
    else if (arg === "--patch") options.variables.patchPath = requireValue(argv, ++index, arg)
    else if (arg === "--model") options.variables.model = requireValue(argv, ++index, arg)
    else if (arg === "--base-url") options.variables.baseUrl = requireValue(argv, ++index, arg)
    else if (arg === "--api-key-env") options.variables.apiKeyEnv = requireValue(argv, ++index, arg)
    else if (arg === "--max-steps") options.variables.maxSteps = requireValue(argv, ++index, arg)
    else if (arg === "--permission-mode") options.variables.permissionMode = requireValue(argv, ++index, arg)
    else if (arg === "--os-sandbox") options.variables.osSandbox = requireValue(argv, ++index, arg)
    else if (arg === "--sandbox-settings") options.variables.sandboxSettings = requireValue(argv, ++index, arg)
    else if (arg === "--executable") options.variables.executable = requireValue(argv, ++index, arg)
    else if (arg === "--var") {
      const [key, ...parts] = requireValue(argv, ++index, arg).split("=")
      if (!key || parts.length === 0) throw new Error("--var requires key=value")
      options.variables[key] = parts.join("=")
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage())
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function defaultVariables(): CoderAdapterVariables {
  return {
    instruction: "Fix the task according to the benchmark instructions.",
    promptFile: "/logs/agent/prompt.txt",
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
  }
}

function summaryOf(adapter: { id: string; displayName: string; status: string; targets: readonly string[] }) {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    status: adapter.status,
    targets: adapter.targets,
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function usage(): string {
  return [
    "Usage: bun evals/adapters/coders/inspect.ts --list",
    "       bun evals/adapters/coders/inspect.ts --adapter lightcc --instruction <text>",
    "       bun evals/adapters/coders/inspect.ts --adapter openhands --prompt-file /logs/agent/prompt.txt",
    "       bun evals/adapters/coders/inspect.ts --adapter ./adapter.json --var custom=value",
  ].join("\n")
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
