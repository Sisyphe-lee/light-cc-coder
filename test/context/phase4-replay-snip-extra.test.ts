import { describe, expect, test } from "bun:test"
import { ProjectionError } from "../../src/core/errors"
import type { SessionEvent, SessionEventDraft } from "../../src/core/events"
import { makeToolResultMessage } from "../../src/core/messages"
import { projectMessagesWithDiagnostics } from "../../src/engine/messageProjection"
import { replayProviderMessages } from "../../src/engine/transcript"
import type { ProviderMessage } from "../../src/providers/types"
import { assistant, call, user } from "../helpers"

describe("Phase 4 replay and snip extra coverage", () => {
  test("snip preserves tool messages and assistant/tool ids in provider order", () => {
    const readCall = call("c_read_old", "read", { path: "large.txt" })
    const bashCall = call("c_bash_old", "bash", { command: "cat large.txt" })
    const messages = [
      user("u1", "inspect"),
      assistant("a1", "using tools", [readCall, bashCall]),
      makeToolResultMessage({ id: "r_read_old", call: readCall, content: "read-output ".repeat(20) }),
      makeToolResultMessage({ id: "r_bash_old", call: bashCall, content: "bash-output ".repeat(20) }),
      assistant("a2", "done"),
    ]

    const projected = projectMessagesWithDiagnostics(messages, {
      snip: { enabled: true, recentMessageCount: 0, minToolResultBytes: 16 },
    })

    expect(projected.messages).toHaveLength(messages.length)
    expect(projected.messages.filter((message) => message.role === "tool")).toHaveLength(2)
    expect(assistantToolIds(projected.messages)).toEqual(["c_read_old", "c_bash_old"])
    expect(toolResultIds(projected.messages)).toEqual(["c_read_old", "c_bash_old"])
    expect(toolContents(projected.messages)).toEqual([
      "[snipped old tool result: read, original bytes=240, kept in transcript]",
      "[snipped old tool result: bash, original bytes=240, kept in transcript]",
    ])
    expect(projected.diagnostics.snippedToolResults).toBe(2)
  })

  test("recent tail stays unsnipped even when tool output is large", () => {
    const oldCall = call("c_old", "bash")
    const recentCall = call("c_recent", "bash")
    const oldOutput = "old-output ".repeat(40)
    const recentOutput = "recent-output ".repeat(80)
    const messages = [
      user("u1", "old"),
      assistant("a1", "old tool", [oldCall]),
      makeToolResultMessage({ id: "r_old", call: oldCall, content: oldOutput }),
      user("u2", "recent"),
      assistant("a2", "recent tool", [recentCall]),
      makeToolResultMessage({ id: "r_recent", call: recentCall, content: recentOutput }),
    ]

    const projected = projectMessagesWithDiagnostics(messages, {
      snip: { enabled: true, recentMessageCount: 3, minToolResultBytes: 16 },
    })

    expect(projected.diagnostics.snippedToolResults).toBe(1)
    expect(toolContents(projected.messages)).toEqual([
      "[snipped old tool result: bash, original bytes=440, kept in transcript]",
      recentOutput,
    ])
  })

  test("error and denied tool results use the larger error snip threshold", () => {
    const successCall = call("c_success", "bash")
    const deniedCall = call("c_denied", "bash")
    const successOutput = "success-output ".repeat(8)
    const deniedOutput = "Permission denied by policy. ".repeat(4)
    const messages = [
      user("u1", "run commands"),
      assistant("a1", "two commands", [successCall, deniedCall]),
      makeToolResultMessage({ id: "r_success", call: successCall, content: successOutput }),
      makeToolResultMessage({ id: "r_denied", call: deniedCall, content: deniedOutput, isError: true }),
    ]

    const projected = projectMessagesWithDiagnostics(messages, {
      snip: {
        enabled: true,
        recentMessageCount: 0,
        minToolResultBytes: 16,
        minErrorToolResultBytes: 256,
      },
    })

    expect(projected.diagnostics.snippedToolResults).toBe(1)
    expect(toolContents(projected.messages)).toEqual([
      "[snipped old tool result: bash, original bytes=120, kept in transcript]",
      deniedOutput,
    ])
  })

  test("replay from latest compact uses summary, pairing-safe tail, and suffix only", () => {
    const tailCall = call("c_tail", "read")
    const suffixCall = call("c_suffix", "bash")
    const events: SessionEvent[] = [
      event({ type: "user.message", turnId: "t_old", message: user("u_old", "old ignored user") }),
      event({
        type: "assistant.message",
        turnId: "t_old",
        stepId: "s_old",
        message: assistant("a_old", "old ignored assistant"),
      }),
      compactEnded("compact_old", "older compact summary", undefined),
      event({ type: "user.message", turnId: "t_tail", message: user("u_tail", "tail preface is summarized") }),
      event({
        type: "assistant.message",
        turnId: "t_tail",
        stepId: "s_tail",
        message: assistant("a_tail", "tail tool", [tailCall]),
      }),
      event({
        type: "tool.result",
        turnId: "t_tail",
        stepId: "s_tail",
        result: makeToolResultMessage({ id: "r_tail", call: tailCall, content: "tail result" }),
      }),
      compactEnded("compact_latest", "latest compact summary", "a_tail"),
      event({ type: "user.message", turnId: "t_suffix", message: user("u_suffix", "continue after compact") }),
      event({
        type: "assistant.message",
        turnId: "t_suffix",
        stepId: "s_suffix",
        message: assistant("a_suffix", "suffix tool", [suffixCall]),
      }),
      event({
        type: "tool.result",
        turnId: "t_suffix",
        stepId: "s_suffix",
        result: makeToolResultMessage({ id: "r_suffix", call: suffixCall, content: "suffix result" }),
      }),
      event({
        type: "assistant.message",
        turnId: "t_suffix",
        stepId: "s_suffix_done",
        message: assistant("a_suffix_done", "all done"),
      }),
    ]

    const replayed = replayProviderMessages(events)

    expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool", "assistant"])
    expect(replayed[0]).toEqual({ role: "user", content: compactSummaryContent("latest compact summary") })
    expect(assistantToolIds(replayed)).toEqual(["c_tail", "c_suffix"])
    expect(toolResultIds(replayed)).toEqual(["c_tail", "c_suffix"])
    expect(JSON.stringify(replayed)).not.toContain("old ignored")
    expect(JSON.stringify(replayed)).not.toContain("older compact summary")
    expect(JSON.stringify(replayed)).not.toContain("tail preface is summarized")
  })

  test("replay rejects malformed active compact tail or suffix pairings", () => {
    const tailCall = call("c_tail", "read")
    const firstSuffixCall = call("c_suffix_1", "bash")
    const secondSuffixCall = call("c_suffix_2", "bash")

    expect(() =>
      replayProviderMessages([
        event({ type: "user.message", turnId: "t_tail", message: user("u_tail", "tail") }),
        event({
          type: "assistant.message",
          turnId: "t_tail",
          stepId: "s_tail",
          message: assistant("a_tail", "tail tool", [tailCall]),
        }),
        event({
          type: "tool.result",
          turnId: "t_tail",
          stepId: "s_tail",
          result: makeToolResultMessage({ id: "r_tail", call: tailCall, content: "tail result" }),
        }),
        compactEnded("compact_bad_tail", "summary", "r_tail"),
      ]),
    ).toThrow(ProjectionError)

    expect(() =>
      replayProviderMessages([
        compactEnded("compact_suffix_missing", "summary", undefined),
        event({ type: "user.message", turnId: "t_suffix", message: user("u_suffix", "suffix") }),
        event({
          type: "assistant.message",
          turnId: "t_suffix",
          stepId: "s_suffix",
          message: assistant("a_suffix", "missing result", [firstSuffixCall]),
        }),
      ]),
    ).toThrow(ProjectionError)

    expect(() =>
      replayProviderMessages([
        compactEnded("compact_suffix_reordered", "summary", undefined),
        event({ type: "user.message", turnId: "t_suffix", message: user("u_suffix", "suffix") }),
        event({
          type: "assistant.message",
          turnId: "t_suffix",
          stepId: "s_suffix",
          message: assistant("a_suffix", "reordered results", [firstSuffixCall, secondSuffixCall]),
        }),
        event({
          type: "tool.result",
          turnId: "t_suffix",
          stepId: "s_suffix",
          result: makeToolResultMessage({ id: "r_suffix_2", call: secondSuffixCall, content: "second" }),
        }),
        event({
          type: "tool.result",
          turnId: "t_suffix",
          stepId: "s_suffix",
          result: makeToolResultMessage({ id: "r_suffix_1", call: firstSuffixCall, content: "first" }),
        }),
      ]),
    ).toThrow(ProjectionError)
  })
})

function assistantToolIds(messages: ProviderMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? (message.tool_calls ?? []).map((toolCall) => toolCall.id) : [],
  )
}

function toolResultIds(messages: ProviderMessage[]): string[] {
  return messages.flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : []))
}

function toolContents(messages: ProviderMessage[]): string[] {
  return messages.flatMap((message) => (message.role === "tool" ? [message.content] : []))
}

function compactEnded(compactId: string, summary: string, tailStartMessageId: string | undefined): SessionEvent {
  return event({
    type: "compact.ended",
    compactId,
    trigger: "manual",
    status: "succeeded",
    summaryMessage: user(`${compactId}_summary`, compactSummaryContent(summary)),
    summaryHash: `${compactId}_hash`,
    tailStartMessageId,
    summarizedMessageCount: 1,
    keptMessageCount: tailStartMessageId ? 2 : 0,
    preCompactEstimatedTokens: 100,
    postCompactEstimatedTokens: 20,
    omittedOldestGroups: 0,
  })
}

function compactSummaryContent(summary: string): string {
  return ["<system-reminder>", "Conversation compacted. Summary of earlier work:", "", summary, "</system-reminder>"].join(
    "\n",
  )
}

function event(event: SessionEventDraft): SessionEvent {
  return {
    seq: 0,
    timestamp: "2026-06-01T00:00:00.000Z",
    sessionId: "s_phase4_extra",
    ...event,
  } as SessionEvent
}
