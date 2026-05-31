import { AbortTurnError, throwIfAborted } from "../core/errors"
import { makeToolResultMessage, type ToolCall, type ToolResultMessage } from "../core/messages"
import type { ToolContext, ToolRuntime } from "./ToolRuntime"

export type FakeToolHandlerResult =
  | string
  | { content: string; isError?: boolean }
  | ToolResultMessage

export type FakeToolDefinition = {
  validate?: (input: unknown) => true | false | string
  handler?: (input: unknown, call: ToolCall, ctx: ToolContext) => FakeToolHandlerResult | Promise<FakeToolHandlerResult>
}

export type FakeRuntimeViolation = "missing" | "duplicate" | "reordered" | "orphan"

export type FakeToolRuntimeOptions = {
  tools?: Record<string, FakeToolDefinition>
  violation?: FakeRuntimeViolation
}

export class FakeToolRuntime implements ToolRuntime {
  private readonly tools: Record<string, FakeToolDefinition>
  private readonly violation?: FakeRuntimeViolation
  private nextResult = 0

  constructor(options: FakeToolRuntimeOptions = {}) {
    this.tools = options.tools ?? {}
    this.violation = options.violation
  }

  async runBatch(calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = []
    for (const call of calls) {
      throwIfAborted(ctx.signal)
      results.push(await this.runOne(call, ctx))
    }
    return this.applyViolation(results, calls)
  }

  private async runOne(call: ToolCall, ctx: ToolContext): Promise<ToolResultMessage> {
    const tool = this.tools[call.name]
    if (!tool) {
      return this.errorResult(call, `Unknown tool: ${call.name}`)
    }

    const validation = tool.validate?.(call.input) ?? true
    if (validation !== true) {
      return this.errorResult(call, typeof validation === "string" ? validation : `Invalid input for ${call.name}`)
    }

    try {
      const value = await tool.handler?.(call.input, call, ctx)
      return this.normalizeResult(call, value ?? `ok:${call.name}`)
    } catch (error) {
      if (error instanceof AbortTurnError) throw error
      if (ctx.signal.aborted) throw new AbortTurnError(String(ctx.signal.reason ?? "aborted"))
      return this.errorResult(call, error instanceof Error ? error.message : String(error))
    }
  }

  private normalizeResult(call: ToolCall, value: FakeToolHandlerResult): ToolResultMessage {
    if (typeof value === "string") {
      return this.successResult(call, value)
    }
    if ("role" in value && value.role === "tool") {
      return value
    }
    return makeToolResultMessage({
      id: this.resultId(),
      call,
      content: value.content,
      isError: value.isError ?? false,
    })
  }

  private successResult(call: ToolCall, content: string): ToolResultMessage {
    return makeToolResultMessage({ id: this.resultId(), call, content, isError: false })
  }

  private errorResult(call: ToolCall, content: string): ToolResultMessage {
    return makeToolResultMessage({ id: this.resultId(), call, content, isError: true })
  }

  private resultId(): string {
    this.nextResult += 1
    return `fake_tool_result_${this.nextResult}`
  }

  private applyViolation(results: ToolResultMessage[], calls: ToolCall[]): ToolResultMessage[] {
    if (!this.violation) return results
    if (this.violation === "missing") return results.slice(1)
    if (this.violation === "duplicate") return results.length > 0 ? [results[0], ...results] : results
    if (this.violation === "reordered") return results.slice().reverse()
    if (this.violation === "orphan") {
      return [
        ...results,
        {
          id: this.resultId(),
          role: "tool",
          toolCallId: "orphan_call",
          toolName: calls[0]?.name ?? "orphan",
          content: "orphan",
          isError: true,
        },
      ]
    }
    return results
  }
}
