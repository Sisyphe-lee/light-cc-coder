import {
  WRAPPER_PROFILE_ARTIFACT_KINDS,
  WRAPPER_PROFILE_SCHEMA_VERSION,
  type WrapperProfile,
  type WrapperProfileArtifactKind,
} from "./types"

export type WrapperProfileValidation = {
  ok: boolean
  errors: string[]
}

const MAX_METADATA_LENGTH = 256
const MAX_PATH_LENGTH = 4096
const MAX_HASH_LENGTH = 128
const MAX_ENV_NAME_LENGTH = 128
const MAX_ARTIFACTS = 64
const MAX_ENV_NAMES = 128
const MAX_WARNINGS = 64
const SAFE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/
const RAW_PAYLOAD_KEYS = new Set([
  "args",
  "argv",
  "arguments",
  "prompt",
  "stdout",
  "stderr",
  "patch",
  "diff",
  "content",
  "output",
  "env",
  "environmentValues",
])

export function validateWrapperProfile(value: unknown): WrapperProfileValidation {
  const errors: string[] = []
  const profile = record(value)
  if (!profile) return { ok: false, errors: ["$: expected object"] }

  collectRawPayloadKeys(profile, "$", errors)
  expectKeys(
    profile,
    "$",
    ["schemaVersion", "generatedAt", "wrapper", "run", "command", "artifacts", "environment", "process", "warnings"],
    errors,
  )
  expectConst(profile.schemaVersion, WRAPPER_PROFILE_SCHEMA_VERSION, "$.schemaVersion", errors)
  expectString(profile.generatedAt, "$.generatedAt", errors, MAX_METADATA_LENGTH)

  validateWrapper(record(profile.wrapper), "$.wrapper", errors)
  validateRun(record(profile.run), "$.run", errors)
  validateCommand(record(profile.command), "$.command", errors)
  validateArtifacts(profile.artifacts, errors)
  validateEnvironment(record(profile.environment), errors)
  validateProcess(record(profile.process), "$.process", errors)
  validateWarnings(profile.warnings, errors)

  return { ok: errors.length === 0, errors }
}

export function isValidWrapperProfile(value: unknown): value is WrapperProfile {
  return validateWrapperProfile(value).ok
}

function validateWrapper(value: Record<string, unknown> | undefined, path: string, errors: string[]): void {
  if (!value) {
    errors.push(`${path}: expected object`)
    return
  }
  expectKeys(value, path, ["id", "displayName", "version", "runtime"], errors)
  expectString(value.id, `${path}.id`, errors, MAX_METADATA_LENGTH)
  expectOptionalString(value.displayName, `${path}.displayName`, errors, MAX_METADATA_LENGTH)
  expectOptionalString(value.version, `${path}.version`, errors, MAX_METADATA_LENGTH)
  expectOptionalString(value.runtime, `${path}.runtime`, errors, MAX_METADATA_LENGTH)
}

function validateRun(value: Record<string, unknown> | undefined, path: string, errors: string[]): void {
  if (!value) {
    errors.push(`${path}: expected object`)
    return
  }
  expectKeys(value, path, ["benchmark", "runId", "itemId", "attempt"], errors)
  expectOptionalString(value.benchmark, `${path}.benchmark`, errors, MAX_METADATA_LENGTH)
  expectOptionalString(value.runId, `${path}.runId`, errors, MAX_METADATA_LENGTH)
  expectOptionalString(value.itemId, `${path}.itemId`, errors, MAX_METADATA_LENGTH)
  expectOptionalNonNegativeInteger(value.attempt, `${path}.attempt`, errors)
}

function validateCommand(value: Record<string, unknown> | undefined, path: string, errors: string[]): void {
  if (!value) {
    errors.push(`${path}: expected object`)
    return
  }
  expectKeys(value, path, ["executablePath", "cwd", "argCount", "argsSha256"], errors)
  expectOptionalString(value.executablePath, `${path}.executablePath`, errors, MAX_PATH_LENGTH)
  expectOptionalString(value.cwd, `${path}.cwd`, errors, MAX_PATH_LENGTH)
  expectOptionalNonNegativeInteger(value.argCount, `${path}.argCount`, errors)
  expectOptionalHash(value.argsSha256, `${path}.argsSha256`, errors)
}

function validateArtifacts(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("$.artifacts: expected array")
    return
  }
  if (value.length > MAX_ARTIFACTS) errors.push(`$.artifacts: expected at most ${MAX_ARTIFACTS} entries`)
  value.forEach((entry, index) => {
    const path = `$.artifacts[${index}]`
    const artifact = record(entry)
    if (!artifact) {
      errors.push(`${path}: expected object`)
      return
    }
    expectKeys(artifact, path, ["kind", "path", "bytes", "sha256"], errors)
    const kind = artifact.kind
    if (typeof kind !== "string" || !WRAPPER_PROFILE_ARTIFACT_KINDS.includes(kind as WrapperProfileArtifactKind)) {
      errors.push(`${path}.kind: expected known artifact kind`)
    }
    expectString(artifact.path, `${path}.path`, errors, MAX_PATH_LENGTH)
    expectOptionalNonNegativeIntegerOrNull(artifact.bytes, `${path}.bytes`, errors)
    expectOptionalHashOrNull(artifact.sha256, `${path}.sha256`, errors)
  })
}

function validateEnvironment(value: Record<string, unknown> | undefined, errors: string[]): void {
  if (!value) {
    errors.push("$.environment: expected object")
    return
  }
  expectKeys(value, "$.environment", ["requiredNames", "forwardedNames", "presentNames", "missingNames"], errors)
  for (const key of ["requiredNames", "forwardedNames", "presentNames", "missingNames"] as const) {
    validateEnvNames(value[key], `$.environment.${key}`, errors)
  }
}

function validateEnvNames(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`)
    return
  }
  if (value.length > MAX_ENV_NAMES) errors.push(`${path}: expected at most ${MAX_ENV_NAMES} names`)
  for (const [index, name] of value.entries()) {
    const itemPath = `${path}[${index}]`
    expectString(name, itemPath, errors, MAX_ENV_NAME_LENGTH)
    if (typeof name === "string" && !SAFE_ENV_NAME_PATTERN.test(name)) errors.push(`${itemPath}: expected environment variable name`)
  }
}

function validateProcess(value: Record<string, unknown> | undefined, path: string, errors: string[]): void {
  if (!value) {
    errors.push(`${path}: expected object`)
    return
  }
  expectKeys(value, path, ["exitCode", "signal", "durationMs"], errors)
  expectOptionalIntegerOrNull(value.exitCode, `${path}.exitCode`, errors)
  expectOptionalStringOrNull(value.signal, `${path}.signal`, errors, MAX_METADATA_LENGTH)
  expectOptionalNonNegativeNumberOrNull(value.durationMs, `${path}.durationMs`, errors)
}

function validateWarnings(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("$.warnings: expected array")
    return
  }
  if (value.length > MAX_WARNINGS) errors.push(`$.warnings: expected at most ${MAX_WARNINGS} warnings`)
  value.forEach((warning, index) => expectString(warning, `$.warnings[${index}]`, errors, MAX_METADATA_LENGTH))
}

function collectRawPayloadKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRawPayloadKeys(item, `${path}[${index}]`, errors))
    return
  }
  const object = record(value)
  if (!object) return
  for (const [key, nested] of Object.entries(object)) {
    if (RAW_PAYLOAD_KEYS.has(key)) errors.push(`${path}.${key}: raw payload field is not allowed in wrapper.profile.json`)
    collectRawPayloadKeys(nested, `${path}.${key}`, errors)
  }
}

function expectKeys(value: Record<string, unknown>, path: string, allowed: string[], errors: string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key}: unexpected property`)
  }
}

function expectConst(value: unknown, expected: unknown, path: string, errors: string[]): void {
  if (value !== expected) errors.push(`${path}: expected ${JSON.stringify(expected)}`)
}

function expectString(value: unknown, path: string, errors: string[], maxLength: number): void {
  if (typeof value !== "string") {
    errors.push(`${path}: expected string`)
    return
  }
  if (value.length > maxLength) errors.push(`${path}: expected length <= ${maxLength}`)
}

function expectOptionalString(value: unknown, path: string, errors: string[], maxLength: number): void {
  if (value === undefined) return
  expectString(value, path, errors, maxLength)
}

function expectOptionalStringOrNull(value: unknown, path: string, errors: string[], maxLength: number): void {
  if (value === undefined || value === null) return
  expectString(value, path, errors, maxLength)
}

function expectOptionalHash(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  expectString(value, path, errors, MAX_HASH_LENGTH)
  if (typeof value === "string" && !SHA256_PATTERN.test(value)) errors.push(`${path}: expected sha256 hex`)
}

function expectOptionalHashOrNull(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return
  expectOptionalHash(value, path, errors)
}

function expectOptionalNonNegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) errors.push(`${path}: expected non-negative integer`)
}

function expectOptionalIntegerOrNull(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer or null`)
}

function expectOptionalNonNegativeIntegerOrNull(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) errors.push(`${path}: expected non-negative integer or null`)
}

function expectOptionalNonNegativeNumberOrNull(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`${path}: expected non-negative number or null`)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
