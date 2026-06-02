import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { AgentSession, type AgentSessionSlashCommands } from "../core/AgentSession"
import { makeAssistantMessage } from "../core/messages"
import type { McpServerConfig } from "../extensions/mcp"
import { FakeProvider } from "../providers/FakeProvider"
import { OpenAICompatibleProvider } from "../providers/openaiCompatible"
import type { Provider } from "../providers/types"
import type { Runtime } from "../runtime/types"
import { createLocalRuntimeWithOptionalSandbox, getSandboxRuntimeStatus } from "../runtime/sandbox/createRuntime"
import { normalizeOsSandboxConfig } from "../runtime/sandbox/config"
import { RealToolRuntime } from "../tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../tools/builtins"
import { WorkspaceFs } from "../workspace/WorkspaceFs"
import type { EffectiveConfig } from "./config"
import { renderConfigReport } from "./config"
import { renderConversationPreview, SessionStore, type ResumePlan, type SessionPlan } from "./sessionStore"
import { renderWorkspaceDiff } from "./diff"
import { replayTodoState } from "../tools/builtins/todo"

export type SessionFactoryInput = {
  config: EffectiveConfig
  prompt?: string
  resume?: ResumePlan
  store: SessionStore
  plan?: SessionPlan
}

export type CreatedSession = {
  session: AgentSession
  plan: SessionPlan
  store: SessionStore
  localRuntime: Runtime
  resumePreview?: string
}

export async function createSession(input: SessionFactoryInput): Promise<CreatedSession> {
  const providerInfo = createProvider(input.config)
  const workspace = await WorkspaceFs.create(input.config.cwd.value)
  const sandboxConfig = normalizeOsSandboxConfig({
    mode: input.config.osSandbox.value,
    settingsPath: input.config.sandboxSettings.value,
    allowDomains: input.config.sandboxAllowDomains.value,
    allowWrites: input.config.sandboxAllowWrites.value,
  })
  const runtimeResult = await createLocalRuntimeWithOptionalSandbox({
    workspaceRoot: workspace.root,
    initialCwd: workspace.root,
    sandbox: sandboxConfig,
  })
  const localRuntime = runtimeResult.runtime
  const todoState = input.resume ? replayTodoState(input.resume.events) : new TodoState()
  const mcpServers = input.config.mcpConfig.value ? await loadMcpConfig(input.config.mcpConfig.value) : []
  const plan =
    input.resume ??
    input.plan ??
    input.store.planNew({
      transcriptOverride: input.config.transcript.value,
      cwd: workspace.root,
      model: providerInfo.model,
      provider: providerInfo.name,
      permissionMode: input.config.permissionMode.value,
    })
  const slashCommands: AgentSessionSlashCommands = {
    configReport: renderConfigReport(input.config),
    renderSessions: () => input.store.renderSessions(workspace.root),
    renderDiff: () => renderWorkspaceDiff(workspace.root),
  }
  const session = await AgentSession.create({
    id: plan.id,
    cwd: workspace.root,
    provider: providerInfo.provider,
    toolRuntime: new RealToolRuntime({
      registry: createBuiltinToolRegistry({ todoState }),
      workspace,
      runtime: localRuntime,
      permissionMode: input.config.permissionMode.value,
    }),
    transcript: plan.transcriptPath,
    initialMessages: input.resume?.messages,
    idSeed: input.resume?.idSeed,
    maxSteps: input.config.maxSteps.value,
    maxContextTokens: input.config.maxContextTokens.value,
    contextBudget: input.config.compactThreshold.value
      ? { hardCompactTokens: input.config.compactThreshold.value }
      : undefined,
    mcpServers,
    skillDirs: input.config.skillDirs.value,
    enabledSkills: input.config.skillDirs.value.map((path) => basename(resolve(path))),
    todoState,
    slashCommands,
    profile: input.config.profile.value,
    getRuntimeContext: () => {
      const status = getSandboxRuntimeStatus(localRuntime)
      return {
        permissionMode: input.config.permissionMode.value,
        osSandbox: {
          mode: sandboxConfig.mode,
          status: sandboxConfig.mode === "off" ? "off" : (status?.status ?? "not_initialized"),
          fallbackReason: status?.fallbackReason,
          settingsPath: sandboxConfig.settingsPath,
          allowDomains: sandboxConfig.allowDomains,
          allowWrites: sandboxConfig.allowWrites,
        },
      }
    },
  })
  return {
    session,
    plan,
    store: input.store,
    localRuntime,
    resumePreview: input.resume ? renderConversationPreview(input.resume.messages) : undefined,
  }
}

export function createProvider(config: EffectiveConfig): { provider: Provider; name: string; model: string } {
  if (config.fake.value) {
    return {
      provider: new FakeProvider({
        steps: Array.from({ length: 200 }, (_, index) => ({
          message: makeAssistantMessage({ id: `fake_assistant_${index}`, content: "ok" }),
        })),
      }),
      name: "fake",
      model: "fake",
    }
  }
  const baseUrl = config.baseUrl.value
  const model = config.model.value
  const apiKey = process.env[config.apiKeyEnv.value]
  if (!baseUrl || !model || !apiKey) {
    throw new Error(`Missing provider config: require baseUrl, model, and ${config.apiKeyEnv.value}`)
  }
  return {
    provider: new OpenAICompatibleProvider({ baseUrl, model, apiKey, includeUsage: config.profile.value }),
    name: "openai-compatible",
    model,
  }
}

export async function loadMcpConfig(path: string): Promise<McpServerConfig[]> {
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
