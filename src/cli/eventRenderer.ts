import type { AgentSession } from "../core/AgentSession"
import type { SessionEvent } from "../core/events"
import { ApprovalPrompt } from "./approvalPrompt"

export type EventRendererOptions = {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  verbose?: boolean
  showTurnStatus?: boolean
  approvalPrompt?: ApprovalPrompt
  onEvent?: (event: SessionEvent) => Promise<void> | void
  onHostAction?: (event: Extract<SessionEvent, { type: "command.output" }>) => Promise<void> | void
}

export class EventRenderer {
  private readonly stdout: NodeJS.WritableStream
  private readonly stderr: NodeJS.WritableStream
  private readonly approvalPrompt: ApprovalPrompt
  private readonly verbose: boolean
  private readonly showTurnStatus: boolean
  private readonly onEvent?: EventRendererOptions["onEvent"]
  private readonly onHostAction?: EventRendererOptions["onHostAction"]
  private deltaSteps = new Set<string>()

  constructor(options: EventRendererOptions = {}) {
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    this.approvalPrompt = options.approvalPrompt ?? new ApprovalPrompt()
    this.verbose = options.verbose ?? false
    this.showTurnStatus = options.showTurnStatus ?? false
    this.onEvent = options.onEvent
    this.onHostAction = options.onHostAction
  }

  get approvals(): ApprovalPrompt {
    return this.approvalPrompt
  }

  async consume(session: AgentSession): Promise<void> {
    for await (const event of session.events()) {
      await this.onEvent?.(event)
      await this.render(event, session)
    }
  }

  private async render(event: SessionEvent, session: AgentSession): Promise<void> {
    if (event.type === "assistant.delta") {
      this.deltaSteps.add(event.stepId)
      this.stdout.write(event.text)
      return
    }
    if (event.type === "assistant.message" && !this.deltaSteps.has(event.stepId) && event.message.content) {
      this.stdout.write(event.message.content)
      if (!event.message.content.endsWith("\n")) this.stdout.write("\n")
      return
    }
    if (event.type === "tool.call") {
      this.stderr.write(`tool.call ${event.call.name}\n`)
      return
    }
    if (event.type === "tool.result") {
      this.stderr.write(`tool.result ${event.result.toolName} ${event.result.isError ? "error" : "ok"}\n`)
      return
    }
    if (event.type === "command.output") {
      this.stdout.write(event.content)
      if (!event.content.endsWith("\n")) this.stdout.write("\n")
      if (event.hostAction) await this.onHostAction?.(event)
      return
    }
    if (event.type === "approval.requested") {
      const decision = await this.approvalPrompt.ask(event, session.cwd)
      if (decision !== "aborted") {
        await session.submit({ type: "approval.respond", approvalId: event.approvalId, decision })
      }
      return
    }
    if (event.type === "turn.ended") {
      if (this.showTurnStatus) this.stderr.write(`turn.${event.reason}\n`)
      return
    }
    if (event.type === "error") {
      this.stderr.write(`${event.recoverable ? "error" : "fatal"}: ${event.error}\n`)
      return
    }
    if (this.verbose && isDiagnostic(event)) {
      this.stderr.write(`${event.type}\n`)
    }
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
