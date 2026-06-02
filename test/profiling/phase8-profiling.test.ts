import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { TranscriptWriteError } from "../../src/core/errors"
import type { SessionEvent } from "../../src/core/events"
import { messagesFromEvents, replayProviderMessages } from "../../src/engine/transcript"
import { FakeProvider, type FakeProviderStep } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import {
  boundAttributes,
  createProfiler,
  MAX_ATTRIBUTES_PER_SPAN,
  MAX_ATTRIBUTE_KEY_BYTES,
  MAX_ATTRIBUTE_STRING_BYTES,
  NOOP_PROFILER,
} from "../../src/profiling/profiler"
import { summarizeProfile } from "../../profiling/report/summarize"
import { renderJson } from "../../profiling/report/renderJson"
import { renderText } from "../../profiling/report/renderText"
import { validateAgainstSchema } from "../../profiling/schema/validateReport"
import { PROFILE_REPORT_SCHEMA_VERSION } from "../../profiling/report/types"
import { assistant, call, MemoryTranscriptSink } from "../helpers"

// Deterministic monotonic clock so span durations are reproducible in tests.
function counterClock(): () => number {
  let value = 0
  return () => (value += 1)
}

type ScriptOptions = {
  profile: boolean
  steps: FakeProviderStep[]
  doCompact?: boolean
}

async function runScript(options: ScriptOptions): Promise<SessionEvent[]> {
  const transcript = new MemoryTranscriptSink()
  const provider = new FakeProvider({ steps: options.steps })
  const session = await AgentSession.create({
    id: "s1",
    cwd: "/workspace",
    provider,
    toolRuntime: new FakeToolRuntime({ tools: { echo: { handler: () => "echoed" } } }),
    transcript,
    profile: options.profile,
    profilerNow: counterClock(),
    compactTailMessages: 1,
  })
  await session.submit({ type: "user_message", content: "hello-secret-prompt" })
  if (options.doCompact) await session.submit({ type: "compact.request" })
  await session.close()
  return transcript.events as SessionEvent[]
}

const TOOL_SCRIPT: FakeProviderStep[] = [
  { message: assistant("a1", "use tool", [call("c1", "echo", { value: 1 })]) },
  { message: assistant("a2", "done") },
]

const COMPACT_SCRIPT: FakeProviderStep[] = [
  { message: assistant("a1", "done") },
  { message: assistant("sum", "Compact summary of the conversation so far.") },
]

function stripSpans(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.type !== "profile.span")
}

function spans(events: SessionEvent[]): Extract<SessionEvent, { type: "profile.span" }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: "profile.span" }> => event.type === "profile.span")
}

describe("Phase 8 profiling — activation", () => {
  test("disabled profiling writes no profile.span events", async () => {
    const events = await runScript({ profile: false, steps: TOOL_SCRIPT })
    expect(spans(events)).toHaveLength(0)
  })

  test("enabled profiling writes provider, context, and transcript spans", async () => {
    const events = await runScript({ profile: true, steps: TOOL_SCRIPT })
    const names = new Set(spans(events).map((span) => span.name))
    expect(spans(events).length).toBeGreaterThan(0)
    expect(names.has("provider.step")).toBe(true)
    expect(names.has("context.assemble_step")).toBe(true)
    expect(names.has("transcript.write")).toBe(true)
  })
})

describe("Phase 8 profiling — replay invisibility", () => {
  test("removing profile.span events does not change message projection (tool turn)", async () => {
    const profiled = await runScript({ profile: true, steps: TOOL_SCRIPT })
    expect(spans(profiled).length).toBeGreaterThan(0)
    expect(messagesFromEvents(profiled)).toEqual(messagesFromEvents(stripSpans(profiled)))
    expect(replayProviderMessages(profiled)).toEqual(replayProviderMessages(stripSpans(profiled)))
  })

  test("profiled and non-profiled runs of the same script replay identically", async () => {
    const profiled = await runScript({ profile: true, steps: TOOL_SCRIPT })
    const clean = await runScript({ profile: false, steps: TOOL_SCRIPT })
    expect(replayProviderMessages(profiled)).toEqual(replayProviderMessages(clean))
  })

  test("a profile.span between assistant.message and its tool.result keeps pairing valid", async () => {
    const clean = await runScript({ profile: false, steps: TOOL_SCRIPT })
    const resultIndex = clean.findIndex((event) => event.type === "tool.result")
    expect(resultIndex).toBeGreaterThan(0)
    const injected = [...clean]
    injected.splice(resultIndex, 0, syntheticSpan(clean[0].sessionId))
    // Must not throw, and must reconstruct the same messages as the clean transcript.
    expect(messagesFromEvents(injected)).toEqual(messagesFromEvents(clean))
    expect(replayProviderMessages(injected)).toEqual(replayProviderMessages(clean))
  })

  test("profile spans around a successful compact checkpoint do not change recovery", async () => {
    const profiled = await runScript({ profile: true, steps: COMPACT_SCRIPT, doCompact: true })
    const clean = await runScript({ profile: false, steps: COMPACT_SCRIPT, doCompact: true })
    // Confirm a successful compact checkpoint actually exists.
    expect(
      clean.some((event) => event.type === "compact.ended" && (event as { status?: string }).status === "succeeded"),
    ).toBe(true)
    expect(spans(profiled).length).toBeGreaterThan(0)
    expect(messagesFromEvents(profiled)).toEqual(messagesFromEvents(clean))
    expect(replayProviderMessages(profiled)).toEqual(replayProviderMessages(clean))

    // Explicitly inject spans immediately before and after compact.ended.
    const endedIndex = clean.findIndex((event) => event.type === "compact.ended")
    const injected = [...clean]
    injected.splice(endedIndex + 1, 0, syntheticSpan(clean[0].sessionId))
    injected.splice(endedIndex, 0, syntheticSpan(clean[0].sessionId))
    expect(messagesFromEvents(injected)).toEqual(messagesFromEvents(clean))
  })
})

describe("Phase 8 profiling — provider usage counters", () => {
  test("bounded usage/cache counters are captured on the provider.step span", async () => {
    const events = await runScript({
      profile: true,
      steps: [
        {
          message: assistant("a1", "done"),
          usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cacheReadInputTokens: 1000 },
        },
      ],
    })
    const providerSpan = spans(events).find((span) => span.name === "provider.step")
    expect(providerSpan).toBeDefined()
    expect(providerSpan?.attributes?.inputTokens).toBe(1200)
    expect(providerSpan?.attributes?.outputTokens).toBe(34)
    expect(providerSpan?.attributes?.cacheReadInputTokens).toBe(1000)
  })
})

describe("Phase 8 profiling — bounded metadata", () => {
  test("boundAttributes clamps key/value bytes and attribute count", () => {
    const attrs: Record<string, string | number | boolean | null> = {}
    for (let i = 0; i < 40; i++) attrs[`k${i}`] = i
    attrs[`${"K".repeat(200)}`] = "x"
    attrs.longValue = "v".repeat(1000)
    const bounded = boundAttributes(attrs)
    expect(Object.keys(bounded).length).toBeLessThanOrEqual(MAX_ATTRIBUTES_PER_SPAN)
    for (const [key, value] of Object.entries(bounded)) {
      expect(Buffer.byteLength(key, "utf8")).toBeLessThanOrEqual(MAX_ATTRIBUTE_KEY_BYTES)
      if (typeof value === "string") {
        expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(MAX_ATTRIBUTE_STRING_BYTES)
      }
    }
  })

  test("emitted spans carry only bounded primitive attributes and no prompt text", async () => {
    const events = await runScript({ profile: true, steps: TOOL_SCRIPT })
    for (const span of spans(events)) {
      const attrs = span.attributes ?? {}
      expect(Object.keys(attrs).length).toBeLessThanOrEqual(MAX_ATTRIBUTES_PER_SPAN)
      for (const [key, value] of Object.entries(attrs)) {
        expect(Buffer.byteLength(key, "utf8")).toBeLessThanOrEqual(MAX_ATTRIBUTE_KEY_BYTES)
        const kind = value === null ? "null" : typeof value
        expect(["string", "number", "boolean", "null"]).toContain(kind)
        if (typeof value === "string") {
          expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(MAX_ATTRIBUTE_STRING_BYTES)
        }
      }
      // No model-visible content leaks into spans.
      expect(JSON.stringify(span)).not.toContain("hello-secret-prompt")
    }
  })
})

describe("Phase 8 profiling — fatal transcript write semantics", () => {
  test("a failing transcript write for a profile.span is fatal", async () => {
    const transcript = new MemoryTranscriptSink("profile.span")
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    // The first profile.span (startup.context) is emitted during start(); the sink
    // rejects it, and that failure must surface as a fatal TranscriptWriteError
    // rather than being swallowed. Non-profile events (session.started) write fine.
    await expect(
      AgentSession.create({
        id: "s1",
        cwd: "/workspace",
        provider,
        toolRuntime: new FakeToolRuntime(),
        transcript,
        profile: true,
        profilerNow: counterClock(),
      }),
    ).rejects.toThrow(TranscriptWriteError)
    expect(transcript.events.some((event) => (event as SessionEvent).type === "session.started")).toBe(true)
  })
})

describe("Phase 8 profiling — tool runtime spans", () => {
  test("RealToolRuntime emits tool.batch and tool.execute spans via the ctx profiler", async () => {
    const registry = new ToolRegistry()
    registry.register(probeTool("probe"))
    const runtime = new RealToolRuntime({
      registry,
      workspace: await WorkspaceFs.create(await tempDir()),
    })
    const drafts: Extract<SessionEvent, { type: "profile.span" }>[] = []
    const profiler = createProfiler({
      enabled: true,
      now: counterClock(),
      emit: async (event) => {
        drafts.push(event as Extract<SessionEvent, { type: "profile.span" }>)
      },
    })
    const ctx: ToolContext = { sessionId: "s1", turnId: "t1", stepId: "step1", signal: new AbortController().signal, profiler }
    const results = await runtime.runBatch([call("c1", "probe", {})], ctx)

    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(false)
    const names = drafts.map((draft) => draft.name)
    expect(names).toContain("tool.batch")
    expect(names).toContain("tool.execute")
    const execSpan = drafts.find((draft) => draft.name === "tool.execute")
    expect(execSpan?.attributes?.toolName).toBe("probe")
    expect(execSpan?.attributes?.readOnly).toBe(true)
  })

  test("NOOP profiler in tool ctx emits nothing and preserves results", async () => {
    const registry = new ToolRegistry()
    registry.register(probeTool("probe"))
    const runtime = new RealToolRuntime({ registry, workspace: await WorkspaceFs.create(await tempDir()) })
    const ctx: ToolContext = {
      sessionId: "s1",
      turnId: "t1",
      stepId: "step1",
      signal: new AbortController().signal,
      profiler: NOOP_PROFILER,
    }
    const results = await runtime.runBatch([call("c1", "probe", {})], ctx)
    expect(results[0]?.isError).toBe(false)
  })
})

describe("Phase 8 profiling — coarse coverage (approval / compact / startup)", () => {
  test("every profiled session emits a startup.context span", async () => {
    const events = await runScript({ profile: true, steps: TOOL_SCRIPT })
    expect(spans(events).map((span) => span.name)).toContain("startup.context")
  })

  test("compaction emits compact.run + compact.provider_summary spans and the reducer reports duration", async () => {
    const events = await runScript({ profile: true, steps: COMPACT_SCRIPT, doCompact: true })
    const names = spans(events).map((span) => span.name)
    expect(names).toContain("compact.run")
    expect(names).toContain("compact.provider_summary")
    const report = summarizeProfile(events as unknown as Record<string, unknown>[])
    expect(report.compact.count).toBeGreaterThanOrEqual(1)
    expect(report.compact.durationMs).not.toBeNull()
  })

  test("approval.wait span records the decision when a tool needs approval", async () => {
    const registry = new ToolRegistry()
    registry.register({ ...probeTool("mcp__test__probe"), readOnly: false })
    const runtime = new RealToolRuntime({ registry, workspace: await WorkspaceFs.create(await tempDir()) })
    const { profiler, drafts } = recordingProfiler()
    const ctx: ToolContext = {
      sessionId: "s1",
      turnId: "t1",
      stepId: "step1",
      signal: new AbortController().signal,
      profiler,
      approvals: { request: async () => "allow" as const },
    }
    const results = await runtime.runBatch([call("c1", "mcp__test__probe", {})], ctx)

    expect(results[0]?.isError).toBe(false)
    const waitSpan = drafts.find((draft) => draft.name === "approval.wait")
    expect(waitSpan).toBeDefined()
    expect(waitSpan?.status).toBe("ok")
    expect(waitSpan?.attributes?.decision).toBe("allow")
  })

  test("approval.wait span reflects a denied decision", async () => {
    const registry = new ToolRegistry()
    registry.register({ ...probeTool("mcp__test__probe"), readOnly: false })
    const runtime = new RealToolRuntime({ registry, workspace: await WorkspaceFs.create(await tempDir()) })
    const { profiler, drafts } = recordingProfiler()
    const ctx: ToolContext = {
      sessionId: "s1",
      turnId: "t1",
      stepId: "step1",
      signal: new AbortController().signal,
      profiler,
      approvals: { request: async () => "deny" as const },
    }
    const results = await runtime.runBatch([call("c1", "mcp__test__probe", {})], ctx)

    expect(results[0]?.isError).toBe(true)
    const waitSpan = drafts.find((draft) => draft.name === "approval.wait")
    expect(waitSpan?.status).toBe("denied")
    expect(waitSpan?.attributes?.decision).toBe("deny")
  })
})

describe("Phase 8 profiling — offline reducer", () => {
  test("report from a profiled transcript matches the published schema", async () => {
    const events = await runScript({ profile: true, steps: TOOL_SCRIPT })
    const report = summarizeProfile(events as unknown as Record<string, unknown>[], {
      sourceTranscript: "/tmp/session.jsonl",
      generatedAt: "2026-06-02T00:00:00.000Z",
    })
    const schema = JSON.parse(await readFile(resolve("profiling/schema/profile-report.schema.json"), "utf8"))
    expect(validateAgainstSchema(report, schema)).toEqual([])
    expect(report.schemaVersion).toBe(PROFILE_REPORT_SCHEMA_VERSION)
    expect(report.provider.callCount).toBeGreaterThan(0)
    expect(report.transcriptWrite.writeCount).toBeGreaterThan(0)
    expect(report.summary.profileSpanCount).toBeGreaterThan(0)
  })

  test("reducer is pure over events and renders without provider/tool access", async () => {
    const events = (await runScript({ profile: true, steps: TOOL_SCRIPT })) as unknown as Record<string, unknown>[]
    const first = summarizeProfile(events)
    const second = summarizeProfile(events)
    expect(first).toEqual(second)
    expect(renderText(first)).toContain("Profile report")
    expect(() => JSON.parse(renderJson(first))).not.toThrow()
  })

  test("a transcript without profile spans yields a schema-valid report with a warning", async () => {
    const events = (await runScript({ profile: false, steps: TOOL_SCRIPT })) as unknown as Record<string, unknown>[]
    const report = summarizeProfile(events)
    const schema = JSON.parse(await readFile(resolve("profiling/schema/profile-report.schema.json"), "utf8"))
    expect(validateAgainstSchema(report, schema)).toEqual([])
    expect(report.summary.profileSpanCount).toBe(0)
    expect(report.warnings.some((warning) => warning.includes("no profile.span"))).toBe(true)
  })
})

function syntheticSpan(sessionId: string): SessionEvent {
  return {
    seq: 9999,
    timestamp: "2026-06-02T00:00:00.000Z",
    sessionId,
    type: "profile.span",
    spanId: "synthetic_1",
    name: "synthetic",
    category: "tool",
    status: "ok",
    startMs: 0,
    durationMs: 1,
    attributes: {},
  }
}

function recordingProfiler(): {
  profiler: ReturnType<typeof createProfiler>
  drafts: Extract<SessionEvent, { type: "profile.span" }>[]
} {
  const drafts: Extract<SessionEvent, { type: "profile.span" }>[] = []
  const profiler = createProfiler({
    enabled: true,
    now: counterClock(),
    emit: async (event) => {
      drafts.push(event as Extract<SessionEvent, { type: "profile.span" }>)
    },
  })
  return { profiler, drafts }
}

function probeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    readOnly: true,
    inputSchema: { type: "object", additionalProperties: true },
    parse(input) {
      return input
    },
    async execute() {
      return { content: `ok:${name}` }
    },
  }
}

async function tempDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  return mkdtemp(join(tmpdir(), "light-cc-phase8-"))
}
