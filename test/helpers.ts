import type { SessionEventDraft } from "../src/core/events"
import { makeAssistantMessage, makeUserMessage, type AssistantMessage, type ToolCall } from "../src/core/messages"
import type { TranscriptSink } from "../src/engine/transcript"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

export function assistant(id: string, content: string, toolCalls: ToolCall[] = []): AssistantMessage {
  return makeAssistantMessage({ id, content, toolCalls })
}

export function call(id: string, name: string, input: unknown = {}): ToolCall {
  return { id, name, input }
}

export function user(id = "u1", content = "hello") {
  return makeUserMessage(id, content)
}

export function createIdFactory(): (prefix: string) => string {
  let next = 0
  return (prefix) => {
    next += 1
    return `${prefix}_${next}`
  }
}

export function createDraftRecorder() {
  const events: SessionEventDraft[] = []
  return {
    events,
    emit: async (event: SessionEventDraft) => {
      events.push(event)
    },
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export class MemoryTranscriptSink implements TranscriptSink {
  readonly events: unknown[] = []
  constructor(private readonly failOn?: string) {}

  async write(event: unknown): Promise<void> {
    if (this.failOn && typeof event === "object" && event && "type" in event && event.type === this.failOn) {
      throw new Error(`fail ${this.failOn}`)
    }
    this.events.push(event)
  }
}

export async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of iterable) values.push(value)
  return values
}

export async function createTempWorkspace(prefix = "light-cc-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}
