export const TERMINAL_BENCH_DEFAULTS = {
  runner: "harbor==0.13.0",
  datasetName: "terminal-bench/terminal-bench-2-1",
  attempts: 1,
  leaderboardAttempts: 5,
  agentImportPath: "evals.terminal_bench.agent:LightCCCoderAgent",
} as const

export type TerminalBenchRunMode = "dry-run" | "run"

export type TerminalBenchOptions = {
  tasksFile?: string
  tasks: string[]
  limit?: number
  datasetName: string
  attempts: number
  runId?: string
  reportDir?: string
  jobsDir?: string
  preflight: boolean
  runHarbor: boolean
  dryRunExplicit: boolean
  allowLargeRun: boolean
  allowUnverifiedRuntime: boolean
  harborBin: string
  pythonBin?: string
  agentImportPath: string
  model?: string
  environment?: string
  nConcurrent?: number
  timeoutMultiplier?: number
  agentTimeoutMultiplier?: number
  verifierTimeoutMultiplier?: number
  agentSetupTimeoutMultiplier?: number
  environmentBuildTimeoutMultiplier?: number
  allowAgentHosts: string[]
  allowEnvironmentHosts: string[]
  verifierEnv: string[]
  verifierProxy?: string
  extraDockerCompose: string[]
  agentPackageSpec?: string
  agentNodeDir?: string
  agentEnvFile?: string
  mounts: string[]
  externalInstallMode: "online" | "mounted"
  externalHostDir?: string
  externalContainerBinDir: string
  externalRunTimeoutSeconds: number
  maxSteps: number
  permissionMode: "read-only" | "workspace-write" | "danger-full-access"
  osSandbox: "off" | "auto" | "required"
  sandboxSettings?: string
  baseUrl?: string
  apiKeyEnv: string
  coder: string
  agentProfile: boolean
  providerProfilePath?: string
}

export type TerminalBenchRunContext = {
  runId: string
  reportDir: string
  jobsDir: string
}

export type TerminalBenchCommand = {
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type TerminalBenchCoderRuntime = "lightcc-installed-agent" | "external-installed-agent" | "planned-external-installed-agent"

export type TerminalBenchCoderRunStatus = "ready" | "smoke-unverified" | "dry-run-only"

export type TerminalBenchCoderMetadata = {
  id: string
  displayName: string
  status: string
  model: string
  installKind: string
  installPackage?: string
  runtime: TerminalBenchCoderRuntime
  runStatus: TerminalBenchCoderRunStatus
}

export type TerminalBenchTaskResult = {
  taskId: string
  status: "prepared" | "completed" | "failed" | "skipped"
  artifactDir: string
  error?: string
}

export function safeTaskId(value: string): string {
  if (!/^[A-Za-z0-9_.:/-]+$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error(`Invalid Terminal-Bench task id: ${value}`)
  }
  return value
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_")
}
