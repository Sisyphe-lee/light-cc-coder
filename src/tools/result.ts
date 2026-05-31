import { makeToolResultMessage, type ToolCall, type ToolResultMessage } from "../core/messages"

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "path_denied"
  | "sensitive_path"
  | "not_found"
  | "not_text"
  | "too_large"
  | "not_unique"
  | "malformed_patch"
  | "patch_conflict"
  | "io_error"
  | "permission_denied"
  | "sandbox_denied"
  | "sandbox_unavailable"
  | "timeout"
  | "runtime_error"
  | "tool_error"
  | "aborted"
  | "internal_error"

export class ToolExecutionError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly subject?: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "ToolExecutionError"
  }
}

export type ToolObservation = {
  content: string
  isError?: boolean
  preserveErrorContent?: boolean
}

export function toolErrorResult(args: {
  id: string
  call: ToolCall
  code: ToolErrorCode
  message: string
  subject?: string
}): ToolResultMessage {
  return makeToolResultMessage({
    id: args.id,
    call: args.call,
    content: formatToolError(args.code, args.message, args.subject),
    isError: true,
  })
}

export function toolSuccessResult(args: { id: string; call: ToolCall; content: string }): ToolResultMessage {
  return makeToolResultMessage({ id: args.id, call: args.call, content: args.content, isError: false })
}

export function formatToolError(code: ToolErrorCode, message: string, subject?: string): string {
  const suffix = subject ? `\nSubject: ${subject}` : ""
  return `Error (${code}): ${message}${suffix}`
}

export function coerceToolError(error: unknown): { code: ToolErrorCode; message: string; subject?: string } {
  if (error instanceof ToolExecutionError) {
    return { code: error.code, message: error.message, subject: error.subject }
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message }
  }
  return { code: "internal_error", message: String(error) }
}

export function truncateText(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(text)
  if (encoded.byteLength <= maxBytes) return text

  const marker = `\n\n[truncated: output capped at ${maxBytes} bytes]`
  const markerBytes = encoder.encode(marker).byteLength
  if (markerBytes >= maxBytes) {
    return truncateUtf8ByCodePoint(marker, maxBytes, encoder)
  }
  return truncateUtf8ByCodePoint(text, maxBytes - markerBytes, encoder) + marker
}

function truncateUtf8ByCodePoint(text: string, maxBytes: number, encoder: TextEncoder): string {
  let bytes = 0
  let output = ""
  for (const char of text) {
    const charBytes = encoder.encode(char).byteLength
    if (bytes + charBytes > maxBytes) break
    output += char
    bytes += charBytes
  }
  return output
}
