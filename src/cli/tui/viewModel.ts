import type { SessionEvent } from "../../core/events"
import type { TokenUsage } from "../../core/messages"
import type { PermissionMode } from "../../permissions/types"
import type { TodoItem } from "../../tools/builtins/todo"
import { sanitizeDisplayText } from "./width"

// Pure reducer turning the session event stream into renderable TUI state. No
// I/O and no terminal concerns live here, so it is fully unit-testable: feed a
// sequence of events, assert on the resulting view model.

export type ToolCardStatus = "running" | "ok" | "error"

export type TranscriptItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; stepId: string; text: string }
  | {
      kind: "tool"
      key: string
      toolCallId: string
      name: string
      inputSummary: string
      status: ToolCardStatus
      resultPreview: string
      startedAtMs?: number
      durationMs?: number
    }
  | { kind: "notice"; key: string; level: "info" | "warn" | "error"; text: string }
  | { kind: "summary"; key: string; text: string } // dim end-of-turn stats line

export type TurnState = "idle" | "thinking" | "running" | "awaiting-approval" | "error"

export type CumulativeUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export type PendingApproval = {
  approvalId: string
  toolName: string
  subject: string
  reason?: string
  inputSummary?: string
  accessSummary?: string
  riskSummary?: string
}

export type TuiViewModel = {
  model: string
  permissionMode: PermissionMode | string
  maxContextTokens?: number
  compactAtTokens?: number // auto-compact trigger, in tokens (engine hardCompactTokens)
  sessionId?: string
  cwd?: string
  contextTokens?: number
  turnState: TurnState
  activeLabel?: string
  steps: number
  usage: CumulativeUsage
  items: TranscriptItem[]
  todos: TodoItem[]
  pendingApproval?: PendingApproval
  lastError?: string
  // Snapshot taken at turn.started so turn.ended can emit a per-turn summary.
  turnStartedAtMs?: number
  turnStartSteps?: number
  turnStartInputTokens?: number
  turnStartOutputTokens?: number
}

export type ViewModelInit = {
  model: string
  permissionMode: PermissionMode | string
  maxContextTokens?: number
  compactAtTokens?: number
  sessionId?: string
  cwd?: string
}

export function initialViewModel(init: ViewModelInit): TuiViewModel {
  return {
    model: init.model,
    permissionMode: init.permissionMode,
    maxContextTokens: init.maxContextTokens,
    compactAtTokens: init.compactAtTokens,
    sessionId: init.sessionId,
    cwd: init.cwd,
    turnState: "idle",
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
    items: [],
    todos: [],
  }
}

export function reduceViewModel(state: TuiViewModel, event: SessionEvent): TuiViewModel {
  switch (event.type) {
    case "user.message":
      return { ...state, items: push(state.items, { kind: "user", key: `u-${event.seq}`, text: sanitizeDisplayText(event.message.content) }) }
    case "turn.started":
      return {
        ...state,
        turnState: "thinking",
        activeLabel: undefined,
        lastError: undefined,
        turnStartedAtMs: parseTimestamp(event.timestamp),
        turnStartSteps: state.steps,
        turnStartInputTokens: state.usage.inputTokens,
        turnStartOutputTokens: state.usage.outputTokens,
      }
    case "step.started":
      return { ...state, turnState: "thinking", steps: state.steps + 1 }
    case "assistant.delta":
      return { ...state, items: appendAssistant(state.items, event.stepId, event.text, event.seq), turnState: "thinking" }
    case "assistant.message": {
      const usage = addUsage(state.usage, event.message.usage)
      const hasStreamed = state.items.some((it) => it.kind === "assistant" && it.stepId === event.stepId)
      if (hasStreamed || event.message.content.trim().length === 0) return { ...state, usage }
      return {
        ...state,
        usage,
        items: push(state.items, { kind: "assistant", key: `a-${event.seq}`, stepId: event.stepId, text: sanitizeDisplayText(event.message.content) }),
      }
    }
    case "tool.call":
      return {
        ...state,
        turnState: "running",
        activeLabel: event.call.name,
        items: push(state.items, {
          kind: "tool",
          key: `t-${event.call.id}`,
          toolCallId: event.call.id,
          name: event.call.name,
          inputSummary: summarizeToolInput(event.call.name, event.call.input),
          status: "running",
          resultPreview: "",
          startedAtMs: parseTimestamp(event.timestamp),
        }),
      }
    case "tool.result": {
      const endedAtMs = parseTimestamp(event.timestamp)
      const items = state.items.map((it): TranscriptItem =>
        it.kind === "tool" && it.toolCallId === event.result.toolCallId
          ? {
              ...it,
              status: event.result.isError ? "error" : "ok",
              resultPreview: previewText(event.result.content),
              durationMs: it.startedAtMs != null && endedAtMs != null ? Math.max(0, endedAtMs - it.startedAtMs) : undefined,
            }
          : it,
      )
      return { ...state, items, turnState: "thinking", activeLabel: undefined }
    }
    case "approval.requested":
      return {
        ...state,
        turnState: "awaiting-approval",
        pendingApproval: {
          approvalId: event.approvalId,
          toolName: event.toolName,
          subject: event.subject,
          reason: event.toolReason ?? event.reason,
          inputSummary: event.inputSummary,
          accessSummary: event.accessSummary,
          riskSummary: event.riskSummary,
        },
      }
    case "approval.responded":
      return { ...state, pendingApproval: undefined, turnState: "thinking" }
    case "command.output":
      return { ...state, items: push(state.items, { kind: "notice", key: `c-${event.seq}`, level: "info", text: sanitizeDisplayText(event.content.trimEnd()) }) }
    case "todo.updated":
      return { ...state, todos: event.items }
    case "context.step":
      return { ...state, contextTokens: event.snapshot.estimatedTokens ?? state.contextTokens }
    case "sandbox.status": {
      if (event.requestedMode !== "auto" || event.active) return state
      const reason = event.fallbackReason ? ` (${event.fallbackReason})` : ""
      return {
        ...state,
        items: push(state.items, { kind: "notice", key: `s-${event.seq}`, level: "warn", text: `OS sandbox fallback: shell runs unsandboxed${reason}.` }),
      }
    }
    case "compact.started":
      return { ...state, items: push(state.items, { kind: "notice", key: `k-${event.seq}`, level: "info", text: `Compacting context (${event.trigger})…` }) }
    case "compact.ended":
      return {
        ...state,
        items: push(
          state.items,
          event.status === "succeeded"
            ? { kind: "notice", key: `k-${event.seq}`, level: "info", text: `Compacted: ${event.summarizedMessageCount} summarized, ${event.keptMessageCount} kept.` }
            : { kind: "notice", key: `k-${event.seq}`, level: "error", text: `Compact failed: ${event.error}` },
        ),
      }
    case "error":
      return {
        ...state,
        lastError: event.error,
        turnState: event.recoverable ? state.turnState : "error",
        items: push(state.items, { kind: "notice", key: `e-${event.seq}`, level: event.recoverable ? "warn" : "error", text: event.error }),
      }
    case "turn.ended": {
      let next: TuiViewModel = {
        ...state,
        turnState: event.reason === "error" ? "error" : "idle",
        activeLabel: undefined,
        turnStartedAtMs: undefined,
      }
      const summary = turnSummaryText(state, event.reason, parseTimestamp(event.timestamp))
      if (summary) next = { ...next, items: push(next.items, { kind: "summary", key: `ts-${event.seq}`, text: summary }) }
      if (event.reason === "max_steps") {
        next = {
          ...next,
          items: push(next.items, {
            kind: "notice",
            key: `ms-${event.seq}`,
            level: "warn",
            text: "Step limit reached mid-task. Send a follow-up to continue, or raise maxSteps (--max-steps, LIGHT_CC_MAX_STEPS, or config).",
          }),
        }
      }
      return next
    }
    default:
      return state
  }
}

// One dim stats line per finished turn, e.g. "done · 14s · 3 steps · ↑12.3k ↓1.1k".
// Errors are skipped: the error event already appended its own notice.
function turnSummaryText(state: TuiViewModel, reason: string, endedAtMs?: number): string | undefined {
  if (reason === "error" || state.turnStartedAtMs == null) return undefined
  const label = reason === "completed" ? "done" : reason === "aborted" ? "aborted" : reason === "max_steps" ? "max steps" : reason
  const parts = [label]
  if (endedAtMs != null && endedAtMs >= state.turnStartedAtMs) parts.push(formatDuration(endedAtMs - state.turnStartedAtMs))
  const steps = state.steps - (state.turnStartSteps ?? 0)
  if (steps > 0) parts.push(`${steps} step${steps === 1 ? "" : "s"}`)
  const input = state.usage.inputTokens - (state.turnStartInputTokens ?? 0)
  const output = state.usage.outputTokens - (state.turnStartOutputTokens ?? 0)
  if (input > 0 || output > 0) parts.push(`↑${compactTokens(input)} ↓${compactTokens(output)}`)
  return parts.join(" · ")
}

function parseTimestamp(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? ms : undefined
}

function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`
}

function push(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  return [...items, item]
}

function appendAssistant(items: TranscriptItem[], stepId: string, text: string, seq: number): TranscriptItem[] {
  // Sanitizing per delta is safe: the stripped constructs (tabs, C0, complete
  // ANSI sequences) are single-character or arrive intact within one delta in
  // practice; a split ANSI sequence degrades to visible text, never corruption.
  const clean = sanitizeDisplayText(text)
  const last = items[items.length - 1]
  if (last && last.kind === "assistant" && last.stepId === stepId) {
    return [...items.slice(0, -1), { ...last, text: last.text + clean }]
  }
  return [...items, { kind: "assistant", key: `a-${stepId}-${seq}`, stepId, text: clean }]
}

function addUsage(usage: CumulativeUsage, u?: TokenUsage): CumulativeUsage {
  if (!u) return usage
  const input = u.inputTokens ?? 0
  const output = u.outputTokens ?? 0
  return {
    inputTokens: usage.inputTokens + input,
    outputTokens: usage.outputTokens + output,
    totalTokens: usage.totalTokens + (u.totalTokens ?? input + output),
    cacheHitTokens: usage.cacheHitTokens + (u.promptCacheHitTokens ?? 0),
    cacheMissTokens: usage.cacheMissTokens + (u.promptCacheMissTokens ?? 0),
  }
}

function previewText(content: string): string {
  const collapsed = sanitizeDisplayText(content).replace(/\s+/g, " ").trim()
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed
}

export function summarizeToolInput(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return ""
  const obj = input as Record<string, unknown>
  const str = (key: string): string | undefined => (typeof obj[key] === "string" ? (obj[key] as string) : undefined)
  switch (name) {
    case "read": {
      const path = str("path") ?? str("file_path") ?? ""
      return obj.line != null ? `${path}:${String(obj.line)}` : path
    }
    case "edit":
    case "write":
    case "apply_patch":
      return str("path") ?? str("file_path") ?? ""
    case "grep": {
      const pattern = str("pattern") ?? ""
      const path = str("path")
      return path ? `${pattern}  in ${path}` : pattern
    }
    case "glob":
      return str("pattern") ?? ""
    case "bash":
      return oneLine(str("command") ?? "")
    case "todo":
      return str("action") ?? ""
    default:
      return oneLine(safeJson(obj))
  }
}

function oneLine(text: string): string {
  const collapsed = sanitizeDisplayText(text).replace(/\s+/g, " ").trim()
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
