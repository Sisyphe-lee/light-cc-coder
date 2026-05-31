import { describe, expect, test } from "bun:test"
import { ActiveTurnError } from "../../src/core/errors"
import type { SessionEvent } from "../../src/core/events"
import { AgentSession } from "../../src/core/AgentSession"
import type { TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import type { ProviderRequest } from "../../src/providers/types"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { assistant, deferred } from "../helpers"

describe("Phase 4 trigger behavior", () => {
  test("auto compact rewrites the next normal provider request to summary plus tail", async () => {
    const transcript = new RecordingTranscriptSink()
    const hugeHistory = hugeSentinel("AUTO_COMPACT_OLD_HISTORY")
    const summary = "Summary: compacted auto history without the original payload."
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", hugeHistory) },
        { message: assistant("compact_auto_a1", summary) },
        { message: assistant("a2", "after auto compact") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-auto-trigger-extra",
      cwd: "/tmp/light-cc-phase4-trigger-extra",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      contextBudget: { hardCompactTokens: 1_000, blockingTokens: 10_000 },
      now: fixedNow,
    })

    await session.submit({ type: "user_message", content: "first" })
    await session.submit({ type: "user_message", content: "second" })
    await session.close()

    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1].tools).toEqual([])
    expect(requestText(provider.requests[1])).toContain("Compact this earlier conversation history")
    expect(requestText(provider.requests[1])).toContain("AUTO_COMPACT_OLD_HISTORY")

    const mainRequest = provider.requests[2]
    expect(mainRequest.tools).toBeUndefined()
    expect(requestText(mainRequest)).toContain("Conversation compacted. Summary of earlier work")
    expect(requestText(mainRequest)).toContain(summary)
    expect(requestText(mainRequest)).toContain("second")
    expect(requestText(mainRequest)).not.toContain("AUTO_COMPACT_OLD_HISTORY")

    expect(compactStartedTriggers(transcript.events)).toEqual(["auto"])
    expect(contextStepEvents(transcript.events)).toHaveLength(2)
  })

  test("provider overflow compacts once and a second overflow fails without another retry loop", async () => {
    const transcript = new RecordingTranscriptSink()
    const hugeHistory = hugeSentinel("OVERFLOW_OLD_HISTORY")
    const summary = "Summary: overflow recovery history."
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", hugeHistory) },
        { error: "context length too large" },
        { message: assistant("compact_overflow_a1", summary) },
        { error: "context length too large again" },
      ],
    })
    const session = await AgentSession.create({
      id: "s-overflow-trigger-extra",
      cwd: "/tmp/light-cc-phase4-trigger-extra",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      contextBudget: { hardCompactTokens: 90_000, blockingTokens: 95_000 },
      now: fixedNow,
    })

    await session.submit({ type: "user_message", content: "first" })
    await expect(session.submit({ type: "user_message", content: "second" })).rejects.toThrow(
      "context length too large again",
    )
    await session.close()

    expect(provider.requests).toHaveLength(4)
    expect(provider.requests[2].tools).toEqual([])
    expect(requestText(provider.requests[2])).toContain("OVERFLOW_OLD_HISTORY")

    const retryRequest = provider.requests[3]
    expect(requestText(retryRequest)).toContain("Conversation compacted. Summary of earlier work")
    expect(requestText(retryRequest)).toContain(summary)
    expect(requestText(retryRequest)).toContain("second")
    expect(requestText(retryRequest)).not.toContain("OVERFLOW_OLD_HISTORY")

    expect(compactStartedTriggers(transcript.events)).toEqual(["overflow_retry"])
    expect(fatalErrors(transcript.events).map((event) => event.error)).toEqual(["context length too large again"])
  })

  test("manual compact while a turn is active is rejected and does not mutate active history", async () => {
    const transcript = new RecordingTranscriptSink()
    const providerEntered = deferred<void>()
    const releaseProvider = deferred<void>()
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "done"), waitBeforeMessage: releaseProvider.promise }],
      onRequest: () => providerEntered.resolve(),
    })
    const session = await AgentSession.create({
      id: "s-active-compact-boundary",
      cwd: "/tmp/light-cc-phase4-trigger-extra",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      now: fixedNow,
    })

    const activeTurn = session.submit({ type: "user_message", content: "keep running" })
    await providerEntered.promise
    const beforeRejectedCompact = session.getMessages()

    await expect(session.submit({ type: "compact.request", id: "compact_while_active" })).rejects.toThrow(
      ActiveTurnError,
    )
    expect(session.getMessages()).toEqual(beforeRejectedCompact)
    expect(transcript.events.some((event) => event.type === "compact.started")).toBe(false)

    releaseProvider.resolve()
    await activeTurn
    await session.close()
  })

  test("auto compact failure below blocking threshold keeps active history intact and continues", async () => {
    const transcript = new RecordingTranscriptSink()
    const hugeHistory = hugeSentinel("AUTO_FAIL_BELOW_OLD_HISTORY")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", hugeHistory) },
        { error: "summary model unavailable" },
        { message: assistant("a2", "continued without compact") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-auto-fail-below",
      cwd: "/tmp/light-cc-phase4-trigger-extra",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      contextBudget: { hardCompactTokens: 1_000, blockingTokens: 10_000 },
      now: fixedNow,
    })

    await session.submit({ type: "user_message", content: "first" })
    await session.submit({ type: "user_message", content: "second" })
    await session.close()

    expect(provider.requests).toHaveLength(3)
    expect(requestText(provider.requests[2])).toContain("AUTO_FAIL_BELOW_OLD_HISTORY")
    expect(requestText(provider.requests[2])).not.toContain("Conversation compacted. Summary of earlier work")

    expect(session.getMessages().map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(session.getMessages()[1]).toMatchObject({ role: "assistant", content: hugeHistory })
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", content: "continued without compact" })

    const failed = compactEndedFailures(transcript.events)
    expect(failed).toHaveLength(1)
    expect(failed[0].trigger).toBe("auto")
    expect(failed[0].error).toContain("summary model unavailable")
  })

  test("auto compact failure above blocking threshold fails clearly without a normal provider call", async () => {
    const transcript = new RecordingTranscriptSink()
    const hugeHistory = hugeSentinel("AUTO_FAIL_BLOCKING_OLD_HISTORY")
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", hugeHistory) },
        { error: "summary model unavailable" },
      ],
    })
    const session = await AgentSession.create({
      id: "s-auto-fail-blocking",
      cwd: "/tmp/light-cc-phase4-trigger-extra",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      compactTailMessages: 1,
      contextBudget: { hardCompactTokens: 1_000, blockingTokens: 1_100 },
      now: fixedNow,
    })

    await session.submit({ type: "user_message", content: "first" })
    await expect(session.submit({ type: "user_message", content: "second" })).rejects.toThrow(
      /Provider request exceeds context budget .* auto compact failed: summary model unavailable/,
    )
    await session.close()

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1].tools).toEqual([])
    expect(requestText(provider.requests[1])).toContain("AUTO_FAIL_BLOCKING_OLD_HISTORY")
    expect(session.getMessages().map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(session.getMessages()[1]).toMatchObject({ role: "assistant", content: hugeHistory })
    expect(session.getMessages()[0].content).not.toContain("Conversation compacted. Summary of earlier work")

    expect(compactEndedFailures(transcript.events).map((event) => event.trigger)).toEqual(["auto"])
    expect(contextStepEvents(transcript.events)).toHaveLength(1)
    expect(fatalErrors(transcript.events).map((event) => event.error)).toEqual([
      expect.stringContaining("auto compact failed: summary model unavailable"),
    ])
  })
})

class RecordingTranscriptSink implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

function fixedNow(): string {
  return "2026-05-31T00:00:00.000Z"
}

function hugeSentinel(label: string): string {
  return `${label}\n${"x".repeat(5_000)}`
}

function requestText(request: ProviderRequest): string {
  return request.messages.map((message) => message.content).join("\n")
}

function compactStartedTriggers(events: SessionEvent[]): string[] {
  return events
    .filter((event): event is Extract<SessionEvent, { type: "compact.started" }> => event.type === "compact.started")
    .map((event) => event.trigger)
}

function compactEndedFailures(events: SessionEvent[]): Array<Extract<SessionEvent, { type: "compact.ended"; status: "failed" }>> {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "compact.ended"; status: "failed" }> =>
      event.type === "compact.ended" && event.status === "failed",
  )
}

function fatalErrors(events: SessionEvent[]): Array<Extract<SessionEvent, { type: "error" }>> {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "error" }> => event.type === "error" && !event.recoverable,
  )
}

function contextStepEvents(events: SessionEvent[]): Array<Extract<SessionEvent, { type: "context.step" }>> {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "context.step" }> => event.type === "context.step",
  )
}
