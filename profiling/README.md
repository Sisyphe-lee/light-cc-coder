# light-cc-coder profiling tool

[中文](README.zh-CN.md)

Local, offline performance/cost profiling for the coder runtime itself. This is a
**developer artifact**, not a benchmark, evaluation, leaderboard, or telemetry
system. It answers *"where did this session spend time and tokens?"* — startup,
context assembly, provider streaming, tools, approval, MCP, compaction, transcript
writes, runtime shell. It does **not** judge task quality or success; that is a
separate concern (see `docs/profiling-plan.md`).

The authoritative data-layer contract is [`spec/phase-8.md`](../spec/phase-8.md).

## Boundary

- `src/` owns the coder runtime. It contains only thin instrumentation: the
  `profile.span` event type, a no-op-capable `Profiler` interface
  (`src/profiling/profiler.ts`), and span-emit calls at coarse lifecycle
  boundaries.
- `profiling/` (this directory) owns the schema, reducer, renderers, and this
  README. **Normal, non-profiled runs never depend on this directory.** The
  `lightcc profile` command loads it via a dynamic import.
- The reducer consumes the stable JSONL/profile-event contract below. It does
  **not** import `src/` private types, so another harness emitting compatible
  spans can reuse it.

## Input contract

Input is one session transcript: newline-delimited JSON, one event object per
line. The reducer is defensive (unknown lines/types are ignored).

It primarily reads replay-invisible `profile.span` events:

```ts
{
  "type": "profile.span",
  "spanId": "span_12",            // session-local id, need not be globally unique
  "parentSpanId": "span_3",       // optional, diagnostic only
  "name": "provider.step",        // coarse lifecycle boundary
  "category": "provider",         // session|turn|step|startup|context|provider|
                                  // tool|permission|approval|runtime|mcp|hook|
                                  // compact|transcript
  "status": "ok",                 // ok|error|timeout|aborted|denied|skipped
  "startMs": 1234.5,              // monotonic clock (performance.now()), NOT wall clock
  "durationMs": 87.2,             // monotonic elapsed
  "attributes": { "firstTokenMs": 40, "inputTokens": 1200 }
}
```

`startMs`/`durationMs` come from a monotonic clock. Durations are never computed
from wall-clock `timestamp`s.

It also enriches the summary from existing replay-invisible diagnostics already in
the transcript: `context.step`, `bash.observation`, `permission.decision`,
`approval.requested` / `approval.responded`, `provider.retry` / `provider.failure`,
`compact.started` / `compact.ended`, `mcp.server.*`, and `tool.call`.

## Output contract

Stable, versioned JSON defined by
[`schema/profile-report.schema.json`](./schema/profile-report.schema.json)
(`schemaVersion: 1`). It includes category totals, top slow spans, provider
TTFT/stream/retry/token/cache counters, context assembly cost, per-tool stats,
runtime/bash stats, approval/MCP/compact summaries, transcript-write overhead
(including the profiler's own write overhead), and warnings.

The report contains **timing and bounded counts only**. It never contains
model-visible content, tool output, file contents, or credentials.

## Usage

```bash
# Record (opt-in): writes profile.span events into the session transcript.
lightcc -p "..." --profile
LIGHTCC_PROFILE=1 lightcc -p "..."

# Summarize offline (no provider call, no tools, no workspace write, no mutation):
lightcc profile <transcript.jsonl>           # human summary
lightcc profile <transcript.jsonl> --json    # stable JSON report
lightcc profile <transcript.jsonl> --out report.json
```

Programmatic:

```ts
import { summarizeProfile, renderText, renderJson } from "../profiling"
const events = transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line))
const report = summarizeProfile(events, { sourceTranscript: path, generatedAt: iso })
console.log(renderText(report))
```

## Developer compareReports

`compareReports` is a **developer-only** Stage 1 helper (not a product CLI surface, not
a benchmark) that diffs two single-run `ProfileReport` JSON objects to catch obvious
harness regressions. It consumes only the stable report fields above — it never
re-parses a transcript.

```ts
import { compareReports, renderComparison } from "../profiling"

const comparison = compareReports({ baseline, current }) // both schemaVersion: 1
console.log(renderComparison(comparison))
if (comparison.status === "fail") process.exitCode = 1
```

It ignores `sourceTranscript`, `generatedAt`, and concrete `spanId`s. Malformed or
unsupported reports yield a `fail` comparison with reasons rather than throwing. Output
is JSON-serializable:

```ts
{
  schemaVersion: 1,
  status: "pass" | "warn" | "fail",
  checks: [{ metric, severity, baseline, current, ratio?, deltaMs?, threshold?, reason }],
  summary: { failed, warned, passed, topRegressions },
  diagnostics?: { topSlowSpans }   // present only when a regression is reported
}
```

Two kinds of checks:

- **Strict invariants** (exact equality; a mismatch is a `fail`) — deterministic because
  `FakeProvider` scripts pin the harness path: `session.turnCount`, `session.stepCount`,
  `provider.callCount`, scripted provider usage counters, `context.assembleCount`, tool
  counts by `toolName`, `runtime.bashCount`, `compact.count`, `mcp.toolCallCount`, and a
  missing-profile-data check (current has no spans while baseline did → fail).
- **Coarse performance checks** (ratio + absolute delta with a `minComparableMs` floor) on
  aggregate duration fields only. Deterministic model output does **not** make fsync, shell
  startup, MCP process startup, or profiler overhead deterministic, so there are no
  millisecond-level assertions. Defaults: `minComparableMs 25`, `warnRatio 1.5`,
  `failRatio 2.0`, `minWarnDeltaMs 50`, `minFailDeltaMs 100`. `runtime` and `transcriptWrite`
  use a wider `failRatio 3.0`. Metrics below `minComparableMs` are reported as `info` and do
  not gate. Context token size uses a count delta (`warnRatio 1.25` and ≥ 500 token growth →
  warn only). `topSlowSpans` is diagnostic only and never gates.

Thresholds are configurable per bucket via `compareReports({ baseline, current, thresholds })`.

The deterministic Stage 1 scenarios that produce comparable reports live in
`test/profiling/` (`startup_noop`, `readonly_search_batch`, `edit_verify`, `auto_compact`).
They use a counter clock so the report shape is reproducible. See
[`spec/phase-8-stage-1.md`](../spec/phase-8-stage-1.md) for the full contract.

## Optional live N-run

`profiling/liveRuns/` is an **optional** Stage 2 developer dogfood tool (Regime B:
real provider/network). It is **not** a benchmark, evaluation, leaderboard, or CI
gate, and `src/` never depends on it. It runs one prompt/scenario N times, each as
a real profiled session, then aggregates the existing single-run `ProfileReport`
artifacts into a separately-versioned `live-runs.summary.json`.

```bash
# Real provider: N serial runs, warmup excluded from the aggregate.
bun profiling/liveRuns/runner.ts --scenario pong --runs 7 --warmup 1 \
  --model "$MODEL" --base-url "$BASE_URL" --api-key-env API_KEY_ENV \
  --cwd "$PWD" --out-dir /tmp/lr

# Smoke (no real provider): routes the CLI through FakeProvider.
bun profiling/liveRuns/runner.ts --scenario pong --fake --runs 2 --warmup 1 \
  --cwd "$PWD" --out-dir /tmp/lr
```

Each run spawns the existing CLI (`lightcc -p <prompt> --profile --transcript ...`),
writes its own transcript, and is reduced with the offline reducer above into one
single-run report. The aggregate reports median/min/max/IQR for observed duration,
category totals, provider TTFT/stream/token/cache, context, per-tool, runtime/bash,
compact, and transcript-write costs, plus top-bottleneck frequency, run accounting
(included/warmup/skipped/failed), and warnings for missing/malformed reports.

It runs serially by default so provider rate limits and prompt-cache behavior are
not distorted. **It does not gate** — live runs carry provider/network noise,
prompt-cache variability, and model nondeterminism, so even N-run medians rank
bottlenecks rather than assert regressions. The aggregate schema is versioned
independently and never mutates the single-run `ProfileReport` schema. See
[`spec/phase-8-stage-2.md`](../spec/phase-8-stage-2.md) for the full contract.

## Privacy red lines

Profile data is durable and may be shared with other local tooling, so it is
strictly bounded. The runtime instrumentation and this reducer must **never**
record:

- prompt text, system instructions, or assistant text;
- tool arguments that may contain user data, tool result content;
- shell stdout/stderr, file contents, raw diffs;
- API keys, environment values, credentials;
- raw provider request/response bodies;
- MCP arguments or MCP result content.

Allowed attributes are ids, names, counts, hashes, statuses, booleans, and bounded
durations. Caps (enforced in `src/profiling/profiler.ts`): ≤24 attributes/span,
≤64-byte keys, ≤256-byte string values.

## Emitting compatible spans from another harness

This is an interface-hygiene goal, not a commitment to support other harnesses in
Phase 8. To reuse this reducer, a harness should emit, into a JSONL transcript,
`profile.span` events matching the input contract above:

- use a monotonic clock for `startMs`/`durationMs`;
- emit completed spans only (no separate started/ended pair);
- keep attributes bounded and free of the forbidden classes above;
- prefer the documented `category` and attribute names so the report fields
  populate (e.g. `provider.step` with `firstTokenMs`, `inputTokens`,
  `cacheReadInputTokens`; `tool.execute` with `toolName`).

Spans the reducer does not recognize still contribute to category totals and top
slow spans, so partial adoption degrades gracefully.
