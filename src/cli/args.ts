import type { PermissionMode } from "../permissions/types"
import { parseOsSandboxMode, type OsSandboxMode } from "../runtime/sandbox/config"

export type CliMode = "doctor" | "dry-run" | "help" | "one-shot" | "repl" | "resume" | "sessions"

export type ParsedCliArgs = {
  mode: CliMode
  prompt?: string
  promptFile?: string
  cwd?: string
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  transcript?: string
  artifactDir?: string
  outputJson: boolean
  quiet: boolean
  jsonEvents: boolean
  maxSteps?: number
  maxContextTokens?: number
  compactThreshold?: number
  permissionMode?: PermissionMode
  osSandbox?: OsSandboxMode
  sandboxSettings?: string
  sandboxAllowDomains: string[]
  sandboxAllowWrites: string[]
  doctorSandbox: boolean
  json: boolean
  mcpConfig?: string
  skillDirs: string[]
  fake: boolean
  verbose: boolean
  resume?: { last: boolean; id?: string }
}

export function parseCliArgs(argv: string[], input: { stdinIsTty?: boolean } = {}): ParsedCliArgs {
  const args: ParsedCliArgs = {
    mode: "one-shot",
    sandboxAllowDomains: [],
    sandboxAllowWrites: [],
    doctorSandbox: false,
    json: false,
    skillDirs: [],
    fake: false,
    verbose: false,
    outputJson: false,
    quiet: false,
    jsonEvents: false,
  }
  let explicitMode: CliMode | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (index === 0 && arg === "doctor") {
      explicitMode = "doctor"
      args.mode = "doctor"
      continue
    }
    if (index === 0 && arg === "resume") {
      explicitMode = "resume"
      args.mode = "resume"
      const next = argv[index + 1]
      if (next && !next.startsWith("-")) {
        args.resume = { last: false, id: next }
        index += 1
      } else {
        args.resume = { last: true }
      }
      continue
    }
    if (index === 0 && arg === "sessions") {
      explicitMode = "sessions"
      args.mode = "sessions"
      continue
    }

    if (arg === "-h" || arg === "--help") {
      explicitMode = "help"
      args.mode = "help"
    } else if (arg === "-p") args.prompt = requireValue(argv, ++index, "-p")
    else if (arg === "--prompt-file") args.promptFile = requireValue(argv, ++index, "--prompt-file")
    else if (arg === "--cwd") args.cwd = requireValue(argv, ++index, "--cwd")
    else if (arg === "--model") args.model = requireValue(argv, ++index, "--model")
    else if (arg === "--base-url") args.baseUrl = requireValue(argv, ++index, "--base-url")
    else if (arg === "--api-key-env") args.apiKeyEnv = requireValue(argv, ++index, "--api-key-env")
    else if (arg === "--transcript") args.transcript = requireValue(argv, ++index, "--transcript")
    else if (arg === "--artifact-dir") args.artifactDir = requireValue(argv, ++index, "--artifact-dir")
    else if (arg === "--output-json") args.outputJson = true
    else if (arg === "--quiet") args.quiet = true
    else if (arg === "--json-events") args.jsonEvents = true
    else if (arg === "--max-steps") args.maxSteps = parseInteger(requireValue(argv, ++index, "--max-steps"), "--max-steps")
    else if (arg === "--max-context-tokens")
      args.maxContextTokens = parseInteger(requireValue(argv, ++index, "--max-context-tokens"), "--max-context-tokens")
    else if (arg === "--compact-threshold")
      args.compactThreshold = parseInteger(requireValue(argv, ++index, "--compact-threshold"), "--compact-threshold")
    else if (arg === "--permission-mode") args.permissionMode = parsePermissionMode(requireValue(argv, ++index, "--permission-mode"))
    else if (arg === "--os-sandbox") args.osSandbox = parseOsSandboxMode(requireValue(argv, ++index, "--os-sandbox"))
    else if (arg === "--sandbox-settings") args.sandboxSettings = requireValue(argv, ++index, "--sandbox-settings")
    else if (arg === "--sandbox-allow-domain") args.sandboxAllowDomains.push(requireValue(argv, ++index, "--sandbox-allow-domain"))
    else if (arg === "--sandbox-allow-write") args.sandboxAllowWrites.push(requireValue(argv, ++index, "--sandbox-allow-write"))
    else if (arg === "--sandbox" && args.mode === "doctor") args.doctorSandbox = true
    else if (arg === "--json") args.json = true
    else if (arg === "--mcp-config") args.mcpConfig = requireValue(argv, ++index, "--mcp-config")
    else if (arg === "--skill") args.skillDirs.push(requireValue(argv, ++index, "--skill"))
    else if (arg === "--fake") args.fake = true
    else if (arg === "--verbose") args.verbose = true
    else if (arg === "--dry-run") {
      explicitMode = "dry-run"
      args.mode = "dry-run"
    } else if (arg === "--repl") {
      explicitMode = "repl"
      args.mode = "repl"
    } else if (arg === "--last" && args.mode === "resume") {
      args.resume = { last: true }
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (args.json && explicitMode && explicitMode !== "doctor" && !(explicitMode === undefined && args.prompt)) {
    throw new Error("--json is only supported with doctor or one-shot -p mode")
  }
  if (args.outputJson && args.json) throw new Error("Use either --output-json or --json, not both")
  if (args.outputJson && args.jsonEvents) throw new Error("Use either --output-json or --json-events, not both")
  if (args.json && args.jsonEvents) throw new Error("Use either --json or --json-events, not both")
  if (explicitMode === "doctor") return args
  if (explicitMode === "help") return args
  if (explicitMode === "sessions") return args
  if (explicitMode === "resume") {
    args.resume ??= { last: true }
    return args
  }
  if (explicitMode === "dry-run") return args
  if (explicitMode === "repl") return args
  if (args.prompt || args.promptFile) {
    args.mode = "one-shot"
    return args
  }
  if (args.json) throw new Error("--json is only supported with doctor or one-shot -p mode")
  if (input.stdinIsTty) {
    args.mode = "repl"
    return args
  }
  throw new Error(usage())
}

export function usage(): string {
  return [
    'Usage: lightcc [-p "prompt"] [options]',
    "       lightcc [options]",
    "       lightcc doctor [options]",
    "       lightcc sessions [options]",
    "       lightcc resume --last [options]",
    "       lightcc resume <session-id> [options]",
    "",
    "Options:",
    "  -p <prompt>              Run one-shot mode.",
    "  --prompt-file <path>     Read one-shot prompt from a file.",
    "  --repl                   Force line-oriented REPL mode.",
    "  --dry-run                Resolve config and session plan only.",
    "  --cwd <path>             Workspace root, defaults to current directory.",
    "  --model <name>           Provider model.",
    "  --base-url <url>         OpenAI-compatible provider base URL.",
    "  --api-key-env <name>     Environment variable containing API key.",
    "  --artifact-dir <path>    Write run.json, summary.json, transcript, stdout.log, and stderr.log.",
    "  --output-json            Print only final run summary JSON.",
    "  --quiet                  Suppress human output while still recording artifact logs.",
    "  --json-events            Print JSONL events instead of human output.",
    "  --permission-mode <mode> read-only | workspace-write | danger-full-access.",
    "  --os-sandbox <mode>      off | auto | required. Defaults to auto.",
    "  --sandbox-settings <path> Explicit sandbox settings path.",
    "  --sandbox-allow-domain <domain> Add sandbox network allowlist domain.",
    "  --sandbox-allow-write <path> Add sandbox write allowlist path.",
    "  --sandbox                With doctor, show focused OS sandbox readiness.",
    "  --json                   With doctor or one-shot -p, print machine-readable JSON lines.",
    "  --fake                   Use FakeProvider for local smoke tests.",
  ].join("\n")
}

function parsePermissionMode(value: string): PermissionMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value
  throw new Error(`Invalid --permission-mode: ${value}`)
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer`)
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}
