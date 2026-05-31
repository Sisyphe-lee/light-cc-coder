import type { ToolAccesses } from "../tools/registry"

export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access"

export type PermissionDecision =
  | { kind: "allow"; reason: string; subject: string }
  | { kind: "ask"; reason: string; subject: string }
  | { kind: "deny"; reason: string; subject: string; code?: "permission_denied" | "sensitive_path" }

export type PermissionRequest = {
  toolName: string
  input: unknown
  readOnly: boolean
  accesses?: ToolAccesses
}

export type ApprovalDecision = "allow" | "deny"

export type ApprovalRequest = {
  turnId: string
  stepId: string
  toolCallId: string
  toolName: string
  subject: string
  reason: string
}

export interface ApprovalRequester {
  request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
}
