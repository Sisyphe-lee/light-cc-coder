export const WRAPPER_PROFILE_SCHEMA_VERSION = 1

export const WRAPPER_PROFILE_ARTIFACT_KINDS = [
  "prompt",
  "transcript",
  "stdout",
  "stderr",
  "patch",
  "result",
  "summary",
  "workspace",
  "log",
  "other",
] as const

export type WrapperProfileArtifactKind = (typeof WRAPPER_PROFILE_ARTIFACT_KINDS)[number]

export type WrapperProfileArtifactRef = {
  kind: WrapperProfileArtifactKind
  path: string
  bytes?: number | null
  sha256?: string | null
}

export type WrapperProfile = {
  schemaVersion: typeof WRAPPER_PROFILE_SCHEMA_VERSION
  generatedAt: string
  wrapper: {
    id: string
    displayName?: string
    version?: string
    runtime?: string
  }
  run: {
    benchmark?: string
    runId?: string
    itemId?: string
    attempt?: number
  }
  command: {
    executablePath?: string
    cwd?: string
    argCount?: number
    argsSha256?: string
  }
  artifacts: WrapperProfileArtifactRef[]
  environment: {
    requiredNames: string[]
    forwardedNames: string[]
    presentNames: string[]
    missingNames: string[]
  }
  process: {
    exitCode?: number | null
    signal?: string | null
    durationMs?: number | null
  }
  warnings: string[]
}
