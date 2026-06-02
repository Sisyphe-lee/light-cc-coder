export const CODER_ADAPTER_SCHEMA_VERSION = 1

export const CODER_ADAPTER_PLACEHOLDERS = [
  "instruction",
  "workspace",
  "artifactDir",
  "transcriptPath",
  "patchPath",
  "resultPath",
  "model",
  "baseUrl",
  "apiKeyEnv",
  "maxSteps",
  "permissionMode",
  "osSandbox",
  "sandboxSettings",
  "executable",
] as const

export type CoderAdapterPlaceholder = (typeof CODER_ADAPTER_PLACEHOLDERS)[number]

export type CoderEvalTarget = "swebench" | "terminal-bench"

export type CoderAdapterStatus = "ready" | "draft"

export type CoderInstallKind = "none" | "npm" | "pip" | "pipx" | "source" | "docker" | "custom"

export type CoderUsageParser = "none" | "lightcc-transcript" | "custom"

export type CoderInstallSpec = {
  kind: CoderInstallKind
  package?: string
  commands?: string[]
  notes?: string[]
}

export type CoderCommandSpec = {
  executable: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  requiredEnv?: string[]
}

export type CoderArtifactSpec = {
  transcript?: string
  patch?: string
  usage?: CoderUsageParser
}

export type CoderAdapterMetadata = {
  homepage?: string
  docs?: string
  notes?: string[]
}

export type CoderAdapter = {
  schemaVersion: typeof CODER_ADAPTER_SCHEMA_VERSION
  id: string
  displayName: string
  status: CoderAdapterStatus
  targets: CoderEvalTarget[]
  install: CoderInstallSpec
  command: CoderCommandSpec
  artifacts?: CoderArtifactSpec
  metadata?: CoderAdapterMetadata
}

export type CoderAdapterVariables = Partial<Record<CoderAdapterPlaceholder, string>> & Record<string, string | undefined>

export type RenderedCoderCommand = {
  adapterId: string
  displayName: string
  status: CoderAdapterStatus
  executable: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  requiredEnv: string[]
  artifacts: CoderArtifactSpec
}
