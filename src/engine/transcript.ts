import { mkdir, readFile, appendFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ProjectionError } from "../core/errors"
import type { SessionEvent } from "../core/events"
import type { InternalMessage, ToolCall } from "../core/messages"
import { projectMessages } from "./messageProjection"
import type { ProviderMessage } from "../providers/types"

export interface TranscriptSink {
  write(event: SessionEvent): Promise<void>
  close?(): Promise<void>
}

export class JsonlTranscriptWriter implements TranscriptSink {
  constructor(readonly path: string) {}

  async write(event: SessionEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8")
  }
}

export async function readJsonlTranscript(path: string): Promise<SessionEvent[]> {
  const content = await readFile(path, "utf8")
  return parseJsonlTranscript(content)
}

export function parseJsonlTranscript(content: string): SessionEvent[] {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent)
}

export function messagesFromEvents(events: SessionEvent[]): InternalMessage[] {
  const messages: InternalMessage[] = []
  let pending: { calls: ToolCall[]; turnId: string; stepId: string } | undefined
  for (const event of events) {
    if (event.type === "turn.started" && pending) {
      throw new ProjectionError(`Missing tool result for call ${pending.calls[0]?.id}`)
    }

    if (event.type === "step.ended" && pending && event.turnId === pending.turnId && event.stepId === pending.stepId) {
      throw new ProjectionError(`Missing tool result for call ${pending.calls[0]?.id}`)
    }

    if (event.type === "turn.ended" && pending && event.turnId === pending.turnId) {
      throw new ProjectionError(`Missing tool result for call ${pending.calls[0]?.id}`)
    }

    if (event.type === "user.message") {
      if (pending) throw new ProjectionError(`Missing tool result for call ${pending.calls[0]?.id}`)
      messages.push(event.message)
    }

    if (event.type === "assistant.message") {
      if (pending) throw new ProjectionError(`Missing tool result for call ${pending.calls[0]?.id}`)
      messages.push(event.message)
      if (event.message.toolCalls.length > 0) {
        pending = {
          calls: event.message.toolCalls.slice(),
          turnId: event.turnId,
          stepId: event.stepId,
        }
      }
    }

    if (event.type === "tool.result") {
      if (!pending) {
        messages.push(event.result)
        continue
      }
      if (event.turnId !== pending.turnId || event.stepId !== pending.stepId) {
        throw new ProjectionError(`Tool result for call ${event.result.toolCallId} crosses step or turn boundary`)
      }
      messages.push(event.result)
      pending.calls = pending.calls.slice(1)
      if (pending.calls.length === 0) pending = undefined
    }
  }
  if (pending) throw new ProjectionError(`Missing tool result for call ${pending.calls[0]?.id}`)
  return messages
}

export function replayProviderMessages(events: SessionEvent[]): ProviderMessage[] {
  return projectMessages(messagesFromEvents(events))
}
