import { spawn } from "node:child_process"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { inspectSandboxRuntimeAvailability, type SandboxAvailabilityReport } from "../runtime/sandbox/createRuntime"
import { createBuiltinToolRegistry, TodoState } from "../tools/builtins"
import { WorkspaceFs } from "../workspace/WorkspaceFs"
import type { EffectiveConfig } from "./config"
import { renderConfigReport } from "./config"
import { loadMcpConfig } from "./sessionFactory"
import { SessionStore } from "./sessionStore"

export type DoctorResult = {
  exitCode: number
  output: string
}

export type DoctorOptions = {
  sandboxOnly?: boolean
  json?: boolean
}

type Check = {
  status: "ready" | "warning" | "blocked"
  name: string
  message: string
}

export async function runDoctor(config: EffectiveConfig, store: SessionStore, options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: Check[] = []
  let sandbox: SandboxAvailabilityReport | undefined

  if (!options.sandboxOnly) {
    checks.push(...providerChecks(config))
    await checkCwd(config, checks)
    await checkStore(store, checks)
    await checkExecutable("rg", ["--version"], "ripgrep", checks)
    await checkGit(config.cwd.value, checks)
    checks.push({ status: "ready", name: "permission", message: `mode ${config.permissionMode.value}` })
    await checkMcp(config, checks)
    await checkSkills(config, checks)
    checkToolRegistry(checks)
  }

  sandbox = await checkSandbox(config, checks, { focused: Boolean(options.sandboxOnly) })

  const blocked = checks.some((check) => check.status === "blocked")
  if (options.json) {
    return {
      exitCode: blocked ? 1 : 0,
      output: JSON.stringify({ status: blocked ? "blocked" : "ready", checks, sandbox, config: renderConfigJson(config) }, null, 2),
    }
  }
  const output = [
    blocked ? "blocked" : "ready",
    "",
    ...checks.map((check) => `${check.status}\t${check.name}\t${check.message}`),
    "",
    renderConfigReport(config),
  ].join("\n")
  return { exitCode: blocked ? 1 : 0, output }
}

export function renderDryRun(config: EffectiveConfig, store: SessionStore, prompt?: string): string {
  const plan = store.planNew({
    transcriptOverride: config.transcript.value,
    cwd: config.cwd.value,
    model: config.fake.value ? "fake" : (config.model.value ?? "unset"),
    provider: config.fake.value ? "fake" : "openai-compatible",
    permissionMode: config.permissionMode.value,
  })
  return [
    "Dry run only. No provider request, agent tool execution, or normal transcript write will occur.",
    "",
    `Mode: ${prompt ? "one-shot" : "repl"}`,
    `Prompt: ${prompt ? "provided" : "none"}`,
    `Planned session: ${plan.id}`,
    `Planned transcript: ${plan.transcriptPath}`,
    `Planned metadata: ${plan.metadataPath ?? "disabled (--transcript override)"}`,
    "",
    renderConfigReport(config),
  ].join("\n")
}

function providerChecks(config: EffectiveConfig): Check[] {
  if (config.fake.value) return [{ status: "ready", name: "provider", message: "fake provider enabled" }]
  const checks: Check[] = []
  checks.push(config.baseUrl.value ? ready("provider.baseUrl", config.baseUrl.source) : blocked("provider.baseUrl", "missing"))
  checks.push(config.model.value ? ready("provider.model", config.model.source) : blocked("provider.model", "missing"))
  checks.push(
    config.apiKeyPresent.value
      ? ready("provider.apiKey", `${config.apiKeyEnv.value} is set`)
      : blocked("provider.apiKey", `${config.apiKeyEnv.value} is not set`),
  )
  return checks
}

async function checkCwd(config: EffectiveConfig, checks: Check[]): Promise<void> {
  try {
    await WorkspaceFs.create(config.cwd.value)
    checks.push(ready("cwd", config.cwd.value))
  } catch (error) {
    checks.push(blocked("cwd", error instanceof Error ? error.message : String(error)))
  }
}

async function checkStore(store: SessionStore, checks: Check[]): Promise<void> {
  const probe = join(store.dataRoot, `.doctor-${process.pid}-${Date.now()}`)
  try {
    await mkdir(store.dataRoot, { recursive: true })
    await writeFile(probe, "ok", "utf8")
    await rm(probe, { force: true })
    checks.push(ready("sessionStore", store.dataRoot))
  } catch (error) {
    checks.push(blocked("sessionStore", error instanceof Error ? error.message : String(error)))
  }
}

async function checkExecutable(command: string, args: string[], name: string, checks: Check[]): Promise<void> {
  try {
    const { code } = await runCommand(command, args)
    checks.push(code === 0 ? ready(name, `${command} available`) : warning(name, `${command} exited ${code}`))
  } catch (error) {
    checks.push(warning(name, `${command} unavailable: ${error instanceof Error ? error.message : String(error)}`))
  }
}

async function checkOptionalExecutable(
  command: string,
  args: string[],
  name: string,
  checks: Check[],
  context: string,
): Promise<void> {
  try {
    const { code } = await runCommand(command, args)
    checks.push(
      code === 0 ? ready(name, `${command} available (${context})`) : warning(name, `${command} exited ${code} (${context})`),
    )
  } catch (error) {
    checks.push(warning(name, `${command} unavailable (${context}): ${error instanceof Error ? error.message : String(error)}`))
  }
}

async function checkSandbox(
  config: EffectiveConfig,
  checks: Check[],
  options: { focused: boolean },
): Promise<SandboxAvailabilityReport> {
  const report = await inspectSandboxRuntimeAvailability({
    workspaceRoot: config.cwd.value,
    sandbox: {
      mode: config.osSandbox.value,
      settingsPath: config.sandboxSettings.value,
      allowDomains: config.sandboxAllowDomains.value,
      allowWrites: config.sandboxAllowWrites.value,
    },
  })

  checks.push(...report.checks)
  checks.push(
    report.available
      ? ready("sandbox.effective", `active when bash initializes (${report.source ?? "unknown source"})`)
      : sandboxInactiveCheck(report),
  )

  if (report.requestedMode !== "off" && (options.focused || config.osSandbox.value !== "off")) {
    checks.push(...platformSandboxChecks(report))
    await checkSandboxHelpers(report, checks)
  }

  return report
}

function sandboxInactiveCheck(report: SandboxAvailabilityReport): Check {
  if (report.requestedMode === "off") return ready("sandbox.effective", "off; LocalRuntime shell execution")
  const message = report.fallbackReason ?? "backend unavailable"
  return report.requestedMode === "required"
    ? blocked("sandbox.effective", message)
    : warning("sandbox.effective", `${message}; auto mode will use LocalRuntime fallback`)
}

function platformSandboxChecks(report: SandboxAvailabilityReport): Check[] {
  if (process.platform === "linux") {
    return [
      ready("sandbox.platform.detail", "linux backend expects bubblewrap, socat, rg, user namespaces, and optional seccomp helper"),
    ]
  }
  if (process.platform === "darwin") {
    return [ready("sandbox.platform.detail", "macOS backend expects system sandbox-exec/Seatbelt")]
  }
  return [
    report.requestedMode === "required"
      ? blocked("sandbox.platform.detail", `${process.platform} is not supported for Phase 9 OS sandboxing`)
      : warning("sandbox.platform.detail", `${process.platform} is not supported for Phase 9 OS sandboxing`),
  ]
}

async function checkSandboxHelpers(report: SandboxAvailabilityReport, checks: Check[]): Promise<void> {
  if (process.platform === "linux") {
    await checkExecutable("bwrap", ["--version"], "sandbox.bwrap", checks)
    await checkExecutable("socat", ["-V"], "sandbox.socat", checks)
    await checkExecutable("rg", ["--version"], "sandbox.rg", checks)
    await checkOptionalExecutable("srt", ["--version"], "sandbox.srtCli", checks, "optional debug CLI; runtime uses library API")
    await checkLinuxUserNamespace(checks)
    await checkLinuxAppArmor(checks)
    await checkSeccompHelper(report, checks)
    return
  }
  if (process.platform === "darwin") {
    await checkExecutable("sandbox-exec", ["-h"], "sandbox.seatbelt", checks)
  }
}

async function checkLinuxUserNamespace(checks: Check[]): Promise<void> {
  try {
    const value = (await readFile("/proc/sys/kernel/unprivileged_userns_clone", "utf8")).trim()
    checks.push(value === "1" ? ready("sandbox.userns", "unprivileged user namespaces enabled") : warning("sandbox.userns", `unprivileged_userns_clone=${value}`))
  } catch (error) {
    checks.push(warning("sandbox.userns", `could not read user namespace setting: ${error instanceof Error ? error.message : String(error)}`))
  }
}

async function checkLinuxAppArmor(checks: Check[]): Promise<void> {
  try {
    const value = (await readFile("/sys/module/apparmor/parameters/enabled", "utf8")).trim()
    checks.push(value === "Y" ? warning("sandbox.apparmor", "AppArmor enabled; bubblewrap policy may depend on host profile") : ready("sandbox.apparmor", "AppArmor not enabled"))
  } catch {
    checks.push(warning("sandbox.apparmor", "AppArmor status unavailable"))
  }
}

async function checkSeccompHelper(report: SandboxAvailabilityReport, checks: Check[]): Promise<void> {
  const candidates = seccompHelperCandidates(report)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      checks.push(ready("sandbox.seccomp", candidate))
      return
    } catch {
      // Try next known package layout.
    }
  }
  checks.push(warning("sandbox.seccomp", `optional apply-seccomp helper not found in known locations (${candidates.join(", ")})`))
}

function seccompHelperCandidates(report: SandboxAvailabilityReport): string[] {
  const candidates = [resolve(process.cwd(), "sandbox-runtime/vendor/seccomp/x64/apply-seccomp")]
  if (report.backendEntryPath) {
    const distDir = dirname(report.backendEntryPath)
    const packageRoot = dirname(distDir)
    candidates.push(resolve(packageRoot, "vendor/seccomp/x64/apply-seccomp"))
    candidates.push(resolve(distDir, "vendor/seccomp/x64/apply-seccomp"))
  }
  return Array.from(new Set(candidates))
}

async function checkGit(cwd: string, checks: Check[]): Promise<void> {
  try {
    const version = await runCommand("git", ["--version"])
    if (version.code !== 0) {
      checks.push(warning("git", `git --version exited ${version.code}`))
      return
    }
    const worktree = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
    checks.push(
      worktree.code === 0 && worktree.stdout.trim() === "true"
        ? ready("git", "inside worktree")
        : warning("git", "not a git worktree"),
    )
  } catch (error) {
    checks.push(warning("git", `git unavailable: ${error instanceof Error ? error.message : String(error)}`))
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function renderConfigJson(config: EffectiveConfig): Record<string, unknown> {
  return {
    cwd: config.cwd,
    dataRoot: config.dataRoot,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    apiKeyPresent: config.apiKeyPresent,
    permissionMode: config.permissionMode,
    osSandbox: config.osSandbox,
    sandboxSettings: config.sandboxSettings,
    sandboxAllowDomains: config.sandboxAllowDomains,
    sandboxAllowWrites: config.sandboxAllowWrites,
    transcript: config.transcript,
    maxSteps: config.maxSteps,
    maxContextTokens: config.maxContextTokens,
    compactThreshold: config.compactThreshold,
    mcpConfig: config.mcpConfig,
    skillDirs: config.skillDirs,
    fake: config.fake,
    verbose: config.verbose,
    configFiles: config.configFiles,
  }
}

async function checkMcp(config: EffectiveConfig, checks: Check[]): Promise<void> {
  if (!config.mcpConfig.value) {
    checks.push(ready("mcp", "no MCP config configured"))
    return
  }
  try {
    const servers = await loadMcpConfig(config.mcpConfig.value)
    checks.push(ready("mcp", `${servers.length} server config(s) parse`))
  } catch (error) {
    checks.push(blocked("mcp", error instanceof Error ? error.message : String(error)))
  }
}

async function checkSkills(config: EffectiveConfig, checks: Check[]): Promise<void> {
  if (config.skillDirs.value.length === 0) {
    checks.push(ready("skills", "no skills configured"))
    return
  }
  for (const path of config.skillDirs.value) {
    try {
      await access(join(path, "SKILL.md"))
      checks.push(ready("skill", path))
    } catch (error) {
      checks.push(blocked("skill", `${path}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
}

function checkToolRegistry(checks: Check[]): void {
  try {
    const registry = createBuiltinToolRegistry({ todoState: new TodoState() })
    checks.push(ready("toolRegistry", `${registry.list().length} builtin tools`))
  } catch (error) {
    checks.push(blocked("toolRegistry", error instanceof Error ? error.message : String(error)))
  }
}

function ready(name: string, message: string): Check {
  return { status: "ready", name, message }
}

function warning(name: string, message: string): Check {
  return { status: "warning", name, message }
}

function blocked(name: string, message: string): Check {
  return { status: "blocked", name, message }
}
