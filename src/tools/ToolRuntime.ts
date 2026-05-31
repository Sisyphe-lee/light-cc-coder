import { AbortTurnError, TranscriptWriteError, abortReason, throwIfAborted } from "../core/errors"
import type { SessionEventDraft } from "../core/events"
import type { ToolCall, ToolResultMessage } from "../core/messages"
import { PermissionPolicy } from "../permissions/policy"
import type { ApprovalRequester, PermissionMode } from "../permissions/types"
import { RuntimeExecutionError, type Runtime } from "../runtime/types"
import { SandboxPolicy } from "../sandbox/policy"
import type { ToolArtifactStore } from "../context/toolArtifacts"
import { WorkspaceFs, type WorkspaceRead } from "../workspace/WorkspaceFs"
import type { ResolvedWorkspacePath } from "../workspace/pathBoundary"
import { coerceToolError, toolErrorResult, toolSuccessResult, truncateText, ToolExecutionError } from "./result"
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
}

export interface ToolRuntime {
  runBatch(calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]>
}

export type RealToolRuntimeOptions = {
  registry: ToolRegistry
  workspace: WorkspaceFs
  runtime?: Runtime
  permissionMode?: PermissionMode
  maxResultBytes?: number
  makeResultId?: () => string
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

  constructor(options: RealToolRuntimeOptions) {
    this.registry = options.registry
    this.workspace = options.workspace
    this.runtime = options.runtime
    this.permissionMode = options.permissionMode ?? "workspace-write"
    this.permissionPolicy = new PermissionPolicy(this.permissionMode)
    this.maxResultBytes = options.maxResultBytes ?? 96 * 1024
    this.makeResultId = options.makeResultId
  }

  getToolSchemas(): unknown[] {
    return this.registry.toOpenAiTools()
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
        if (observation.preserveErrorContent) {
          return {
            id: this.resultId(),
            role: "tool",
            toolCallId: item.call.id,
            toolName: item.call.name,
            content,
            isError: true,
          }
        }
        return this.errorResult(item.call, "internal_error", content)
      }
      return toolSuccessResult({ id: this.resultId(), call: item.call, content })
    } catch (error) {
      if (error instanceof AbortTurnError || ctx.signal.aborted) {
        return this.errorResult(item.call, "aborted", `Tool call aborted: ${abortReason(ctx.signal)}`)
      }
      if (error instanceof TranscriptWriteError) {
        throw error
      }
      if (error instanceof RuntimeExecutionError) {
        return this.errorResult(item.call, error.kind, error.message, error.subject)
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
