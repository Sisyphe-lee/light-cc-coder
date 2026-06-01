import type { AgentSession } from "../core/AgentSession"
import type { SessionEvent } from "../core/events"
import type { PermissionMode } from "../permissions/types"
import { ApprovalPrompt } from "./approvalPrompt"

export type EventRendererOptions = {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  verbose?: boolean
  json?: boolean
  permissionMode?: PermissionMode
  showTurnStatus?: boolean
  showActivityIndicator?: boolean
  approvalPrompt?: ApprovalPrompt
  onEvent?: (event: SessionEvent) => Promise<void> | void
  onHostAction?: (event: Extract<SessionEvent, { type: "command.output" }>) => Promise<void> | void
}

export class EventRenderer {
  private readonly stdout: NodeJS.WritableStream
  private readonly stderr: NodeJS.WritableStream
  private readonly approvalPrompt: ApprovalPrompt
  private readonly verbose: boolean
  private readonly json: boolean
  private readonly permissionMode?: PermissionMode
  private readonly showTurnStatus: boolean
  private readonly activity?: ActivityIndicator
  private readonly onEvent?: EventRendererOptions["onEvent"]
  private readonly onHostAction?: EventRendererOptions["onHostAction"]
  private deltaSteps = new Set<string>()
  private sandboxFallbackWarned = false
  private finalWritten = false
  private finalStatus: "ok" | "error" = "ok"
  private finalReason: string | undefined

  constructor(options: EventRendererOptions = {}) {
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    this.approvalPrompt = options.approvalPrompt ?? new ApprovalPrompt()
    this.verbose = options.verbose ?? false
    this.json = options.json ?? false
    this.permissionMode = options.permissionMode
    this.showTurnStatus = options.showTurnStatus ?? false
    this.activity = options.showActivityIndicator && !this.json ? new ActivityIndicator(this.stderr) : undefined
    this.onEvent = options.onEvent
    this.onHostAction = options.onHostAction
  }

  get approvals(): ApprovalPrompt {
    return this.approvalPrompt
  }

  async consume(session: AgentSession): Promise<void> {
    try {
      for await (const event of session.events()) {
        await this.onEvent?.(event)
        await this.render(event, session)
      }
    } finally {
      this.activity?.stop()
      this.writeFinalJson()
    }
  }

  private async render(event: SessionEvent, session: AgentSession): Promise<void> {
    if (this.json) {
      await this.renderJson(event, session)
      return
    }
    if (event.type === "turn.started" || event.type === "step.started") {
      this.activity?.start("thinking")
      return
    }
    if (event.type === "assistant.delta") {
      this.activity?.stop()
      this.deltaSteps.add(event.stepId)
      this.stdout.write(event.text)
      return
    }
    if (event.type === "assistant.message" && !this.deltaSteps.has(event.stepId) && event.message.content) {
      this.activity?.stop()
      this.stdout.write(event.message.content)
      if (!event.message.content.endsWith("\n")) this.stdout.write("\n")
      return
    }
    if (event.type === "tool.call") {
      this.activity?.stop()
      this.stderr.write(`tool.call ${event.call.name}\n`)
      this.activity?.start(`running ${event.call.name}`)
      return
    }
    if (event.type === "tool.result") {
      this.activity?.stop()
      this.stderr.write(`tool.result ${event.result.toolName} ${event.result.isError ? "error" : "ok"}\n`)
      return
    }
    if (event.type === "command.output") {
      this.activity?.stop()
      this.stdout.write(event.content)
      if (!event.content.endsWith("\n")) this.stdout.write("\n")
      if (event.hostAction) await this.onHostAction?.(event)
      return
    }
    if (event.type === "approval.requested") {
      this.activity?.stop()
      const decision = await this.approvalPrompt.ask(event, session.cwd)
      if (decision !== "aborted") {
        await session.submit({ type: "approval.respond", approvalId: event.approvalId, decision })
      }
      return
    }
    if (event.type === "turn.ended") {
      this.activity?.stop()
      if (this.showTurnStatus) this.stderr.write(`turn.${event.reason}\n`)
      return
    }
    if (event.type === "error") {
      this.activity?.stop()
      this.finalStatus = event.recoverable ? this.finalStatus : "error"
      this.stderr.write(`${event.recoverable ? "error" : "fatal"}: ${event.error}\n`)
      return
    }
    if (event.type === "sandbox.status") {
      this.warnSandboxFallback(event)
    }
    if (this.verbose && isDiagnostic(event)) {
      this.activity?.stop()
      this.stderr.write(`${event.type}\n`)
    }
  }

  private async renderJson(event: SessionEvent, session: AgentSession): Promise<void> {
    if (event.type === "turn.ended") {
      this.finalReason = event.reason
      if (event.reason === "error" || event.reason === "aborted") this.finalStatus = "error"
    } else if (event.type === "error" && !event.recoverable) {
      this.finalStatus = "error"
    }
    this.warnSandboxFallback(event)
    const mapped = mapJsonEvent(event)
    if (mapped) this.stdout.write(`${JSON.stringify(mapped)}\n`)
    if (event.type === "approval.requested") {
      const decision = await this.approvalPrompt.ask(event, session.cwd)
      if (decision !== "aborted") {
        await session.submit({ type: "approval.respond", approvalId: event.approvalId, decision })
      }
    }
  }

  private warnSandboxFallback(event: SessionEvent): void {
    if (event.type !== "sandbox.status") return
    if (event.requestedMode !== "auto" || event.active) return
    if (this.permissionMode === "read-only") return
    if (this.sandboxFallbackWarned) return
    this.sandboxFallbackWarned = true
    const reason = event.fallbackReason ? ` Reason: ${event.fallbackReason}` : ""
    this.stderr.write(
      `warning: OS sandbox auto fallback is using unsandboxed LocalRuntime for shell commands.${reason} Use --os-sandbox required to fail closed.\n`,
    )
  }

  private writeFinalJson(): void {
    if (!this.json || this.finalWritten) return
    this.finalWritten = true
    this.stdout.write(JSON.stringify({ type: "final", status: this.finalStatus, reason: this.finalReason ?? null }) + "\n")
  }
}

function mapJsonEvent(event: SessionEvent): Record<string, unknown> | undefined {
  const base = {
    type: event.type,
    seq: event.seq,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    turnId: event.turnId,
    stepId: event.stepId,
  }
  if (event.type === "assistant.delta") return { ...base, text: event.text }
  if (event.type === "assistant.message") {
    return {
      ...base,
      content: event.message.content,
      toolCalls: event.message.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    }
  }
  if (event.type === "tool.call") return { ...base, call: { id: event.call.id, name: event.call.name, input: event.call.input } }
  if (event.type === "tool.result") {
    return {
      ...base,
      result: {
        id: event.result.id,
        toolCallId: event.result.toolCallId,
        toolName: event.result.toolName,
        isError: event.result.isError,
        content: event.result.content,
      },
    }
  }
  if (event.type === "approval.requested") {
    return {
      ...base,
      approvalId: event.approvalId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      subject: event.subject,
      reason: event.reason,
      permissionMode: event.permissionMode,
      policyReason: event.policyReason,
      inputSummary: event.inputSummary,
      accessSummary: event.accessSummary,
      riskSummary: event.riskSummary,
    }
  }
  if (event.type === "approval.responded") return { ...base, approvalId: event.approvalId, decision: event.decision }
  if (event.type === "error") return { ...base, error: event.error, recoverable: event.recoverable }
  if (event.type === "turn.ended") return { ...base, reason: event.reason }
  return undefined
}

class ActivityIndicator {
  private timer?: ReturnType<typeof setInterval>
  private frame = 0
  private label = ""
  private active = false
  private readonly enabled: boolean

  constructor(private readonly stderr: NodeJS.WritableStream) {
    this.enabled = Boolean((stderr as NodeJS.WriteStream).isTTY)
  }

  start(label: string): void {
    if (!this.enabled) return
    this.label = label
    if (this.active) {
      this.render()
      return
    }
    this.active = true
    this.render()
    this.timer = setInterval(() => this.render(), 120)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.active) return
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.active = false
    this.stderr.write("\r\x1b[K")
  }

  private render(): void {
    if (!this.active) return
    const frames = ["-", "\\", "|", "/"]
    const frame = frames[this.frame % frames.length]
    this.frame += 1
    this.stderr.write(`\r\x1b[K${frame} ${this.label}`)
  }
}

function isDiagnostic(event: SessionEvent): boolean {
  return (
    event.type.startsWith("context.") ||
    event.type.startsWith("provider.") ||
    event.type.startsWith("sandbox.") ||
    event.type.startsWith("mcp.") ||
    event.type.startsWith("skill.") ||
    event.type.endsWith(".observation") ||
    event.type.endsWith(".observed")
  )
}
