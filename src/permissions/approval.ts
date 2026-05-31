import type { SessionEventDraft } from "../core/events"
import type { ApprovalDecision, ApprovalRequest, ApprovalRequester } from "./types"

export type ApprovalManagerOptions = {
  makeId: (prefix: string) => string
  emit: (event: SessionEventDraft) => Promise<void>
}

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void
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
      const finish = (decision: ApprovalDecision) => {
        signal.removeEventListener("abort", onAbort)
        this.pending.delete(approvalId)
        resolve(decision)
      }
      const onAbort = () => finish("deny")
      this.pending.set(approvalId, { resolve: finish })
      signal.addEventListener("abort", onAbort, { once: true })
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
    })
    return await promise
  }

  async respond(approvalId: string, decision: ApprovalDecision): Promise<boolean> {
    const pending = this.pending.get(approvalId)
    if (!pending) return false
    pending.resolve(decision)
    await this.emit({ type: "approval.responded", approvalId, decision })
    return true
  }

  async cancelAll(): Promise<void> {
    for (const [approvalId, pending] of this.pending) {
      this.pending.delete(approvalId)
      pending.resolve("deny")
      await this.emit({ type: "approval.responded", approvalId, decision: "deny" })
    }
  }
}
