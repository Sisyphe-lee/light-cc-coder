import { AbortTurnError, TranscriptWriteError, abortReason, throwIfAborted } from "../core/errors"
import type { SessionEventDraft } from "../core/events"
import type { ToolCall, ToolResultMessage } from "../core/messages"
import { PermissionPolicy } from "../permissions/policy"
import type { ApprovalRequester, PermissionMode } from "../permissions/types"
import { RuntimeExecutionError, type Runtime } from "../runtime/types"
import { drainSandboxRuntimeDiagnostics } from "../runtime/sandbox/createRuntime"
import { SandboxPolicy } from "../sandbox/policy"
import type { ToolArtifactStore } from "../context/toolArtifacts"
import { WorkspaceFs, type WorkspaceRead } from "../workspace/WorkspaceFs"
import type { ResolvedWorkspacePath } from "../workspace/pathBoundary"
import { runPostToolHooks, runPreToolHooks, type SessionHooks } from "../extensions/hooks"
import type { TodoState } from "./builtins/todo"
import {
  attachPostResultDiagnostics,
  coerceToolError,
  toolErrorResult,
  toolSuccessResult,
  truncateText,
  ToolExecutionError,
} from "./result"
import type { ToolAccesses, ToolDefinition, ToolExecutionContext, ToolRegistry } from "./registry"

export type ToolContext = {
  sessionId: string
  turnId: string
  stepId: string
  toolCallId?: string
  toolName?: string
  signal: AbortSignal
  approvals?: ApprovalRequester
  emit?: (event: SessionEventDraft) => Promise<void>
  artifacts?: ToolArtifactStore
  hooks?: SessionHooks
}

export interface ToolRuntime {
  runBatch(calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]>
  getToolSchemas?(): unknown[]
  listTools?(): ToolRuntimeToolInfo[]
  registerTool?(tool: ToolDefinition): void
  getPermissionMode?(): PermissionMode
  getTodoState?(): TodoState | undefined
  close?(): Promise<void> | void
}

export type ToolRuntimeToolInfo = {
  name: string
  description: string
  readOnly: boolean
}

export type RealToolRuntimeOptions = {
  registry: ToolRegistry
  workspace: WorkspaceFs
  runtime?: Runtime
  permissionMode?: PermissionMode
  maxResultBytes?: number
  makeResultId?: () => string
  hooks?: SessionHooks
}

type Preflight =
  | {
      call: ToolCall
      tool: ToolDefinition
      input: unknown
      accesses?: ToolAccesses
      readOnly: boolean
    }
  | {
      call: ToolCall
      result: ToolResultMessage
      readOnly: false
    }

export class RealToolRuntime implements ToolRuntime {
  private nextResult = 0
  private readonly registry: ToolRegistry
  private readonly workspace: WorkspaceFs
  private readonly runtime?: Runtime
  private readonly permissionMode: PermissionMode
  private readonly permissionPolicy: PermissionPolicy
  private readonly sandboxPolicy = new SandboxPolicy()
  private readonly maxResultBytes: number
  private readonly makeResultId?: () => string
  private readonly hooks?: SessionHooks

  constructor(options: RealToolRuntimeOptions) {
    this.registry = options.registry
    this.workspace = options.workspace
    this.runtime = options.runtime
    this.permissionMode = options.permissionMode ?? "workspace-write"
    this.permissionPolicy = new PermissionPolicy(this.permissionMode)
    this.maxResultBytes = options.maxResultBytes ?? 96 * 1024
    this.makeResultId = options.makeResultId
    this.hooks = options.hooks
  }

  getToolSchemas(): unknown[] {
    return this.registry.toOpenAiTools()
  }

  listTools(): ToolRuntimeToolInfo[] {
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
    }))
  }

  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool)
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode
  }

  getTodoState(): TodoState | undefined {
    const todo = this.registry.get("todo") as (ToolDefinition & { todoState?: TodoState }) | undefined
    return todo?.todoState
  }

  async close(): Promise<void> {
    await this.runtime?.close?.()
  }

  async runBatch(calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]> {
    const preflights = calls.map((call) => this.preflight(call))
    const allValidReadOnly = preflights.every((item) => "tool" in item && item.readOnly)
    if (allValidReadOnly) {
      const results = await Promise.all(preflights.map((item) => this.executePreflight(item, ctx)))
      return results
    }

    const results: ToolResultMessage[] = []
    for (const item of preflights) {
      results.push(await this.executePreflight(item, ctx))
    }
    return results
  }

  private preflight(call: ToolCall): Preflight {
    const tool = this.registry.get(call.name)
    if (!tool) {
      return {
        call,
        readOnly: false,
        result: this.errorResult(call, "unknown_tool", `Unknown tool: ${call.name}`),
      }
    }

    try {
      if (isInvalidToolInput(call.input)) {
        throw new ToolExecutionError("invalid_input", `Malformed JSON arguments: ${call.input.error}`)
      }
      const input = tool.parse(call.input, call)
      const accesses = tool.accesses?.(input)
      return { call, tool, input, accesses, readOnly: tool.readOnly }
    } catch (error) {
      const coerced = coerceToolError(error)
      return {
        call,
        readOnly: false,
        result: this.errorResult(call, coerced.code, coerced.message, coerced.subject),
      }
    }
  }

  private async executePreflight(item: Preflight, ctx: ToolContext): Promise<ToolResultMessage> {
    if ("result" in item) return item.result
    if (ctx.signal.aborted) {
      return this.errorResult(item.call, "aborted", `Tool call aborted: ${abortReason(ctx.signal)}`)
    }

    try {
      const decision = this.permissionPolicy.decide({
        toolName: item.tool.name,
        input: item.input,
        readOnly: item.tool.readOnly,
        accesses: item.accesses,
      })
      await ctx.emit?.({
        type: "permission.decision",
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        toolCallId: item.call.id,
        toolName: item.tool.name,
        mode: this.permissionMode,
        decision: decision.kind,
        subject: decision.subject,
        reason: decision.reason,
      })
      if (decision.kind === "deny") {
        return this.errorResult(item.call, decision.code ?? "permission_denied", decision.reason, decision.subject)
      }
      if (decision.kind === "ask") {
        if (!ctx.approvals) {
          return this.errorResult(
            item.call,
            "permission_denied",
            "Approval required but no approval responder is available",
            decision.subject,
          )
        }
        const approval = await ctx.approvals.request(
          {
            turnId: ctx.turnId,
            stepId: ctx.stepId,
            toolCallId: item.call.id,
            toolName: item.tool.name,
            subject: decision.subject,
            reason: decision.reason,
            cwd: this.runtime?.getCwd() ?? this.workspace.root,
            permissionMode: this.permissionMode,
            toolDescription: item.tool.description,
            policyReason: decision.reason,
            toolReason: toolReason(item.input),
            inputSummary: summarizeInput(item.input),
            accessSummary: summarizeAccesses(item.accesses),
            riskSummary: summarizeRisk(item.tool.name, item.tool.readOnly, item.accesses),
          },
          ctx.signal,
        )
        throwIfAborted(ctx.signal)
        if (approval !== "allow") {
          return this.errorResult(item.call, "permission_denied", "User denied approval", decision.subject)
        }
      }

      if (item.tool.name !== "bash") {
        await this.sandboxPolicy.checkFileAccesses(item.accesses, this.workspace)
      }

      const preHook = await runPreToolHooks({
        hooks: ctx.hooks ?? this.hooks,
        emit: ctx.emit,
        input: {
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          stepId: ctx.stepId,
          toolCall: item.call,
          input: item.input,
          signal: ctx.signal,
        },
      })
      if (preHook.status === "blocked") {
        return this.errorResult(item.call, "hook_blocked", `Pre-tool hook blocked execution: ${preHook.reason}`)
      }

      const executionContext: ToolExecutionContext = {
        ...ctx,
        toolCallId: item.call.id,
        toolName: item.tool.name,
        workspace: new AbortAwareWorkspaceFs(this.workspace, ctx.signal),
        runtime: this.runtime,
      }
      const observation = await item.tool.execute(item.input, executionContext)
      throwIfAborted(ctx.signal)
      const content = await this.normalizeContent(item.call, observation.content, ctx)
      if (observation.isError) {
        const result = observation.preserveErrorContent
          ? {
              id: this.resultId(),
              role: "tool" as const,
              toolCallId: item.call.id,
              toolName: item.call.name,
              content,
              isError: true,
            }
          : this.errorResult(item.call, "internal_error", content)
        attachPostResultDiagnostics(result, observation.postResultDiagnostics)
        await runPostToolHooks({
          hooks: ctx.hooks ?? this.hooks,
          emit: ctx.emit,
          input: {
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            stepId: ctx.stepId,
            toolCall: item.call,
            result,
            signal: ctx.signal,
          },
        })
        return result
      }
      const result = toolSuccessResult({ id: this.resultId(), call: item.call, content })
      attachPostResultDiagnostics(result, observation.postResultDiagnostics)
      await runPostToolHooks({
        hooks: ctx.hooks ?? this.hooks,
        emit: ctx.emit,
        input: {
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          stepId: ctx.stepId,
          toolCall: item.call,
          result,
          signal: ctx.signal,
        },
      })
      return result
    } catch (error) {
      if (error instanceof AbortTurnError || ctx.signal.aborted) {
        return this.errorResult(item.call, "aborted", `Tool call aborted: ${abortReason(ctx.signal)}`)
      }
      if (error instanceof TranscriptWriteError) {
        throw error
      }
      if (error instanceof RuntimeExecutionError) {
        const result = this.errorResult(item.call, error.kind, error.message, error.subject)
        attachPostResultDiagnostics(result, this.runtime ? drainSandboxRuntimeDiagnostics(this.runtime) : undefined)
        return result
      }
      const coerced = coerceToolError(error)
      return this.errorResult(item.call, coerced.code, coerced.message, coerced.subject)
    }
  }

  private errorResult(
    call: ToolCall,
    code: Parameters<typeof toolErrorResult>[0]["code"],
    message: string,
    subject?: string,
  ): ToolResultMessage {
    return toolErrorResult({ id: this.resultId(), call, code, message, subject })
  }

  private resultId(): string {
    if (this.makeResultId) return this.makeResultId()
    this.nextResult += 1
    return `tool_result_${this.nextResult}`
  }

  private async normalizeContent(call: ToolCall, content: string, ctx: ToolContext): Promise<string> {
    if (!ctx.artifacts?.shouldPersist(content)) {
      return truncateText(content, this.maxResultBytes)
    }
    try {
      const artifact = await ctx.artifacts.persist({
        call,
        content,
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        emit: ctx.emit,
      })
      return truncateText(artifact.content, this.maxResultBytes)
    } catch (error) {
      if (error instanceof TranscriptWriteError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ToolExecutionError("internal_error", `Tool artifact persistence failed: ${message}`)
    }
  }
}

class AbortAwareWorkspaceFs extends WorkspaceFs {
  constructor(
    private readonly delegate: WorkspaceFs,
    private readonly signal: AbortSignal,
  ) {
    super(delegate.boundary, delegate.maxReadBytes)
  }

  override async resolveForRead(path: string): Promise<ResolvedWorkspacePath> {
    throwIfAborted(this.signal)
    const result = await this.delegate.resolveForRead(path)
    throwIfAborted(this.signal)
    return result
  }

  override async resolveForWrite(path: string): Promise<ResolvedWorkspacePath> {
    throwIfAborted(this.signal)
    const result = await this.delegate.resolveForWrite(path)
    throwIfAborted(this.signal)
    return result
  }

  override async resolveSearchRoot(path?: string): Promise<ResolvedWorkspacePath> {
    throwIfAborted(this.signal)
    const result = await this.delegate.resolveSearchRoot(path)
    throwIfAborted(this.signal)
    return result
  }

  override async exists(path: string): Promise<boolean> {
    throwIfAborted(this.signal)
    const result = await this.delegate.exists(path)
    throwIfAborted(this.signal)
    return result
  }

  override async readTextFile(path: string, maxBytes?: number): Promise<WorkspaceRead> {
    throwIfAborted(this.signal)
    const result = await this.delegate.readTextFile(path, maxBytes)
    throwIfAborted(this.signal)
    return result
  }

  override async writeTextFile(path: string, content: string): Promise<ResolvedWorkspacePath> {
    throwIfAborted(this.signal)
    const result = await this.delegate.writeTextFile(path, content)
    throwIfAborted(this.signal)
    return result
  }
}

export const invalidToolInputMarker = "__lightCcCoderInvalidToolInput"

export type InvalidToolInput = {
  [invalidToolInputMarker]: true
  raw: string
  error: string
}

export function invalidToolInput(raw: string, error: string): InvalidToolInput {
  return { [invalidToolInputMarker]: true, raw, error }
}

export function isInvalidToolInput(input: unknown): input is InvalidToolInput {
  return (
    typeof input === "object" &&
    input !== null &&
    invalidToolInputMarker in input &&
    (input as Record<string, unknown>)[invalidToolInputMarker] === true
  )
}

function toolReason(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ["description", "reason"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return truncateForDisplay(value.trim(), 240)
  }
  return undefined
}

function summarizeInput(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input)
  } catch {
    text = String(input)
  }
  return truncateForDisplay(text, 500)
}

function summarizeAccesses(accesses: ToolAccesses | undefined): string {
  if (!accesses) return "No declared workspace accesses."
  const parts = [
    summarizeList("reads", accesses.reads),
    summarizeList("writes", accesses.writes),
    summarizeList("searches", accesses.searches),
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join("; ") : "No declared workspace accesses."
}

function summarizeList(label: string, values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined
  const visible = values.slice(0, 4)
  const suffix = values.length > visible.length ? `, +${values.length - visible.length} more` : ""
  return `${label}: ${visible.map((value) => truncateForDisplay(value, 120)).join(", ")}${suffix}`
}

function summarizeRisk(toolName: string, readOnly: boolean, accesses: ToolAccesses | undefined): string {
  if (toolName === "bash") {
    return "Shell command can execute arbitrary programs in the workspace; review the command, cwd, and stated reason."
  }
  if (toolName.startsWith("mcp__") && !readOnly) {
    return "Opaque MCP tool may perform side effects through its server; review the input and server/tool name."
  }
  if ((accesses?.writes?.length ?? 0) > 0 || !readOnly) {
    return "Tool may modify workspace state; review declared writes and input summary."
  }
  return "Read-only tool; risk is limited to information exposure through tool output."
}

function truncateForDisplay(text: string, maxBytes: number): string {
  return truncateText(text, maxBytes)
}
