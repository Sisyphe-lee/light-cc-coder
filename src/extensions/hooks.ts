import type { SessionEventDraft } from "../core/events"
import type { ToolCall, ToolResultMessage } from "../core/messages"

export type HookName = "user_prompt_submit" | "pre_tool" | "post_tool" | "stop"

export type HookStatus = "completed" | "blocked" | "failed" | "timeout"

export type UserPromptSubmitHookInput = {
  sessionId: string
  cwd: string
  prompt: string
  signal: AbortSignal
}

export type UserPromptSubmitHookResult =
  | void
  | { type?: "continue"; appendContext?: string }
  | { type: "block"; reason: string }

export type PreToolHookInput = {
  sessionId: string
  turnId: string
  stepId: string
  toolCall: ToolCall
  input: unknown
  signal: AbortSignal
}

export type PreToolHookResult = void | { type?: "continue" } | { type: "block"; reason: string }

export type PostToolHookInput = {
  sessionId: string
  turnId: string
  stepId: string
  toolCall: ToolCall
  result: ToolResultMessage
  signal: AbortSignal
}

export type StopHookInput = {
  sessionId: string
  turnId: string
  reason: string
  signal: AbortSignal
}

export type SessionHooks = {
  user_prompt_submit?: UserPromptSubmitHook[]
  userPromptSubmit?: UserPromptSubmitHook[]
  pre_tool?: PreToolHook[]
  preTool?: PreToolHook[]
  post_tool?: PostToolHook[]
  postTool?: PostToolHook[]
  stop?: StopHook[]
  timeoutMs?: number
  maxExtraContextBytes?: number
  maxDiagnosticBytes?: number
}

export type UserPromptSubmitHook = (
  input: UserPromptSubmitHookInput,
) => UserPromptSubmitHookResult | Promise<UserPromptSubmitHookResult>
export type PreToolHook = (input: PreToolHookInput) => PreToolHookResult | Promise<PreToolHookResult>
export type PostToolHook = (input: PostToolHookInput) => void | Promise<void>
export type StopHook = (input: StopHookInput) => void | Promise<void>

export type HookEmit = (event: SessionEventDraft) => Promise<void>

export type HookRunOptions = {
  emit?: HookEmit
  hooks?: SessionHooks
}

export async function runUserPromptSubmitHooks(
  options: HookRunOptions & { input: UserPromptSubmitHookInput },
): Promise<{ status: "continue"; prompt: string } | { status: "blocked"; reason: string }> {
  const hooks = normalizeHooks(options.hooks).userPromptSubmit
  if (hooks.length === 0) return { status: "continue", prompt: options.input.prompt }

  let prompt = options.input.prompt
  let appended = ""
  for (let index = 0; index < hooks.length; index++) {
    const result = await runHook({
      hook: "user_prompt_submit",
      index,
      emit: options.emit,
      sessionId: options.input.sessionId,
      signal: options.input.signal,
      timeoutMs: timeoutMs(options.hooks),
      maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
      suppressCompletedEmit: true,
      call: () => hooks[index]!({ ...options.input, prompt }),
    })
    if (result.status !== "completed") continue
    const value = result.value
    if (value && "type" in value && value.type === "block") {
      await emitHookEnded(options.emit, {
        hook: "user_prompt_submit",
        status: "blocked",
        message: value.reason,
        maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
      })
      return { status: "blocked", reason: value.reason }
    }
    const extra = value && "appendContext" in value ? value.appendContext : undefined
    let diagnostic = "continue"
    if (extra) {
      const capped = capBytesWithInfo(
        appended.length > 0 ? `${appended}\n\n${extra}` : extra,
        options.hooks?.maxExtraContextBytes ?? 8192,
      )
      appended = capped.text
      diagnostic = `appendContext bytes=${byteLength(extra)} totalBytes=${byteLength(appended)} truncated=${capped.truncated}`
    }
    await emitHookEnded(options.emit, {
      hook: "user_prompt_submit",
      status: "completed",
      message: diagnostic,
      maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
    })
  }

  if (appended.length > 0) {
    prompt = [
      prompt,
      "",
      "<system-reminder>",
      "Additional context from user_prompt_submit hook:",
      "",
      appended,
      "</system-reminder>",
    ].join("\n")
  }
  return { status: "continue", prompt }
}

export async function runPreToolHooks(
  options: HookRunOptions & { input: PreToolHookInput },
): Promise<{ status: "continue" } | { status: "blocked"; reason: string }> {
  const hooks = normalizeHooks(options.hooks).preTool
  for (let index = 0; index < hooks.length; index++) {
    const result = await runHook({
      hook: "pre_tool",
      index,
      emit: options.emit,
      sessionId: options.input.sessionId,
      turnId: options.input.turnId,
      stepId: options.input.stepId,
      toolCallId: options.input.toolCall.id,
      toolName: options.input.toolCall.name,
      signal: options.input.signal,
      timeoutMs: timeoutMs(options.hooks),
      maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
      call: () => hooks[index]!(options.input),
    })
    if (result.status !== "completed") continue
    const value = result.value
    if (value && "type" in value && value.type === "block") {
      await emitHookEnded(options.emit, {
        hook: "pre_tool",
        turnId: options.input.turnId,
        stepId: options.input.stepId,
        toolCallId: options.input.toolCall.id,
        toolName: options.input.toolCall.name,
        status: "blocked",
        message: value.reason,
        maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
      })
      return { status: "blocked", reason: value.reason }
    }
  }
  return { status: "continue" }
}

export async function runPostToolHooks(options: HookRunOptions & { input: PostToolHookInput }): Promise<void> {
  const hooks = normalizeHooks(options.hooks).postTool
  for (let index = 0; index < hooks.length; index++) {
    await runHook({
      hook: "post_tool",
      index,
      emit: options.emit,
      sessionId: options.input.sessionId,
      turnId: options.input.turnId,
      stepId: options.input.stepId,
      toolCallId: options.input.toolCall.id,
      toolName: options.input.toolCall.name,
      signal: options.input.signal,
      timeoutMs: timeoutMs(options.hooks),
      maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
      call: () => hooks[index]!(options.input),
    })
  }
}

export async function runStopHooks(options: HookRunOptions & { input: StopHookInput }): Promise<void> {
  const hooks = normalizeHooks(options.hooks).stop
  for (let index = 0; index < hooks.length; index++) {
    await runHook({
      hook: "stop",
      index,
      emit: options.emit,
      sessionId: options.input.sessionId,
      turnId: options.input.turnId,
      signal: options.input.signal,
      timeoutMs: timeoutMs(options.hooks),
      maxDiagnosticBytes: maxDiagnosticBytes(options.hooks),
      call: () => hooks[index]!(options.input),
    })
  }
}

function normalizeHooks(hooks: SessionHooks | undefined): {
  userPromptSubmit: UserPromptSubmitHook[]
  preTool: PreToolHook[]
  postTool: PostToolHook[]
  stop: StopHook[]
} {
  return {
    userPromptSubmit: [...(hooks?.userPromptSubmit ?? []), ...(hooks?.user_prompt_submit ?? [])],
    preTool: [...(hooks?.preTool ?? []), ...(hooks?.pre_tool ?? [])],
    postTool: [...(hooks?.postTool ?? []), ...(hooks?.post_tool ?? [])],
    stop: hooks?.stop ?? [],
  }
}

async function runHook<T>(input: {
  hook: HookName
  index: number
  emit?: HookEmit
  sessionId: string
  turnId?: string
  stepId?: string
  toolCallId?: string
  toolName?: string
  signal: AbortSignal
  timeoutMs: number
  maxDiagnosticBytes: number
  suppressCompletedEmit?: boolean
  call: () => T | Promise<T>
}): Promise<{ status: "completed"; value: T } | { status: "failed" | "timeout" }> {
  await input.emit?.({
    type: "hook.started",
    turnId: input.turnId,
    stepId: input.stepId,
    hook: input.hook,
    hookIndex: input.index,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  })
  try {
    const value = await withTimeout(Promise.resolve().then(input.call), input.timeoutMs, input.signal)
    if (!isBlockResult(value) && !input.suppressCompletedEmit) {
      await emitHookEnded(input.emit, {
        hook: input.hook,
        turnId: input.turnId,
        stepId: input.stepId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        status: "completed",
        maxDiagnosticBytes: input.maxDiagnosticBytes,
      })
    }
    return { status: "completed", value }
  } catch (error) {
    const timedOut = error instanceof HookTimeoutError
    await emitHookEnded(input.emit, {
      hook: input.hook,
      turnId: input.turnId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: timedOut ? "timeout" : "failed",
      message: error instanceof Error ? error.message : String(error),
      maxDiagnosticBytes: input.maxDiagnosticBytes,
    })
    return { status: timedOut ? "timeout" : "failed" }
  }
}

function isBlockResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === "block"
}

async function emitHookEnded(
  emit: HookEmit | undefined,
  input: {
    hook: HookName
    turnId?: string
    stepId?: string
    toolCallId?: string
    toolName?: string
    status: HookStatus
    message?: string
    maxDiagnosticBytes: number
  },
): Promise<void> {
  await emit?.({
    type: "hook.ended",
    turnId: input.turnId,
    stepId: input.stepId,
    hook: input.hook,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    message: input.message ? capBytes(input.message, input.maxDiagnosticBytes) : undefined,
  })
}

function timeoutMs(hooks: SessionHooks | undefined): number {
  return hooks?.timeoutMs ?? 5000
}

function maxDiagnosticBytes(hooks: SessionHooks | undefined): number {
  return hooks?.maxDiagnosticBytes ?? 2048
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(String(signal.reason ?? "aborted"))
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new Error(String(signal.reason ?? "aborted")))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      cleanup()
      reject(new HookTimeoutError(`Hook timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

class HookTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HookTimeoutError"
  }
}

function capBytes(text: string, maxBytes: number): string {
  return capBytesWithInfo(text, maxBytes).text
}

function capBytesWithInfo(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(text)
  if (encoded.byteLength <= maxBytes) return { text, truncated: false }
  const marker = `\n[truncated: capped at ${maxBytes} bytes]`
  const markerBytes = encoder.encode(marker).byteLength
  let output = ""
  let bytes = 0
  for (const char of text) {
    const charBytes = encoder.encode(char).byteLength
    if (bytes + charBytes + markerBytes > maxBytes) break
    output += char
    bytes += charBytes
  }
  return { text: output + marker, truncated: true }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}
