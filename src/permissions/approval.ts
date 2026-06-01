import type { SessionEventDraft } from "../core/events"
import type { ApprovalDecision, ApprovalRequest, ApprovalRequester } from "./types"

export type ApprovalManagerOptions = {
  makeId: (prefix: string) => string
  emit: (event: SessionEventDraft) => Promise<void>
}

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void
  cleanup: () => void
}

export class ApprovalManager implements ApprovalRequester {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly makeId: (prefix: string) => string
  private readonly emit: (event: SessionEventDraft) => Promise<void>

  constructor(options: ApprovalManagerOptions) {
    this.makeId = options.makeId
    this.emit = options.emit
  }

  async request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return "deny"
    const approvalId = this.makeId("approval")
    const promise = new Promise<ApprovalDecision>((resolve) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort)
        this.pending.delete(approvalId)
      }
      const finish = (decision: ApprovalDecision) => {
        cleanup()
        resolve(decision)
      }
      const onAbort = () => finish("deny")
      this.pending.set(approvalId, { resolve, cleanup })
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) finish("deny")
    })
    await this.emit({
      type: "approval.requested",
      turnId: input.turnId,
      stepId: input.stepId,
      approvalId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      subject: input.subject,
      reason: input.reason,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      toolDescription: input.toolDescription,
      policyReason: input.policyReason,
      toolReason: input.toolReason,
      inputSummary: input.inputSummary,
      accessSummary: input.accessSummary,
      riskSummary: input.riskSummary,
    })
    return await promise
  }

  async respond(approvalId: string, decision: ApprovalDecision): Promise<boolean> {
    const pending = this.pending.get(approvalId)
    if (!pending) return false
    pending.cleanup()
    await this.emit({ type: "approval.responded", approvalId, decision })
    pending.resolve(decision)
    return true
  }

  async cancelAll(): Promise<void> {
    for (const [approvalId, pending] of this.pending) {
      pending.cleanup()
      await this.emit({ type: "approval.responded", approvalId, decision: "deny" })
      pending.resolve("deny")
    }
  }
}
