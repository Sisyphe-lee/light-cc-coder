import {
  errorMessage,
  getSandboxManager,
  loadSandboxRuntime,
  resolveSandboxRuntimeConfig,
  validateConfig,
  type SandboxRuntimeLoadResult,
  type SandboxRuntimeLoader,
  type SandboxRuntimeSource,
} from "./createRuntime"
import { normalizeOsSandboxConfig, sandboxConfigHash, type OsSandboxConfig } from "./config"

export type SandboxAvailabilityCheck = {
  status: "ready" | "warning" | "blocked"
  name: string
  message: string
}

export type SandboxAvailabilityReport = {
  requestedMode: OsSandboxConfig["mode"]
  available: boolean
  backendName?: string
  backendVersion?: string
  backendEntryPath?: string
  source?: SandboxRuntimeSource
  platform: string
  configHash: string
  settingsPath?: string
  allowDomains: string[]
  allowWrites: string[]
  fallbackReason?: string
  checks: SandboxAvailabilityCheck[]
}

export async function inspectSandboxRuntimeAvailability(input: {
  workspaceRoot: string
  sandbox?: Partial<OsSandboxConfig>
  loader?: SandboxRuntimeLoader
}): Promise<SandboxAvailabilityReport> {
  const sandbox = normalizeOsSandboxConfig(input.sandbox)
  const configHash = sandboxConfigHash(sandbox)
  const checks: SandboxAvailabilityCheck[] = [
    readyCheck("sandbox.mode", sandbox.mode === "off" ? "off; LocalRuntime will be used" : `${sandbox.mode}; backend loads lazily on bash`),
    readyCheck("sandbox.config", `hash ${configHash}${sandbox.settingsPath ? `; settings ${sandbox.settingsPath}` : "; generated default policy"}`),
    readyCheck(
      "sandbox.policy",
      `network domains ${sandbox.allowDomains.length > 0 ? sandbox.allowDomains.join(", ") : "none"}; extra write paths ${
        sandbox.allowWrites.length > 0 ? sandbox.allowWrites.join(", ") : "none"
      }`,
    ),
  ]

  if (sandbox.mode === "off") {
    return {
      requestedMode: sandbox.mode,
      available: false,
      platform: process.platform,
      configHash,
      settingsPath: sandbox.settingsPath,
      allowDomains: sandbox.allowDomains,
      allowWrites: sandbox.allowWrites,
      checks,
    }
  }

  const configResult = await resolveSandboxRuntimeConfig(input.workspaceRoot, sandbox)
  if (!configResult.ok) {
    checks.push(blockedCheck("sandbox.settings", configResult.reason))
    return availabilityReport(sandbox, configHash, checks, false, configResult.reason)
  }

  let load: SandboxRuntimeLoadResult
  try {
    load = await (input.loader ?? loadSandboxRuntime)()
  } catch (error) {
    const reason = errorMessage(error)
    checks.push(unavailableCheck(sandbox.mode, "sandbox.backend", reason))
    return availabilityReport(sandbox, configHash, checks, false, reason)
  }
  if (!load.ok) {
    checks.push(unavailableCheck(sandbox.mode, "sandbox.backend", load.reason))
    return availabilityReport(sandbox, configHash, checks, false, load.reason)
  }

  checks.push(
    readyCheck(
      "sandbox.backend",
      `${load.source ?? "custom"} ${load.version ?? "version unknown"}${load.entryPath ? ` at ${load.entryPath}` : ""}`,
    ),
  )
  if (load.source === "submodule") {
    checks.push(warningCheck("sandbox.package", "npm package is unavailable; using local sandbox-runtime/dist fallback"))
  }

  const manager = getSandboxManager(load.module)
  if (!manager) {
    const reason = "sandbox-runtime module shape is unsupported"
    checks.push(unavailableCheck(sandbox.mode, "sandbox.backendShape", reason))
    return availabilityReport(sandbox, configHash, checks, false, reason, load)
  }

  if (manager.isSupportedPlatform && !manager.isSupportedPlatform()) {
    const reason = `unsupported platform: ${process.platform}`
    checks.push(unavailableCheck(sandbox.mode, "sandbox.platform", reason))
    return availabilityReport(sandbox, configHash, checks, false, reason, load)
  }
  checks.push(readyCheck("sandbox.platform", process.platform))

  const validatedConfig = validateConfig(load.module, configResult.config)
  if (!validatedConfig.ok) {
    const reason = `invalid sandbox config: ${validatedConfig.reason}`
    checks.push(blockedCheck("sandbox.settings", reason))
    return availabilityReport(sandbox, configHash, checks, false, reason, load)
  }

  try {
    const dependencies = manager.checkDependencies?.()
    for (const warning of dependencies?.warnings ?? []) {
      checks.push(warningCheck("sandbox.dependency", warning))
    }
    if (dependencies?.errors && dependencies.errors.length > 0) {
      const reason = dependencies.errors.join("; ")
      checks.push(unavailableCheck(sandbox.mode, "sandbox.dependency", reason))
      return availabilityReport(sandbox, configHash, checks, false, reason, load)
    }
  } catch (error) {
    const reason = errorMessage(error)
    checks.push(unavailableCheck(sandbox.mode, "sandbox.dependency", reason))
    return availabilityReport(sandbox, configHash, checks, false, reason, load)
  }

  checks.push(readyCheck("sandbox.availability", "backend dependencies are available; shell commands initialize lazily"))
  return availabilityReport(sandbox, configHash, checks, true, undefined, load)
}

function availabilityReport(
  sandbox: OsSandboxConfig,
  configHash: string,
  checks: SandboxAvailabilityCheck[],
  available: boolean,
  fallbackReason?: string,
  load?: Extract<SandboxRuntimeLoadResult, { ok: true }>,
): SandboxAvailabilityReport {
  return {
    requestedMode: sandbox.mode,
    available,
    backendName: available ? "@anthropic-ai/sandbox-runtime" : undefined,
    backendVersion: load?.version,
    backendEntryPath: load?.entryPath,
    source: load?.source,
    platform: process.platform,
    configHash,
    settingsPath: sandbox.settingsPath,
    allowDomains: sandbox.allowDomains,
    allowWrites: sandbox.allowWrites,
    fallbackReason,
    checks,
  }
}

function readyCheck(name: string, message: string): SandboxAvailabilityCheck {
  return { status: "ready", name, message }
}

function warningCheck(name: string, message: string): SandboxAvailabilityCheck {
  return { status: "warning", name, message }
}

function blockedCheck(name: string, message: string): SandboxAvailabilityCheck {
  return { status: "blocked", name, message }
}

function unavailableCheck(mode: OsSandboxConfig["mode"], name: string, message: string): SandboxAvailabilityCheck {
  return mode === "required" ? blockedCheck(name, message) : warningCheck(name, message)
}
