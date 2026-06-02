import { randomUUID } from "node:crypto"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { SessionEventDraft } from "../../core/events"
import { LocalRuntime, type LocalRuntimeOptions } from "../LocalRuntime"
import { RuntimeExecutionError, type ExecuteShellInput, type ExecuteShellResult, type Runtime } from "../types"
import { normalizeOsSandboxConfig, sandboxConfigHash, type OsSandboxConfig } from "./config"

export type SandboxRuntimeModule = {
  SandboxManager?: SandboxManagerShape
  SandboxRuntimeConfigSchema?: {
    safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown }
  }
}

export type SandboxRuntimeSource = "package" | "submodule" | "custom"

export type SandboxRuntimeLoadResult =
  | { ok: true; module: SandboxRuntimeModule; version?: string; source?: SandboxRuntimeSource; entryPath?: string }
  | { ok: false; reason: string }

export type SandboxRuntimeLoader = () => Promise<SandboxRuntimeLoadResult> | SandboxRuntimeLoadResult

type SandboxManagerShape = {
  initialize(config: unknown, askCallback?: unknown, enableLogMonitor?: boolean): Promise<void> | void
  isSupportedPlatform?: () => boolean
  checkDependencies?: () => { errors?: string[]; warnings?: string[] }
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
  ): Promise<string> | string
  cleanupAfterCommand?: () => void
  reset?: () => Promise<void> | void
  annotateStderrWithSandboxFailures?: (command: string, stderr: string) => string
}

type SandboxStatusDiagnostic = Extract<SessionEventDraft, { type: "sandbox.status" }>

type DiagnosticRuntime = Runtime & {
  drainSandboxDiagnostics?: () => SandboxStatusDiagnostic[]
  getSandboxStatus?: () => SandboxRuntimeStatus
}

export type SandboxRuntimeStatus = {
  requestedMode: OsSandboxConfig["mode"]
  status: "not_initialized" | "active" | "fallback" | "unavailable"
  active: boolean
  platform: string
  configHash: string
  fallbackReason?: string
}

export type OptionalSandboxRuntimeOptions = LocalRuntimeOptions & {
  sandbox?: Partial<OsSandboxConfig>
  loader?: SandboxRuntimeLoader
}

export async function createLocalRuntimeWithOptionalSandbox(
  options: OptionalSandboxRuntimeOptions,
): Promise<{ runtime: Runtime; localRuntime: LocalRuntime }> {
  const localRuntime = await LocalRuntime.create(options)
  const sandbox = normalizeOsSandboxConfig(options.sandbox)
  const configHash = sandboxConfigHash(sandbox)
  if (sandbox.mode === "off") {
    return { runtime: localRuntime, localRuntime }
  }

  return {
    runtime: new SandboxRuntimeWrapper({ localRuntime, sandbox, configHash, loader: options.loader ?? loadSandboxRuntime }),
    localRuntime,
  }
}

export function drainSandboxRuntimeDiagnostics(runtime: Runtime): SandboxStatusDiagnostic[] {
  const diagnostics = (runtime as DiagnosticRuntime).drainSandboxDiagnostics?.()
  return diagnostics ?? []
}

export function getSandboxRuntimeStatus(runtime: Runtime): SandboxRuntimeStatus | undefined {
  return (runtime as DiagnosticRuntime).getSandboxStatus?.()
}

export async function loadSandboxRuntime(): Promise<SandboxRuntimeLoadResult> {
  const reasons: string[] = []
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>

  const packageSource = await resolvePackageSandboxRuntimeSource()
  if (packageSource.ok) {
    try {
      const module = (await dynamicImport(pathToFileURL(packageSource.entryPath).href)) as SandboxRuntimeModule
      return { ok: true, module, version: packageSource.version, source: "package", entryPath: packageSource.entryPath }
    } catch (error) {
      reasons.push(`package ${packageSource.entryPath}: ${errorMessage(error)}`)
    }
  } else {
    reasons.push(`package: ${packageSource.reason}`)
  }

  for (const candidate of await localSandboxRuntimeDistCandidates()) {
    try {
      await access(candidate.entryPath)
      const module = (await dynamicImport(pathToFileURL(candidate.entryPath).href)) as SandboxRuntimeModule
      return { ok: true, module, version: candidate.version, source: "submodule", entryPath: candidate.entryPath }
    } catch (error) {
      reasons.push(`${candidate.entryPath}: ${errorMessage(error)}`)
    }
  }

  return { ok: false, reason: reasons.join("; ") }
}

type SandboxRuntimeResolvedSource =
  | { ok: true; entryPath: string; version?: string }
  | { ok: false; reason: string }

async function resolvePackageSandboxRuntimeSource(): Promise<SandboxRuntimeResolvedSource> {
  try {
    const require = createRequire(import.meta.url)
    const entryPath = require.resolve("@anthropic-ai/sandbox-runtime")
    let version: string | undefined
    try {
      version = await readPackageVersion(require.resolve("@anthropic-ai/sandbox-runtime/package.json"))
    } catch {
      version = undefined
    }
    return { ok: true, entryPath, version }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
}

async function localSandboxRuntimeDistCandidates(): Promise<Array<{ entryPath: string; version?: string }>> {
  const here = dirname(fileURLToPath(import.meta.url))
  const entries = unique([
    resolve(process.cwd(), "sandbox-runtime/dist/index.js"),
    resolve(here, "../../../sandbox-runtime/dist/index.js"),
    resolve(here, "../sandbox-runtime/dist/index.js"),
  ])
  return Promise.all(
    entries.map(async (entryPath) => ({
      entryPath,
      version: await readPackageVersion(resolve(dirname(entryPath), "../package.json")),
    })),
  )
}

async function readPackageVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : undefined
  } catch {
    return undefined
  }
}

export async function resolveSandboxRuntimeConfig(
  workspaceRoot: string,
  sandbox: OsSandboxConfig,
): Promise<{ ok: true; config: unknown } | { ok: false; reason: string }> {
  const loaded = sandbox.settingsPath
    ? await readSandboxSettings(sandbox.settingsPath)
    : { ok: true as const, config: buildDefaultSandboxRuntimeConfig(workspaceRoot, sandbox) }
  if (!loaded.ok) return loaded
  return { ok: true, config: mergeCliAllowLists(loaded.config, sandbox) }
}

async function readSandboxSettings(path: string): Promise<{ ok: true; config: unknown } | { ok: false; reason: string }> {
  try {
    const content = await readFile(path, "utf8")
    return { ok: true, config: JSON.parse(content) as unknown }
  } catch (error) {
    return { ok: false, reason: `failed to read sandbox settings ${path}: ${errorMessage(error)}` }
  }
}

function buildDefaultSandboxRuntimeConfig(workspaceRoot: string, sandbox: OsSandboxConfig): unknown {
  const home = homedir()
  return {
    network: {
      allowedDomains: sandbox.allowDomains,
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [join(home, ".ssh"), join(home, ".aws"), join(home, ".kube"), join(home, ".docker")],
      allowRead: [workspaceRoot],
      allowWrite: [workspaceRoot, tmpdir(), ...sandbox.allowWrites],
      denyWrite: [
        join(workspaceRoot, ".env"),
        join(workspaceRoot, ".env.*"),
        join(workspaceRoot, ".git", "config"),
        join(workspaceRoot, ".git", "hooks"),
        join(home, ".bashrc"),
        join(home, ".zshrc"),
        join(home, ".profile"),
        join(home, ".bash_profile"),
        join(home, ".gitconfig"),
        join(home, ".ssh"),
        join(home, ".aws"),
        join(home, ".kube"),
        join(home, ".docker"),
      ],
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  }
}

function mergeCliAllowLists(config: unknown, sandbox: OsSandboxConfig): unknown {
  if ((!sandbox.allowDomains.length && !sandbox.allowWrites.length) || !isRecord(config)) return config
  const network = isRecord(config.network) ? { ...config.network } : {}
  const filesystem = isRecord(config.filesystem) ? { ...config.filesystem } : {}
  if (sandbox.allowDomains.length > 0) {
    network.allowedDomains = unique([...(arrayOfStrings(network.allowedDomains) ?? []), ...sandbox.allowDomains])
  }
  if (sandbox.allowWrites.length > 0) {
    filesystem.allowWrite = unique([...(arrayOfStrings(filesystem.allowWrite) ?? []), ...sandbox.allowWrites])
  }
  return { ...config, network, filesystem }
}

export function validateConfig(
  module: SandboxRuntimeModule,
  config: unknown,
): { ok: true; config: unknown } | { ok: false; reason: string } {
  if (!isRecord(config)) return { ok: false, reason: "settings must be a JSON object" }
  const schema = module.SandboxRuntimeConfigSchema
  if (!schema) return { ok: true, config }
  const result = schema.safeParse(config)
  if (result.success) return { ok: true, config: result.data ?? config }
  return { ok: false, reason: errorMessage(result.error) }
}

export function getSandboxManager(module: SandboxRuntimeModule): SandboxManagerShape | undefined {
  const manager = module.SandboxManager
  if (!manager || typeof manager !== "object") return undefined
  if (typeof manager.initialize !== "function") return undefined
  if (typeof manager.wrapWithSandbox !== "function") return undefined
  if (manager.isSupportedPlatform !== undefined && typeof manager.isSupportedPlatform !== "function") return undefined
  if (manager.checkDependencies !== undefined && typeof manager.checkDependencies !== "function") return undefined
  if (manager.cleanupAfterCommand !== undefined && typeof manager.cleanupAfterCommand !== "function") return undefined
  if (manager.reset !== undefined && typeof manager.reset !== "function") return undefined
  if (
    manager.annotateStderrWithSandboxFailures !== undefined &&
    typeof manager.annotateStderrWithSandboxFailures !== "function"
  ) {
    return undefined
  }
  return manager
}

function statusDiagnostic(
  sandbox: Pick<OsSandboxConfig, "mode">,
  configHash: string,
  active: boolean,
  reason?: string,
  message?: string,
  version?: string,
): SandboxStatusDiagnostic {
  return {
    type: "sandbox.status",
    requestedMode: sandbox.mode,
    active,
    backendName: active ? "@anthropic-ai/sandbox-runtime" : undefined,
    backendVersion: version,
    platform: process.platform,
    configHash,
    fallbackReason: reason,
    message,
  }
}

type SandboxRuntimeState =
  | { kind: "fallback"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "active"; manager: SandboxManagerShape }

class SandboxRuntimeWrapper implements Runtime {
  private cwd: string
  private diagnostics: SandboxStatusDiagnostic[]
  private state?: SandboxRuntimeState
  private statePromise?: Promise<SandboxRuntimeState>

  constructor(
    private readonly options: {
      localRuntime: LocalRuntime
      sandbox: OsSandboxConfig
      configHash: string
      loader: SandboxRuntimeLoader
    },
  ) {
    this.cwd = options.localRuntime.getCwd()
    this.diagnostics = []
  }

  getCwd(): string {
    return this.state?.kind === "active" ? this.cwd : this.options.localRuntime.getCwd()
  }

  async executeShell(input: ExecuteShellInput): Promise<ExecuteShellResult> {
    if (input.signal?.aborted) {
      return this.options.localRuntime.executeShell({ ...input, cwd: input.cwd || this.cwd })
    }
    const state = await this.getState()
    if (state.kind === "unavailable") {
      throw new RuntimeExecutionError("sandbox_unavailable", state.reason, input.command)
    }
    if (state.kind === "fallback") return this.options.localRuntime.executeShell(input)

    const manager = state.manager

    const cwdFile = resolve(tmpdir(), `light-cc-sandbox-cwd-${randomUUID()}`)
    await writeFile(cwdFile, "", "utf8")
    const commandWithCwdMarker = [
      `trap 'status=$?; pwd -P > ${shellQuote(cwdFile)}; exit "$status"' EXIT`,
      `eval ${shellQuote(input.command)}`,
    ].join("; ")

    let sandboxedCommand: string
    try {
      sandboxedCommand = await manager.wrapWithSandbox(commandWithCwdMarker, "/bin/bash", undefined, input.signal)
      if (typeof sandboxedCommand !== "string") {
        throw new Error("SandboxManager.wrapWithSandbox returned a non-string command")
      }
    } catch (error) {
      await rm(cwdFile, { force: true }).catch(() => undefined)
      if (error instanceof RuntimeExecutionError) throw error
      throw new RuntimeExecutionError("sandbox_unavailable", "Failed to prepare OS sandbox command", input.command, error)
    }

    try {
      const result = await this.options.localRuntime.executeShell({
        ...input,
        command: sandboxedCommand,
        cwd: input.cwd || this.cwd,
      })
      const sandboxFinalCwd = await readFinalCwd(cwdFile)
      if (sandboxFinalCwd && isContained(this.options.localRuntime.workspaceRoot, sandboxFinalCwd)) {
        this.cwd = sandboxFinalCwd
      }
      const stderr = manager.annotateStderrWithSandboxFailures
        ? manager.annotateStderrWithSandboxFailures(input.command, result.stderr)
        : result.stderr
      return {
        ...result,
        command: input.command,
        finalCwd: sandboxFinalCwd ?? result.finalCwd,
        stderr,
        stderrBytes: Buffer.byteLength(stderr),
      }
    } finally {
      try {
        manager.cleanupAfterCommand?.()
      } catch {
        // Cleanup is best-effort; the shell result already reflects command execution.
      }
      await rm(cwdFile, { force: true }).catch(() => undefined)
    }
  }

  drainSandboxDiagnostics(): SandboxStatusDiagnostic[] {
    const diagnostics = this.diagnostics
    this.diagnostics = []
    return diagnostics
  }

  getSandboxStatus(): SandboxRuntimeStatus {
    const state = this.state
    const status =
      state?.kind === "active" ? "active" : state?.kind === "fallback" ? "fallback" : state?.kind === "unavailable" ? "unavailable" : "not_initialized"
    return {
      requestedMode: this.options.sandbox.mode,
      status,
      active: status === "active",
      platform: process.platform,
      configHash: this.options.configHash,
      fallbackReason: state?.kind === "fallback" || state?.kind === "unavailable" ? state.reason : undefined,
    }
  }

  async close(): Promise<void> {
    const state = this.state ?? (this.statePromise ? await this.statePromise.catch(() => undefined) : undefined)
    if (state?.kind === "active") await state.manager.reset?.()
    await this.options.localRuntime.close?.()
  }

  private async getState(): Promise<SandboxRuntimeState> {
    if (this.state) return this.state
    if (!this.statePromise) {
      this.statePromise = this.initializeState().then((state) => {
        this.state = state
        this.statePromise = undefined
        return state
      })
    }
    return this.statePromise
  }

  private async initializeState(): Promise<SandboxRuntimeState> {
    const { localRuntime, sandbox, configHash, loader } = this.options
    const configResult = await resolveSandboxRuntimeConfig(localRuntime.workspaceRoot, sandbox)
    if (!configResult.ok) return this.unavailableState(configResult.reason, true)

    let load: SandboxRuntimeLoadResult
    try {
      load = await loader()
    } catch (error) {
      return this.unavailableState(errorMessage(error))
    }
    if (!load.ok) return this.unavailableState(load.reason)

    const manager = getSandboxManager(load.module)
    if (!manager) return this.unavailableState("sandbox-runtime module shape is unsupported")

    if (manager.isSupportedPlatform && !manager.isSupportedPlatform()) {
      return this.unavailableState(`unsupported platform: ${process.platform}`)
    }

    const validatedConfig = validateConfig(load.module, configResult.config)
    if (!validatedConfig.ok) {
      return this.unavailableState(`invalid sandbox config: ${validatedConfig.reason}`, Boolean(sandbox.settingsPath))
    }

    try {
      const dependencies = manager.checkDependencies?.()
      if (dependencies?.errors && dependencies.errors.length > 0) {
        return this.unavailableState(dependencies.errors.join("; "))
      }
    } catch (error) {
      return this.unavailableState(errorMessage(error))
    }

    try {
      await manager.initialize(validatedConfig.config, undefined, false)
    } catch (error) {
      return this.unavailableState(errorMessage(error))
    }

    this.diagnostics.push(statusDiagnostic(sandbox, configHash, true, undefined, undefined, load.version))
    return { kind: "active", manager }
  }

  private unavailableState(reason: string, failClosed = false): SandboxRuntimeState {
    const { sandbox, configHash } = this.options
    const shouldFallback = sandbox.mode === "auto" && !failClosed
    this.diagnostics.push(
      statusDiagnostic(
        sandbox,
        configHash,
        false,
        reason,
        shouldFallback
          ? "OS sandbox unavailable; using LocalRuntime because mode is auto"
          : "OS sandbox unavailable; command will not be run without sandbox",
      ),
    )
    return shouldFallback ? { kind: "fallback", reason } : { kind: "unavailable", reason }
  }
}

async function readFinalCwd(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8")
    return content.trim() || undefined
  } catch {
    return undefined
  }
}

function isContained(root: string, pathToCheck: string): boolean {
  const rel = relative(root, pathToCheck)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined
  return value
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}
