import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "./messages"
import type { ContextSessionSnapshot, ContextSnapshot } from "../engine/contextTypes"
import type { CompactTrigger } from "../context/compaction"
import type { HookName, HookStatus } from "../extensions/hooks"
import type { TodoItem } from "../tools/builtins/todo"

export type StepEndReason =
  | "assistant_message"
  | "tool_results"
  | "max_steps"
  | "aborted"
  | "error"

export type TurnEndReason = "completed" | "max_steps" | "aborted" | "error"

export type EventBase = {
  seq: number
  timestamp: string
  sessionId: string
  turnId?: string
  stepId?: string
}

export type SessionEvent =
  | (EventBase & { type: "session.started"; cwd: string })
  | (EventBase & { type: "context.session"; snapshot: ContextSessionSnapshot })
  | (EventBase & { type: "mcp.server.started"; serverName: string; configHash: string })
  | (EventBase & {
      type: "mcp.server.ready"
      serverName: string
      toolCount: number
      configHash: string
      stderr?: string
    })
  | (EventBase & {
      type: "mcp.server.failed"
      serverName: string
      configHash: string
      error: string
      stderr?: string
    })
  | (EventBase & { type: "mcp.server.stopped"; serverName: string })
  | (EventBase & { type: "skill.activated"; name: string; path: string; hash: string; bytes: number; truncated: boolean })
  | (EventBase & { type: "command.invoked"; command: string; args: string })
  | (EventBase & { type: "command.output"; command: string; content: string; hostAction?: "clear" })
  | (EventBase & {
      type: "hook.started"
      hook: HookName
      hookIndex: number
      toolCallId?: string
      toolName?: string
    })
  | (EventBase & {
      type: "hook.ended"
      hook: HookName
      toolCallId?: string
      toolName?: string
      status: HookStatus
      message?: string
    })
  | (EventBase & { type: "todo.updated"; turnId: string; stepId: string; toolCallId?: string; items: TodoItem[] })
  | (EventBase & { type: "turn.started"; turnId: string })
  | (EventBase & { type: "user.message"; turnId: string; message: UserMessage })
  | (EventBase & { type: "step.started"; turnId: string; stepId: string })
  | (EventBase & { type: "context.step"; turnId: string; stepId: string; snapshot: ContextSnapshot })
  | (EventBase & { type: "assistant.delta"; turnId: string; stepId: string; text: string })
  | (EventBase & { type: "assistant.message"; turnId: string; stepId: string; message: AssistantMessage })
  | (EventBase & { type: "tool.call"; turnId: string; stepId: string; call: ToolCall })
  | (EventBase & {
      type: "permission.decision"
      turnId: string
      stepId: string
      toolCallId: string
      toolName: string
      mode: string
      decision: "allow" | "ask" | "deny"
      subject: string
      reason: string
    })
  | (EventBase & {
      type: "approval.requested"
      turnId: string
      stepId: string
      approvalId: string
      toolCallId: string
      toolName: string
      subject: string
      reason: string
    })
  | (EventBase & { type: "approval.responded"; approvalId: string; decision: "allow" | "deny" })
  | (EventBase & {
      type: "bash.observation"
      turnId: string
      stepId: string
      toolCallId: string
      command: string
      cwd: string
      finalCwd?: string
      exitCode: number | null
      signal: string | null
      timedOut: boolean
      durationMs: number
      stdoutBytes: number
      stderrBytes: number
      stdoutTruncated: boolean
      stderrTruncated: boolean
    })
  | (EventBase & {
      type: "tool.artifact"
      turnId: string
      stepId: string
      toolCallId: string
      toolName: string
      artifactId: string
      path: string
      originalBytes: number
      previewBytes: number
      sha256: string
    })
  | (EventBase & { type: "tool.result"; turnId: string; stepId: string; result: ToolResultMessage })
  | (EventBase & {
      type: "compact.started"
      compactId: string
      trigger: CompactTrigger
      preCompactMessageCount: number
      estimatedTokens: number
    })
  | (EventBase & {
      type: "compact.ended"
      compactId: string
      trigger: CompactTrigger
      status: "succeeded"
      summaryMessage: UserMessage
      summaryHash: string
      tailStartMessageId?: string
      summarizedMessageCount: number
      keptMessageCount: number
      preCompactEstimatedTokens: number
      postCompactEstimatedTokens: number
      omittedOldestGroups: number
    })
  | (EventBase & {
      type: "compact.ended"
      compactId: string
      trigger: CompactTrigger
      status: "failed"
      error: string
      preCompactEstimatedTokens: number
    })
  | (EventBase & { type: "step.ended"; turnId: string; stepId: string; reason: StepEndReason })
  | (EventBase & { type: "turn.ended"; turnId: string; reason: TurnEndReason })
  | (EventBase & { type: "error"; turnId?: string; stepId?: string; error: string; recoverable: boolean })

export type SessionEventDraft = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, "seq" | "timestamp" | "sessionId">
    : never
  : never
