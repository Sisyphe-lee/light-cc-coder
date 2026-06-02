import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { BUILT_IN_CODER_ADAPTERS } from "./registry"
import {
  CODER_ADAPTER_PLACEHOLDERS,
  CODER_ADAPTER_SCHEMA_VERSION,
  type CoderAdapter,
  type CoderAdapterStatus,
  type CoderAdapterVariables,
  type CoderArtifactSpec,
  type CoderCommandSpec,
  type CoderEvalTarget,
  type CoderInstallKind,
  type CoderInstallSpec,
  type CoderUsageParser,
  type RenderedCoderCommand,
} from "./types"

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const SAFE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const TEMPLATE_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g
const SECRET_ENV_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD)/i

const TARGETS = new Set<CoderEvalTarget>(["swebench", "terminal-bench"])
const INSTALL_KINDS = new Set<CoderInstallKind>(["none", "npm", "pip", "pipx", "source", "docker", "custom"])
const USAGE_PARSERS = new Set<CoderUsageParser>(["none", "lightcc-transcript", "custom"])
const KNOWN_PLACEHOLDERS = new Set<string>(CODER_ADAPTER_PLACEHOLDERS)

export function getBuiltInCoderAdapter(id: string): CoderAdapter | undefined {
  const adapter = BUILT_IN_CODER_ADAPTERS.find((candidate) => candidate.id === id)
  return adapter ? cloneAdapter(adapter) : undefined
}

export async function loadCoderAdapter(idOrPath: string): Promise<CoderAdapter> {
  const path = resolve(idOrPath)
  if (existsSync(path)) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
    return validateCoderAdapter(parsed, path)
  }

  const builtIn = getBuiltInCoderAdapter(idOrPath)
  if (!builtIn) throw new Error(`Unknown coder adapter: ${idOrPath}`)
  return validateCoderAdapter(builtIn, idOrPath)
}

export function validateCoderAdapter(value: unknown, source = "adapter"): CoderAdapter {
  const adapter = asRecord(value, source)
  const schemaVersion = readNumber(adapter, "schemaVersion", source)
  if (schemaVersion !== CODER_ADAPTER_SCHEMA_VERSION) {
    throw new Error(`${source}.schemaVersion must be ${CODER_ADAPTER_SCHEMA_VERSION}`)
  }

  const id = readString(adapter, "id", source)
  if (!ADAPTER_ID_PATTERN.test(id)) throw new Error(`${source}.id is invalid: ${id}`)

  const displayName = readString(adapter, "displayName", source)
  const status = readEnum(adapter, "status", source, new Set<CoderAdapterStatus>(["ready", "draft"]))
  const targets = readStringArray(adapter, "targets", source).map((target) => {
    if (!TARGETS.has(target as CoderEvalTarget)) throw new Error(`${source}.targets contains invalid target: ${target}`)
    return target as CoderEvalTarget
  })
  if (targets.length === 0) throw new Error(`${source}.targets must not be empty`)

  const install = validateInstallSpec(readOptionalRecord(adapter, "install", source) ?? { kind: "none" }, `${source}.install`)
  const command = validateCommandSpec(readRecord(adapter, "command", source), `${source}.command`)
  const artifacts = validateArtifactSpec(readOptionalRecord(adapter, "artifacts", source), `${source}.artifacts`)
  const metadata = readOptionalRecord(adapter, "metadata", source)

  return {
    schemaVersion,
    id,
    displayName,
    status,
    targets,
    install,
    command,
    artifacts,
    metadata: metadata ? cloneJson(metadata) : undefined,
  }
}

export function buildCoderCommand(adapter: CoderAdapter, variables: CoderAdapterVariables): RenderedCoderCommand {
  const command = adapter.command
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(command.env ?? {})) {
    env[key] = renderTemplate(value, variables)
  }

  const requiredEnv = [...new Set((command.requiredEnv ?? []).map((name) => renderTemplate(name, variables)))]
  for (const name of requiredEnv) {
    if (!SAFE_ENV_NAME_PATTERN.test(name)) throw new Error(`Rendered required env name is invalid: ${name}`)
  }

  const artifacts: CoderArtifactSpec = {
    transcript: adapter.artifacts?.transcript ? renderTemplate(adapter.artifacts.transcript, variables) : undefined,
    patch: adapter.artifacts?.patch ? renderTemplate(adapter.artifacts.patch, variables) : undefined,
    usage: adapter.artifacts?.usage ?? "none",
  }

  return {
    adapterId: adapter.id,
    displayName: adapter.displayName,
    status: adapter.status,
    executable: renderTemplate(command.executable, variables),
    args: command.args.map((arg) => renderTemplate(arg, variables)),
    cwd: command.cwd ? renderTemplate(command.cwd, variables) : undefined,
    env,
    requiredEnv,
    artifacts,
  }
}

export function renderTemplate(template: string, variables: CoderAdapterVariables): string {
  return template.replace(TEMPLATE_PATTERN, (match, key: string) => {
    if (!KNOWN_PLACEHOLDERS.has(key) && !(key in variables)) {
      throw new Error(`Unknown template placeholder: ${match}`)
    }
    const value = variables[key]
    if (value === undefined) throw new Error(`Missing template variable: ${key}`)
    return value
  })
}

function validateInstallSpec(raw: Record<string, unknown>, source: string): CoderInstallSpec {
  const kind = readEnum(raw, "kind", source, INSTALL_KINDS)
  return {
    kind,
    package: readOptionalString(raw, "package", source),
    commands: readOptionalStringArray(raw, "commands", source),
    notes: readOptionalStringArray(raw, "notes", source),
  }
}

function validateCommandSpec(raw: Record<string, unknown>, source: string): CoderCommandSpec {
  const executable = readString(raw, "executable", source)
  const args = readStringArray(raw, "args", source)
  const cwd = readOptionalString(raw, "cwd", source)
  const env = readOptionalStringMap(raw, "env", source)
  const requiredEnv = readOptionalStringArray(raw, "requiredEnv", source)

  for (const key of Object.keys(env ?? {})) {
    if (!SAFE_ENV_NAME_PATTERN.test(key)) throw new Error(`${source}.env contains invalid env name: ${key}`)
  }
  rejectInlineSecrets(env ?? {}, `${source}.env`)

  return { executable, args, cwd, env, requiredEnv }
}

function validateArtifactSpec(raw: Record<string, unknown> | undefined, source: string): CoderArtifactSpec | undefined {
  if (!raw) return undefined
  const usage = readOptionalString(raw, "usage", source)
  if (usage && !USAGE_PARSERS.has(usage as CoderUsageParser)) {
    throw new Error(`${source}.usage is invalid: ${usage}`)
  }
  return {
    transcript: readOptionalString(raw, "transcript", source),
    patch: readOptionalString(raw, "patch", source),
    usage: usage as CoderUsageParser | undefined,
  }
}

function rejectInlineSecrets(env: Record<string, string>, source: string): void {
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_ENV_PATTERN.test(key)) continue
    if (isTemplateOnly(value) || value.startsWith("$")) continue
    throw new Error(`${source}.${key} must reference an env var or template placeholder, not store a literal secret`)
  }
}

function isTemplateOnly(value: string): boolean {
  return /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(value)
}

function readEnum<T extends string>(raw: Record<string, unknown>, key: string, source: string, allowed: Set<T>): T {
  const value = readString(raw, key, source)
  if (!allowed.has(value as T)) throw new Error(`${source}.${key} is invalid: ${value}`)
  return value as T
}

function readRecord(raw: Record<string, unknown>, key: string, source: string): Record<string, unknown> {
  return asRecord(raw[key], `${source}.${key}`)
}

function readOptionalRecord(raw: Record<string, unknown>, key: string, source: string): Record<string, unknown> | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  return asRecord(value, `${source}.${key}`)
}

function readString(raw: Record<string, unknown>, key: string, source: string): string {
  const value = raw[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${key} must be a non-empty string`)
  return value
}

function readOptionalString(raw: Record<string, unknown>, key: string, source: string): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${source}.${key} must be a string`)
  return value
}

function readNumber(raw: Record<string, unknown>, key: string, source: string): number {
  const value = raw[key]
  if (typeof value !== "number") throw new Error(`${source}.${key} must be a number`)
  return value
}

function readStringArray(raw: Record<string, unknown>, key: string, source: string): string[] {
  const value = raw[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source}.${key} must be a string array`)
  }
  return value
}

function readOptionalStringArray(raw: Record<string, unknown>, key: string, source: string): string[] | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source}.${key} must be a string array`)
  }
  return value
}

function readOptionalStringMap(raw: Record<string, unknown>, key: string, source: string): Record<string, string> | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  const record = asRecord(value, `${source}.${key}`)
  const result: Record<string, string> = {}
  for (const [envKey, envValue] of Object.entries(record)) {
    if (typeof envValue !== "string") throw new Error(`${source}.${key}.${envKey} must be a string`)
    result[envKey] = envValue
  }
  return result
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object`)
  }
  return value as Record<string, unknown>
}

function cloneAdapter(adapter: CoderAdapter): CoderAdapter {
  return cloneJson(adapter) as CoderAdapter
}

function cloneJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value))
}
