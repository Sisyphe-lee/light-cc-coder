import type { ProviderMessage } from "../providers/types"

export type ContextBudgetOptions = {
  maxContextTokens: number
  warningTokens: number
  softCompactTokens: number
  hardCompactTokens: number
  blockingTokens: number
  compactInputTokens: number
  compactOutputReserveTokens: number
}

export type ContextBudgetInput = Partial<ContextBudgetOptions> & {
  maxContextTokens?: number
}

const TOKEN_BYTE_RATIO = 4

export function createContextBudgetOptions(input: ContextBudgetInput = {}): ContextBudgetOptions {
  const maxContextTokens = input.maxContextTokens ?? 200_000
  return {
    maxContextTokens,
    warningTokens: input.warningTokens ?? Math.floor(maxContextTokens * 0.7),
    softCompactTokens: input.softCompactTokens ?? Math.floor(maxContextTokens * 0.775),
    hardCompactTokens: input.hardCompactTokens ?? Math.floor(maxContextTokens * 0.875),
    blockingTokens: input.blockingTokens ?? Math.floor(maxContextTokens * 0.9),
    compactInputTokens:
      input.compactInputTokens ??
      Math.max(1_000, Math.floor(maxContextTokens * 0.9) - Math.max(1_000, Math.floor(maxContextTokens * 0.1))),
    compactOutputReserveTokens: input.compactOutputReserveTokens ?? Math.max(1_000, Math.floor(maxContextTokens * 0.1)),
  }
}

export function estimateProviderRequestTokens(input: { messages: ProviderMessage[]; tools?: unknown[] }): number {
  return estimateTokens(stableJson({ messages: input.messages, tools: input.tools ?? null }))
}

export function estimateMessagesTokens(messages: unknown[]): number {
  return estimateTokens(stableJson(messages))
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / TOKEN_BYTE_RATIO)
}

export function isContextTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /context|prompt|token|tokens|maximum context|too large|too long|length/i.test(message)
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}
