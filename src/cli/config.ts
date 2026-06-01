import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, resolve } from "node:path"
import type { PermissionMode } from "../permissions/types"
import type { ParsedCliArgs } from "./args"

export type SourceValue<T> = {
  value: T
  source: string
}

export type EffectiveConfig = {
  cwd: SourceValue<string>
  dataRoot: SourceValue<string>
  baseUrl: SourceValue<string | undefined>
  model: SourceValue<string | undefined>
  apiKeyEnv: SourceValue<string>
  apiKeyPresent: SourceValue<boolean>
  transcript: SourceValue<string | undefined>
  maxSteps: SourceValue<number>
  maxContextTokens: SourceValue<number | undefined>
  compactThreshold: SourceValue<number | undefined>
  permissionMode: SourceValue<PermissionMode>
  mcpConfig: SourceValue<string | undefined>
  skillDirs: SourceValue<string[]>
  fake: SourceValue<boolean>
  verbose: SourceValue<boolean>
  configFiles: Array<{ path: string; status: "loaded" | "missing" }>
}

type MutableConfig = {
  cwd: SourceValue<string>
  dataRoot: SourceValue<string>
  baseUrl: SourceValue<string | undefined>
  model: SourceValue<string | undefined>
  apiKeyEnv: SourceValue<string>
  transcript: SourceValue<string | undefined>
  maxSteps: SourceValue<number>
  maxContextTokens: SourceValue<number | undefined>
  compactThreshold: SourceValue<number | undefined>
  permissionMode: SourceValue<PermissionMode>
  mcpConfig: SourceValue<string | undefined>
  skillDirs: SourceValue<string[]>
  fake: SourceValue<boolean>
  verbose: SourceValue<boolean>
}

type ConfigFile = {
  baseUrl?: string
  model?: string
  apiKeyEnv?: string
  transcript?: string
  maxSteps?: number
  maxContextTokens?: number
  compactThreshold?: number
  permissionMode?: PermissionMode
  mcpConfig?: string
  skillDirs?: string[]
  skills?: string[]
  fake?: boolean
  verbose?: boolean
}

export async function resolveConfig(args: ParsedCliArgs, env: NodeJS.ProcessEnv = process.env): Promise<EffectiveConfig> {
  const dataRoot = resolve(expandHome(env.LIGHTCC_HOME ?? "~/.lightcc"))
  const cwd = resolve(args.cwd ?? process.cwd())
  const config: MutableConfig = {
    cwd: sourced(cwd, args.cwd ? "cli:--cwd" : "default:process.cwd"),
    dataRoot: sourced(dataRoot, env.LIGHTCC_HOME ? "env:LIGHTCC_HOME" : "default:~/.lightcc"),
    baseUrl: sourced(undefined, "default"),
    model: sourced(undefined, "default"),
    apiKeyEnv: sourced("OPENAI_API_KEY", "default"),
    transcript: sourced(undefined, "default"),
    maxSteps: sourced(10, "default"),
    maxContextTokens: sourced(undefined, "default"),
    compactThreshold: sourced(undefined, "default"),
    permissionMode: sourced("workspace-write", "default"),
    mcpConfig: sourced(undefined, "default"),
    skillDirs: sourced([], "default"),
    fake: sourced(false, "default"),
    verbose: sourced(false, "default"),
  }

  const configFiles: EffectiveConfig["configFiles"] = []
  await applyConfigFile(config, resolve(dataRoot, "config.json"), "global config", configFiles)
  await applyConfigFile(config, resolve(cwd, ".lightcc", "config.json"), "project config", configFiles, {
    allowApiKeyEnv: false,
  })
  applyEnvironment(config, env)
  applyCliArgs(config, args)

  return {
    ...config,
    apiKeyPresent: sourced(Boolean(env[config.apiKeyEnv.value]), `env:${config.apiKeyEnv.value}`),
    configFiles,
  }
}

export function renderConfigReport(config: EffectiveConfig): string {
  const lines = [
    line("cwd", config.cwd),
    line("dataRoot", config.dataRoot),
    line("baseUrl", config.baseUrl),
    line("model", config.model),
    line("apiKeyEnv", config.apiKeyEnv),
    `apiKeyPresent: ${config.apiKeyPresent.value ? "yes" : "no"} (${config.apiKeyPresent.source})`,
    line("permissionMode", config.permissionMode),
    line("transcript", config.transcript),
    line("maxSteps", config.maxSteps),
    line("maxContextTokens", config.maxContextTokens),
    line("compactThreshold", config.compactThreshold),
    line("mcpConfig", config.mcpConfig),
    `skillDirs: ${config.skillDirs.value.length > 0 ? config.skillDirs.value.join(", ") : "none"} (${config.skillDirs.source})`,
    line("fake", config.fake),
    line("verbose", config.verbose),
    "Config files:",
  ]
  for (const file of config.configFiles) {
    lines.push(`- ${file.path}: ${file.status}`)
  }
  return lines.join("\n")
}

function applyEnvironment(config: MutableConfig, env: NodeJS.ProcessEnv): void {
  if (env.LIGHT_CC_BASE_URL) config.baseUrl = sourced(env.LIGHT_CC_BASE_URL, "env:LIGHT_CC_BASE_URL")
  else if (env.OPENAI_BASE_URL) config.baseUrl = sourced(env.OPENAI_BASE_URL, "env:OPENAI_BASE_URL")

  if (env.LIGHT_CC_MODEL) config.model = sourced(env.LIGHT_CC_MODEL, "env:LIGHT_CC_MODEL")
  else if (env.OPENAI_MODEL) config.model = sourced(env.OPENAI_MODEL, "env:OPENAI_MODEL")

  if (env.LIGHT_CC_API_KEY_ENV) config.apiKeyEnv = sourced(env.LIGHT_CC_API_KEY_ENV, "env:LIGHT_CC_API_KEY_ENV")
  if (env.LIGHT_CC_PERMISSION_MODE) {
    config.permissionMode = sourced(parsePermissionMode(env.LIGHT_CC_PERMISSION_MODE), "env:LIGHT_CC_PERMISSION_MODE")
  }
  if (env.LIGHT_CC_TRANSCRIPT) config.transcript = sourced(resolve(env.LIGHT_CC_TRANSCRIPT), "env:LIGHT_CC_TRANSCRIPT")
  if (env.LIGHT_CC_MAX_STEPS) config.maxSteps = sourced(parseInteger(env.LIGHT_CC_MAX_STEPS), "env:LIGHT_CC_MAX_STEPS")
  if (env.LIGHT_CC_MAX_CONTEXT_TOKENS) {
    config.maxContextTokens = sourced(parseInteger(env.LIGHT_CC_MAX_CONTEXT_TOKENS), "env:LIGHT_CC_MAX_CONTEXT_TOKENS")
  }
  if (env.LIGHT_CC_COMPACT_THRESHOLD) {
    config.compactThreshold = sourced(parseInteger(env.LIGHT_CC_COMPACT_THRESHOLD), "env:LIGHT_CC_COMPACT_THRESHOLD")
  }
  if (env.LIGHT_CC_MCP_CONFIG) config.mcpConfig = sourced(resolve(env.LIGHT_CC_MCP_CONFIG), "env:LIGHT_CC_MCP_CONFIG")
  if (env.LIGHT_CC_SKILLS) {
    config.skillDirs = sourced(
      env.LIGHT_CC_SKILLS.split(delimiter)
        .filter(Boolean)
        .map((path) => resolve(path)),
      "env:LIGHT_CC_SKILLS",
    )
  }
}

function applyCliArgs(config: MutableConfig, args: ParsedCliArgs): void {
  if (args.baseUrl) config.baseUrl = sourced(args.baseUrl, "cli:--base-url")
  if (args.model) config.model = sourced(args.model, "cli:--model")
  if (args.apiKeyEnv) config.apiKeyEnv = sourced(args.apiKeyEnv, "cli:--api-key-env")
  if (args.transcript) config.transcript = sourced(resolve(args.transcript), "cli:--transcript")
  if (args.maxSteps !== undefined) config.maxSteps = sourced(args.maxSteps, "cli:--max-steps")
  if (args.maxContextTokens !== undefined) config.maxContextTokens = sourced(args.maxContextTokens, "cli:--max-context-tokens")
  if (args.compactThreshold !== undefined) config.compactThreshold = sourced(args.compactThreshold, "cli:--compact-threshold")
  if (args.permissionMode) config.permissionMode = sourced(args.permissionMode, "cli:--permission-mode")
  if (args.mcpConfig) config.mcpConfig = sourced(resolve(args.mcpConfig), "cli:--mcp-config")
  if (args.skillDirs.length > 0) config.skillDirs = sourced(args.skillDirs.map((path) => resolve(path)), "cli:--skill")
  if (args.fake) config.fake = sourced(true, "cli:--fake")
  if (args.verbose) config.verbose = sourced(true, "cli:--verbose")
}

async function applyConfigFile(
  config: MutableConfig,
  path: string,
  source: string,
  configFiles: EffectiveConfig["configFiles"],
  options: { allowApiKeyEnv?: boolean } = {},
): Promise<void> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      configFiles.push({ path, status: "missing" })
      return
    }
    throw new Error(`Failed to read ${source} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  configFiles.push({ path, status: "loaded" })
  let parsed: ConfigFile
  try {
    parsed = JSON.parse(content) as ConfigFile
  } catch (error) {
    throw new Error(`Malformed ${source} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${source} ${path} must contain an object`)
  applyConfigObject(config, parsed, source, options.allowApiKeyEnv ?? true)
}

function applyConfigObject(config: MutableConfig, parsed: ConfigFile, source: string, allowApiKeyEnv: boolean): void {
  if (typeof parsed.baseUrl === "string") config.baseUrl = sourced(parsed.baseUrl, source)
  if (typeof parsed.model === "string") config.model = sourced(parsed.model, source)
  if (allowApiKeyEnv && typeof parsed.apiKeyEnv === "string") config.apiKeyEnv = sourced(parsed.apiKeyEnv, source)
  if (!allowApiKeyEnv && typeof parsed.apiKeyEnv === "string") {
    throw new Error("Project config must not set apiKeyEnv; keep provider secrets in environment or global config")
  }
  if (typeof parsed.transcript === "string") config.transcript = sourced(resolve(parsed.transcript), source)
  if (typeof parsed.maxSteps === "number") config.maxSteps = sourced(parsed.maxSteps, source)
  if (typeof parsed.maxContextTokens === "number") config.maxContextTokens = sourced(parsed.maxContextTokens, source)
  if (typeof parsed.compactThreshold === "number") config.compactThreshold = sourced(parsed.compactThreshold, source)
  if (parsed.permissionMode !== undefined) config.permissionMode = sourced(parsePermissionMode(parsed.permissionMode), source)
  if (typeof parsed.mcpConfig === "string") config.mcpConfig = sourced(resolve(parsed.mcpConfig), source)
  const skills = parsed.skillDirs ?? parsed.skills
  if (Array.isArray(skills)) config.skillDirs = sourced(skills.map((path) => resolve(path)), source)
  if (typeof parsed.fake === "boolean") config.fake = sourced(parsed.fake, source)
  if (typeof parsed.verbose === "boolean") config.verbose = sourced(parsed.verbose, source)
}

function line<T>(name: string, value: SourceValue<T>): string {
  return `${name}: ${formatValue(value.value)} (${value.source})`
}

function formatValue(value: unknown): string {
  if (value === undefined) return "unset"
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none"
  return String(value)
}

function sourced<T>(value: T, source: string): SourceValue<T> {
  return { value, source }
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return path
}

function parsePermissionMode(value: string): PermissionMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value
  throw new Error(`Invalid permission mode: ${value}`)
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) throw new Error(`Expected integer, got ${value}`)
  return parsed
}
