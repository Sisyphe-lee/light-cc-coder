import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SessionEvent } from "../../src/core/events"
import type { ToolCall, ToolResultMessage } from "../../src/core/messages"
import { makeToolResultMessage, makeUserMessage } from "../../src/core/messages"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { runTurn } from "../../src/loop/runTurn"
import type { ProviderMessage } from "../../src/providers/types"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import type { ToolContext, ToolRuntime } from "../../src/tools/ToolRuntime"
import { AgentSession } from "../../src/core/AgentSession"
import { assistant, call, collectAsync, createTempWorkspace } from "../helpers"

describe("Phase 2 SessionEngine/AgentSession/runTurn integration", () => {
  test("context diagnostics are persisted but replayProviderMessages ignores them", async () => {
    const root = await createTempWorkspace("light-cc-phase2-context-")
    await writeFile(join(root, "AGENTS.md"), "Project rule: keep tests focused.\n", "utf8")
    const transcript = new RecordingTranscriptSink()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await AgentSession.create({
      id: "s-context-replay",
      cwd: root,
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    expect(transcript.events.some((event) => event.type === "context.session")).toBe(true)
    expect(transcript.events.some((event) => event.type === "context.step")).toBe(true)
    expect(provider.requests[0]?.messages.map((message) => message.role)).toEqual(["system", "user", "user"])
    expect(provider.requests[0]?.messages[1]?.content).toContain("Project instructions from AGENTS.md")
    expect(replayProviderMessages(transcript.events)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
    ])
  })

  test("context.step is written before the provider call for the step", async () => {
    const transcript = new RecordingTranscriptSink()
    const eventTypesAtProviderCall: string[][] = []
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "done") }],
      onRequest: () => {
        eventTypesAtProviderCall.push(transcript.events.map((event) => event.type))
      },
    })
    const session = await AgentSession.create({
      id: "s-context-before-provider",
      cwd: "/workspace",
      provider,
      toolRuntime: new FakeToolRuntime(),
      transcript,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    expect(eventTypesAtProviderCall).toHaveLength(1)
    expect(eventTypesAtProviderCall[0]).toEqual([
      "session.started",
      "context.session",
      "turn.started",
      "user.message",
      "step.started",
      "context.step",
    ])
  })

  test("runTurn sends only the messages and tools returned by assembleProviderRequest", async () => {
    const providerMessages: ProviderMessage[] = [{ role: "system", content: "callback-owned request" }]
    const providerTools = [{ type: "function", function: { name: "callback_tool", parameters: { type: "object" } } }]
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const runtime = new FakeToolRuntime()
    const state = { messages: [] }
    const seenAssemblerMessages: string[][] = []

    await runTurn({
      sessionId: "s-runturn-callback",
      turnId: "turn_1",
      userMessage: makeUserMessage("user_1", "real user content"),
      state,
      provider,
      toolRuntime: runtime,
      signal: new AbortController().signal,
      maxSteps: 1,
      assembleProviderRequest: async (input) => {
        seenAssemblerMessages.push(input.messages.map((message) => message.role))
        return { messages: providerMessages, tools: providerTools }
      },
      makeId: (prefix) => `${prefix}_1`,
    })

    expect(seenAssemblerMessages).toEqual([["user"]])
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.messages).toEqual(providerMessages)
    expect(provider.requests[0]?.tools).toEqual(providerTools)
    expect(provider.requests[0]?.messages).not.toContainEqual({ role: "user", content: "real user content" })
  })

  test("tool schema hash changes are visible on a later step and do not stop the turn", async () => {
    const transcript = new RecordingTranscriptSink()
    const runtime = new MutableSchemaRuntime()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "use tool", [call("c1", "mutate_schema")]) },
        { message: assistant("a2", "done after schema change") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-schema-change",
      cwd: "/workspace",
      provider,
      toolRuntime: runtime,
      transcript,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "change schema after tool execution" })
    await session.close()

    const stepEvents = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "context.step" }> => event.type === "context.step",
    )
    expect(stepEvents).toHaveLength(2)
    expect(stepEvents[0].snapshot.toolSchemaChanged).toBe(false)
    expect(stepEvents[1].snapshot.toolSchemaChanged).toBe(true)
    expect(stepEvents[0].snapshot.toolSchemaHash).not.toBe(stepEvents[1].snapshot.toolSchemaHash)
    expect(provider.requests.map((request) => schemaVersion(request.tools))).toEqual([1, 2])
    expect(session.getMessages().at(-1)).toMatchObject({ role: "assistant", content: "done after schema change" })
  })
})

class RecordingTranscriptSink implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}

class MutableSchemaRuntime implements ToolRuntime {
  private version = 1
  private nextResult = 0

  getToolSchemas(): unknown[] {
    return [
      {
        type: "function",
        function: {
          name: "mutate_schema",
          description: `schema version ${this.version}`,
          parameters: {
            type: "object",
            properties: {
              version: { const: this.version },
            },
          },
        },
      },
    ]
  }

  async runBatch(calls: ToolCall[], _ctx: ToolContext): Promise<ToolResultMessage[]> {
    return calls.map((toolCall) => {
      this.version = 2
      this.nextResult += 1
      return makeToolResultMessage({
        id: `mutable_result_${this.nextResult}`,
        call: toolCall,
        content: "schema changed",
      })
    })
  }
}

function schemaVersion(tools: unknown[] | undefined): number | undefined {
  const first = tools?.[0] as
    | {
        function?: {
          parameters?: {
            properties?: {
              version?: { const?: number }
            }
          }
        }
      }
    | undefined
  return first?.function?.parameters?.properties?.version?.const
}
