import { isSensitiveRelativePath } from "../workspace/pathBoundary"
import { hardDenyShellCommand, isGitInspectionCommand } from "./shellPolicy"
import type { PermissionDecision, PermissionMode, PermissionRequest } from "./types"

export class PermissionPolicy {
  constructor(readonly mode: PermissionMode = "workspace-write") {}

  decide(request: PermissionRequest): PermissionDecision {
    const subject = subjectFor(request)
    const sensitive = sensitiveSubject(request)
    if (sensitive) {
      return { kind: "deny", reason: "Sensitive path is denied", subject: sensitive, code: "sensitive_path" }
    }

    if (request.toolName === "bash") {
      const command = String((request.input as { command?: unknown } | undefined)?.command ?? "")
      const denied = hardDenyShellCommand(command)
      if (denied.denied) {
        return { kind: "deny", reason: denied.reason ?? "Shell command is hard denied", subject }
      }
    }

    if (this.mode === "read-only") {
      if (["read", "grep", "glob"].includes(request.toolName)) {
        return { kind: "allow", reason: "Read-only tool is allowed", subject }
      }
      if (request.toolName === "bash") {
        return { kind: "deny", reason: "Bash is denied in read-only mode", subject }
      }
      return { kind: "deny", reason: "Write-capable tools are denied in read-only mode", subject }
    }

    if (this.mode === "danger-full-access") {
      return { kind: "allow", reason: "danger-full-access allows non-hard-denied tools", subject }
    }

    if (request.toolName === "bash") {
      const command = String((request.input as { command?: unknown } | undefined)?.command ?? "")
      if (isGitInspectionCommand(command)) {
        return { kind: "allow", reason: "Git inspection command is allowlisted", subject }
      }
      return { kind: "ask", reason: "Bash requires approval in workspace-write mode", subject }
    }

    return { kind: "allow", reason: "Workspace file/read tool is allowed", subject }
  }
}

export function subjectFor(request: PermissionRequest): string {
  const input = request.input
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>
    for (const key of ["command", "path", "file_path", "pattern"]) {
      const value = record[key]
      if (typeof value === "string" && value.length > 0) return value
    }
  }
  const fromAccess =
    request.accesses?.writes?.[0] ?? request.accesses?.reads?.[0] ?? request.accesses?.searches?.[0]
  if (fromAccess) return fromAccess
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return request.toolName
  }
}

function sensitiveSubject(request: PermissionRequest): string | undefined {
  const paths = [...(request.accesses?.reads ?? []), ...(request.accesses?.writes ?? [])]
  for (const path of paths) {
    if (isSensitiveRelativePath(path)) return path
  }
  const input = request.input
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>
    for (const key of ["path", "file_path"]) {
      const value = record[key]
      if (typeof value === "string" && isSensitiveRelativePath(value)) return value
    }
  }
  return undefined
}
