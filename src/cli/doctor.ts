import { spawn } from "node:child_process"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
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

type Check = {
  status: "ready" | "warning" | "blocked"
  name: string
  message: string
}

export async function runDoctor(config: EffectiveConfig, store: SessionStore): Promise<DoctorResult> {
  const checks: Check[] = []
  checks.push(...providerChecks(config))
  await checkCwd(config, checks)
  await checkStore(store, checks)
  await checkExecutable("rg", ["--version"], "ripgrep", checks)
  await checkGit(config.cwd.value, checks)
  checks.push({ status: "ready", name: "permission", message: `mode ${config.permissionMode.value}` })
  await checkMcp(config, checks)
  await checkSkills(config, checks)
  checkToolRegistry(checks)

  const blocked = checks.some((check) => check.status === "blocked")
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
