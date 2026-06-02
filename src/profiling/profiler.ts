import type {
  ProfileSpanAttributeValue,
  ProfileSpanCategory,
  ProfileSpanStatus,
  SessionEventDraft,
} from "../core/events"

// Thin, opt-in profiling instrumentation. When disabled the profiler is a strict
// no-op: it allocates nothing, calls no clock, and emits no `profile.span` events,
// so transcript size and replay behavior are identical to a non-profiled run.
//
// This file is intentionally the only profiling code allowed inside `src/`: it is
// the no-op-capable interface plus the minimal span-emit plumbing. Aggregation,
// reduction, and report rendering live under the top-level `profiling/` tool.

export type ProfileAttributes = Record<string, ProfileSpanAttributeValue>

export interface ProfileSpanHandle {
  readonly spanId: string
  /** Record elapsed-since-span-start (ms) under `name` as a bounded attribute. */
  mark(name: string): void
  setAttributes(attrs: ProfileAttributes): void
  /** Emit the completed span. A no-op handle resolves immediately. */
  end(status?: ProfileSpanStatus, attrs?: ProfileAttributes): Promise<void>
}

export interface Profiler {
  readonly enabled: boolean
  /** Monotonic clock in milliseconds. Callers should guard expensive work with `enabled`. */
  now(): number
  startSpan(
    name: string,
    category: ProfileSpanCategory,
    attrs?: ProfileAttributes,
    parentSpanId?: string,
  ): ProfileSpanHandle
  /** Accumulate one transcript write's cost. Profiler-span writes are tracked separately as overhead. */
  recordTranscriptWrite(eventType: string, bytes: number, durationMs: number): void
  /** Emit the aggregated `transcript.write` span (including profiler self-overhead). */
  flushTranscriptWriteSpan(): Promise<void>
}

// Attribute caps from spec/phase-8.md §5. Profile data is durable and may be shared
// with other local tooling, so metadata must stay bounded.
export const MAX_ATTRIBUTES_PER_SPAN = 24
export const MAX_ATTRIBUTE_KEY_BYTES = 64
export const MAX_ATTRIBUTE_STRING_BYTES = 256

const NOOP_HANDLE: ProfileSpanHandle = {
  spanId: "",
  mark() {},
  setAttributes() {},
  async end() {},
}

export const NOOP_PROFILER: Profiler = {
  enabled: false,
  now() {
    return 0
  },
  startSpan() {
    return NOOP_HANDLE
  },
  recordTranscriptWrite() {},
  async flushTranscriptWriteSpan() {},
}

export type CreateProfilerOptions = {
  enabled: boolean
  emit: (event: SessionEventDraft) => Promise<void>
  now?: () => number
}

export function createProfiler(options: CreateProfilerOptions): Profiler {
  if (!options.enabled) return NOOP_PROFILER
  return new RecordingProfiler(options.emit, options.now ?? defaultClock)
}

function defaultClock(): number {
  return performance.now()
}

class RecordingProfiler implements Profiler {
  readonly enabled = true
  private spanCounter = 0
  private writeCount = 0
  private writeDurationMs = 0
  private writeMaxMs = 0
  private writeBytes = 0
  private profilerWriteCount = 0
  private profilerWriteDurationMs = 0

  constructor(
    private readonly emitEvent: (event: SessionEventDraft) => Promise<void>,
    private readonly clock: () => number,
  ) {}

  now(): number {
    return this.clock()
  }

  startSpan(
    name: string,
    category: ProfileSpanCategory,
    attrs?: ProfileAttributes,
    parentSpanId?: string,
  ): ProfileSpanHandle {
    const spanId = `span_${(this.spanCounter += 1)}`
    const startMs = this.clock()
    const collected: ProfileAttributes = { ...attrs }
    let ended = false
    const handle: ProfileSpanHandle = {
      spanId,
      mark: (markName: string) => {
        collected[markName] = round(this.clock() - startMs)
      },
      setAttributes: (next: ProfileAttributes) => {
        Object.assign(collected, next)
      },
      end: async (status: ProfileSpanStatus = "ok", endAttrs?: ProfileAttributes) => {
        if (ended) return
        ended = true
        if (endAttrs) Object.assign(collected, endAttrs)
        const durationMs = round(this.clock() - startMs)
        const draft: SessionEventDraft = {
          type: "profile.span",
          spanId,
          name,
          category,
          status,
          startMs: round(startMs),
          durationMs,
          ...(parentSpanId ? { parentSpanId } : {}),
          attributes: boundAttributes(collected),
        }
        await this.emitEvent(draft)
      },
    }
    return handle
  }

  recordTranscriptWrite(eventType: string, bytes: number, durationMs: number): void {
    if (eventType === "profile.span") {
      this.profilerWriteCount += 1
      this.profilerWriteDurationMs += durationMs
      return
    }
    this.writeCount += 1
    this.writeDurationMs += durationMs
    this.writeBytes += bytes
    if (durationMs > this.writeMaxMs) this.writeMaxMs = durationMs
  }

  async flushTranscriptWriteSpan(): Promise<void> {
    if (this.writeCount === 0) return
    const startMs = this.clock()
    const draft: SessionEventDraft = {
      type: "profile.span",
      spanId: `span_${(this.spanCounter += 1)}`,
      name: "transcript.write",
      category: "transcript",
      status: "ok",
      startMs: round(startMs),
      durationMs: round(this.writeDurationMs),
      attributes: boundAttributes({
        writeCount: this.writeCount,
        totalDurationMs: round(this.writeDurationMs),
        maxDurationMs: round(this.writeMaxMs),
        totalBytes: this.writeBytes,
        profilerSpanWriteCount: this.profilerWriteCount,
        profilerSpanWriteDurationMs: round(this.profilerWriteDurationMs),
      }),
    }
    await this.emitEvent(draft)
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// Enforce the spec/phase-8.md §5 bounds so durable profile data cannot grow
// unbounded or leak long strings. Numbers/booleans/null pass through; strings are
// clamped to a byte budget; only the first N attributes are kept.
export function boundAttributes(attrs: ProfileAttributes): ProfileAttributes {
  const out: ProfileAttributes = {}
  let count = 0
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    if (count >= MAX_ATTRIBUTES_PER_SPAN) break
    const boundedKey = clampBytes(key, MAX_ATTRIBUTE_KEY_BYTES)
    out[boundedKey] = typeof value === "string" ? clampBytes(value, MAX_ATTRIBUTE_STRING_BYTES) : value
    count += 1
  }
  return out
}

function clampBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  // Trim conservatively by characters until within the byte budget.
  let result = value
  while (result.length > 0 && Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1)
  }
  return result
}
