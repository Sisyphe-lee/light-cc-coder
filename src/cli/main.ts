#!/usr/bin/env bun
import { AgentSession } from "../core/AgentSession"
import type { SessionEvent } from "../core/events"
import { makeAssistantMessage } from "../core/messages"
import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import type { McpServerConfig } from "../extensions/mcp"
import { FakeProvider } from "../providers/FakeProvider"
import { OpenAICompatibleProvider } from "../providers/openaiCompatible"
import type { Provider } from "../providers/types"
import { LocalRuntime } from "../runtime/LocalRuntime"
import { RealToolRuntime } from "../tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../tools/builtins"
import { WorkspaceFs } from "../workspace/WorkspaceFs"
import type { PermissionMode } from "../permissions/types"

type CliOptions = {
  prompt?: string
  cwd: string
  model?: string
  baseUrl?: string
  apiKeyEnv: string
  transcript?: string
  maxSteps?: number
  maxContextTokens?: number
  compactThreshold?: number
  permissionMode: PermissionMode
  mcpConfig?: string
  skillDirs: string[]
  fake: boolean
}

async function main(argv: string[]): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  if (!options.prompt) {
    console.error("Usage: light-cc-coder -p \"prompt\" [--cwd path] [--model name] [--base-url url] [--api-key-env NAME]")
    return 2
  }

  const provider = createProvider(options)
  if (!provider) return 2

  let mcpServers: McpServerConfig[]
  try {
    mcpServers = options.mcpConfig ? await loadMcpConfig(options.mcpConfig) : []
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const workspace = await WorkspaceFs.create(options.cwd)
  const localRuntime = await LocalRuntime.create({ workspaceRoot: workspace.root, initialCwd: workspace.root })
  const todoState = new TodoState()
  const session = await AgentSession.create({
    cwd: workspace.root,
    provider,
    toolRuntime: new RealToolRuntime({
      registry: createBuiltinToolRegistry({ todoState }),
      workspace,
      runtime: localRuntime,
      permissionMode: options.permissionMode,
    }),
    transcript: options.transcript,
    maxSteps: options.maxSteps,
    maxContextTokens: options.maxContextTokens,
    contextBudget: options.compactThreshold ? { hardCompactTokens: options.compactThreshold } : undefined,
    mcpServers,
    skillDirs: options.skillDirs,
    enabledSkills: options.skillDirs.map((path) => basename(resolve(path))),
    todoState,
  })

  const consume = consumeEvents(session)
  try {
    await session.submit({ type: "user_message", content: options.prompt })
    await session.close()
    await consume
    return 0
  } catch (error) {
    await session.close().catch(() => undefined)
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function createProvider(options: CliOptions): Provider | undefined {
  if (options.fake) {
    return new FakeProvider({ steps: [{ message: makeAssistantMessage({ id: "fake_assistant", content: "ok" }) }] })
  }
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL
  const model = options.model ?? process.env.OPENAI_MODEL
  const apiKey = process.env[options.apiKeyEnv]
  if (!baseUrl || !model || !apiKey) {
    console.error(`Missing provider config: require OPENAI_BASE_URL, OPENAI_MODEL, and ${options.apiKeyEnv}`)
    return undefined
  }
  return new OpenAICompatibleProvider({ baseUrl, model, apiKey })
}

async function consumeEvents(session: AgentSession): Promise<void> {
  const deltaSteps = new Set<string>()
  for await (const event of session.events()) {
    if (event.type === "assistant.delta") {
      deltaSteps.add(event.stepId)
      process.stdout.write(event.text)
    }
    if (event.type === "assistant.message" && !deltaSteps.has(event.stepId) && event.message.content) {
      process.stdout.write(event.message.content)
      if (!event.message.content.endsWith("\n")) process.stdout.write("\n")
    }
    if (event.type === "tool.call") {
      process.stderr.write(`tool.call ${event.call.name}\n`)
    }
    if (event.type === "tool.result") {
      process.stderr.write(`tool.result ${event.result.toolName} ${event.result.isError ? "error" : "ok"}\n`)
    }
    if (event.type === "command.output") {
      process.stdout.write(event.content)
      if (!event.content.endsWith("\n")) process.stdout.write("\n")
    }
    if (event.type === "approval.requested") {
      const decision = await promptApproval(event, session.cwd)
      await session.submit({ type: "approval.respond", approvalId: event.approvalId, decision })
    }
  }
}

async function promptApproval(
  event: Extract<SessionEvent, { type: "approval.requested" }>,
  cwd: string,
): Promise<"allow" | "deny"> {
  process.stderr.write(`approval.requested ${event.toolName}\n`)
  process.stderr.write(`Cwd: ${event.cwd ?? cwd}\n`)
  process.stderr.write(`Permission mode: ${event.permissionMode ?? "unknown"}\n`)
  process.stderr.write(`Subject: ${event.subject}\n`)
  process.stderr.write(`Policy: ${event.policyReason ?? event.reason}\n`)
  if (event.toolDescription) process.stderr.write(`Tool: ${event.toolDescription}\n`)
  if (event.toolReason) process.stderr.write(`Tool reason: ${event.toolReason}\n`)
  if (event.inputSummary) process.stderr.write(`Input: ${event.inputSummary}\n`)
  if (event.accessSummary) process.stderr.write(`Access: ${event.accessSummary}\n`)
  if (event.riskSummary) process.stderr.write(`Risk: ${event.riskSummary}\n`)
  const answer = await readApprovalAnswer()
  return /^(y|yes|allow)$/i.test(answer.trim()) ? "allow" : "deny"
}

async function readApprovalAnswer(): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stderr.write("Allow this tool call? [y/N] ")
    return readPipedLine(100)
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question("Allow this tool call? [y/N] ")
  } finally {
    rl.close()
  }
}

function readPipedLine(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      process.stdin.off("data", onData)
      process.stdin.off("end", finish)
      process.stdin.pause()
      resolve(text.split(/\r?\n/)[0] ?? "")
    }
    const onData = (chunk: Buffer | string) => {
      text += String(chunk)
      if (/\r?\n/.test(text)) finish()
    }
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", onData)
    process.stdin.once("end", finish)
    process.stdin.resume()
    timer = setTimeout(finish, timeoutMs)
  })
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cwd: process.cwd(),
    apiKeyEnv: "OPENAI_API_KEY",
    permissionMode: "workspace-write",
    skillDirs: [],
    fake: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "-p") options.prompt = requireValue(argv, ++index, "-p")
    else if (arg === "--cwd") options.cwd = requireValue(argv, ++index, "--cwd")
    else if (arg === "--model") options.model = requireValue(argv, ++index, "--model")
    else if (arg === "--base-url") options.baseUrl = requireValue(argv, ++index, "--base-url")
    else if (arg === "--api-key-env") options.apiKeyEnv = requireValue(argv, ++index, "--api-key-env")
    else if (arg === "--transcript") options.transcript = requireValue(argv, ++index, "--transcript")
    else if (arg === "--max-steps") options.maxSteps = Number.parseInt(requireValue(argv, ++index, "--max-steps"), 10)
    else if (arg === "--max-context-tokens")
      options.maxContextTokens = Number.parseInt(requireValue(argv, ++index, "--max-context-tokens"), 10)
    else if (arg === "--compact-threshold")
      options.compactThreshold = Number.parseInt(requireValue(argv, ++index, "--compact-threshold"), 10)
    else if (arg === "--permission-mode") options.permissionMode = parsePermissionMode(requireValue(argv, ++index, "--permission-mode"))
    else if (arg === "--mcp-config") options.mcpConfig = requireValue(argv, ++index, "--mcp-config")
    else if (arg === "--skill") options.skillDirs.push(requireValue(argv, ++index, "--skill"))
    else if (arg === "--fake") options.fake = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

async function loadMcpConfig(path: string): Promise<McpServerConfig[]> {
  const content = await readFile(resolve(path), "utf8")
  const parsed = JSON.parse(content) as { mcpServers?: unknown; servers?: unknown } | unknown[]
  const servers = Array.isArray(parsed) ? parsed : (parsed.mcpServers ?? parsed.servers)
  if (!Array.isArray(servers)) {
    throw new Error("--mcp-config must be an array or an object with mcpServers/servers")
  }
  return servers.map((server, index) => {
    const record = server as Record<string, unknown>
    if (!record || typeof record !== "object") throw new Error(`mcpServers[${index}] must be an object`)
    if (typeof record.name !== "string" || typeof record.command !== "string") {
      throw new Error(`mcpServers[${index}] requires name and command`)
    }
    return {
      name: record.name,
      command: record.command,
      args: arrayOfStrings(record.args, `mcpServers[${index}].args`),
      env: stringRecord(record.env, `mcpServers[${index}].env`),
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      startupTimeoutMs: optionalNumber(record.startupTimeoutMs, `mcpServers[${index}].startupTimeoutMs`),
      callTimeoutMs: optionalNumber(record.callTimeoutMs, `mcpServers[${index}].callTimeoutMs`),
    }
  })
}

function arrayOfStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`)
    output[key] = item
  }
  return output
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number`)
  return value
}

function parsePermissionMode(value: string): PermissionMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value
  throw new Error(`Invalid --permission-mode: ${value}`)
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
