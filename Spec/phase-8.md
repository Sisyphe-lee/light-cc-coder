# Phase 8 Spec: Profiling / Performance Observability

Status: planned.

Phase 8 adds local performance observability for the coder runtime itself. It is
not an evaluation, benchmark, telemetry, or product-monitoring phase.

The goal is narrow: given one session transcript, a developer should be able to
tell whether the bottleneck was startup, context assembly, provider streaming,
tool execution, approval wait, MCP, compaction, transcript writes, or runtime
shell execution.

Profiling data must stay local, bounded, and replay-safe. It must not enter
model-visible history.

## 1. Design Principles

- Profiling is for system bottleneck diagnosis, not task quality scoring.
- Normal coder behavior must not depend on profiling being enabled.
- The profiling subsystem should live outside the core `src/` tree as much as
  practical.
- Existing runtime paths may contain thin instrumentation hooks, but they should
  not contain report generation, aggregation, visualization, or export logic.
- Profiling records timing and metadata, not prompt text, tool output, stdout,
  stderr, file contents, API keys, environment values, or raw provider payloads.
- Profiling output is a developer artifact that other local tooling can consume.
- First-class output is stable JSON. YAML, OTLP, and trace-viewer exports are
  optional adapters, not the Phase 8 core.

## 2. Directory Boundary

Phase 8 should introduce a top-level profiling area, separate from the coder
runtime implementation:

```text
profiling/
  schema/
    profile-report.schema.json
  report/
    summarize.ts
    renderText.ts
    renderJson.ts
  export/
    chromeTrace.ts        # optional, if implemented in Phase 8
  README.md              # optional developer-facing format notes
```

The exact filenames may change during implementation, but the ownership boundary
should not:

- `src/` owns the coder runtime, session state, tool execution, context
  assembly, provider streaming, and transcript writing.
- `profiling/` owns profile event schemas, local reduction, report formatting,
  and export adapters.
- Shared types may be imported deliberately, but profiling code should not
  become a dependency that is required for normal non-profiled execution.

Allowed `src/` changes:

- add a `profile.span` event type;
- add a small no-op-capable profiler interface;
- pass an optional profiler or span emitter through existing boundaries;
- add thin instrumentation calls around existing lifecycle boundaries.

Not allowed in `src/`:

- profile report aggregation;
- JSON/YAML/Perfetto/OTLP export logic;
- cost dashboard logic;
- benchmark or evaluation logic;
- provider-specific trace viewer integration.

## 3. Activation Model

Profiling should be opt-in for normal runs.

Possible activation surfaces:

```bash
lightcc -p "..." --profile --profile-out /tmp/profile.report.json
lightcc profile /path/to/session.jsonl --out /tmp/profile.report.json
LIGHTCC_PROFILE=1 lightcc -p "..."
```

Implementation may choose a smaller first surface, but these invariants hold:

- When profiling is disabled, instrumentation must be a no-op.
- When profiling is disabled, no `profile.span` events should be written.
- When profiling is disabled, transcript size and replay behavior are unchanged.
- When profiling is enabled, `profile.span` is still replay-invisible.
- Running `lightcc profile <transcript>` must not make a model request, resume a
  session, mutate the transcript, or require the original workspace to be
  writable.

## 4. Profile Span Event

Phase 8 adds one replay-invisible diagnostic event:

```ts
type ProfileSpanEvent = EventBase & {
  type: "profile.span"
  spanId: string
  parentSpanId?: string
  name: string
  category:
    | "session"
    | "turn"
    | "step"
    | "startup"
    | "context"
    | "provider"
    | "tool"
    | "permission"
    | "approval"
    | "runtime"
    | "mcp"
    | "hook"
    | "compact"
    | "transcript"
  status: "ok" | "error" | "timeout" | "aborted" | "denied" | "skipped"
  startMs: number
  durationMs: number
  attributes?: Record<string, string | number | boolean | null>
}
```

Notes:

- `startMs` and `durationMs` are monotonic timings from `performance.now()` or
  an equivalent monotonic clock.
- The existing ISO `timestamp` on `EventBase` remains useful for ordering and
  human debugging, but profile summaries must not compute durations from wall
  clock timestamps.
- Emit completed spans only. Do not add separate `profile.span.started` and
  `profile.span.ended` events in Phase 8.
- `spanId` may be a session-local deterministic counter. It does not need to be
  globally unique.
- `parentSpanId` is diagnostic only. Replay must not depend on span hierarchy.
- Attribute names should be stable enough for downstream tooling.

## 5. Attribute Limits

Profile data is durable and may be shared with other local tooling, so metadata
must be bounded.

Recommended caps:

- max attributes per span: 24;
- max key length: 64 bytes;
- max string value length: 256 bytes;
- max serialized span event size: 4 KiB by default;
- provider/tool spans may allow up to 8 KiB if needed for bounded counters.

Allowed attribute classes:

- ids: `turnId`, `stepId`, `toolCallId`, `spanId`;
- names: `toolName`, `model`, `provider`, `serverName`;
- counts: message count, tool count, retry count, byte count, token count;
- hashes: `toolSchemaHash`, request/context hash;
- statuses: decision, status reason, finish reason, failure class;
- booleans: `readOnly`, `truncated`, `artifactCreated`, `timedOut`;
- bounded durations: first-token latency, retry delay, wait time.

Forbidden attributes:

- prompt text;
- system instructions text;
- assistant text;
- tool arguments when they may contain user data;
- tool result content;
- shell command stdout/stderr;
- file contents;
- raw diffs;
- API keys, env values, credentials;
- raw provider request or response bodies;
- MCP arguments or MCP result content.

Shell command text is already present in existing `bash.observation` diagnostics.
Phase 8 should avoid duplicating it in profile spans.

## 6. Span Names

Phase 8 should instrument coarse lifecycle boundaries that answer "where did the
session spend time?" It should not trace every helper function.

Suggested first-pass span names:

```text
startup.extensions
startup.skills
startup.mcp
context.prepare_provider_request
context.assemble_step
context.history_projection
context.token_estimate
context.tool_schema_hash
provider.step
provider.stream
provider.retry_wait
tool.batch
tool.preflight
tool.permission
approval.wait
tool.execute
tool.normalize
hook.user_prompt_submit
hook.pre_tool
hook.post_tool
hook.stop
runtime.execute_shell
mcp.start_server
mcp.initialize
mcp.tools_list
mcp.tool_call
compact.run
compact.provider_summary
transcript.write
```

The implementation may merge spans when the code boundary makes separate
measurement noisy or redundant.

## 7. Startup Metrics

Startup profiling should explain time spent before the first useful turn:

- session creation;
- config resolution when Phase 7 config exists;
- skills loading and activation;
- MCP server startup;
- MCP initialize and tools/list;
- context session initialization;
- provider readiness checks if any exist.

Attributes:

- `skillCount`;
- `mcpServerCount`;
- `mcpReadyCount`;
- `mcpFailedCount`;
- `toolCount`;
- `configHash` when already available and redacted.

## 8. Context Metrics

Context profiling should explain context assembly cost and size:

- provider request preparation;
- history projection;
- tool schema hashing;
- token estimation;
- compact slot handling;
- context step diagnostic write.

Attributes:

- `estimatedTokens`;
- `providerMessageCount`;
- `prefixMessageCount`;
- `historyMessageCount`;
- `sourceCount`;
- `toolSchemaHash`;
- `toolSchemaChanged`;
- `historySnippedToolResults`;
- `historySnippedBytes`;
- `compactActive`.

Existing `context.step` diagnostics remain the detailed context snapshot.
Profile spans should reference counts and hashes, not duplicate the full
snapshot.

## 9. Provider Metrics

Provider profiling should explain model-side and adapter-side latency:

- request start;
- time to first text or tool-call delta;
- total stream duration;
- retry attempts;
- retry wait time;
- context-overflow retry path;
- final failure class;
- usage and cache counters when available.

Attributes:

- `model`;
- `attempt`;
- `retryCount`;
- `retryDelayMs`;
- `failureClass`;
- `statusCode`;
- `finishReason`;
- `textDeltaCount`;
- `textBytes`;
- `toolCallCount`;
- `firstTokenMs`;
- `streamMs`;
- `inputTokens`;
- `outputTokens`;
- `cacheReadInputTokens`;
- `cacheWriteInputTokens`;
- `costKnown`.

Phase 8 must not implement model routing, provider fallback, automatic retry
tuning, or cost optimization.

## 10. Tool / Permission / Approval Metrics

Tool profiling should explain tool lifecycle cost without changing scheduling:

- batch preflight;
- batch scheduling mode;
- per-tool parse/preflight;
- permission decision;
- approval wait;
- pre-tool hooks;
- execution;
- output normalization;
- artifact/truncation;
- post-tool hooks.

Attributes:

- `batchSize`;
- `readOnlyCount`;
- `writerCount`;
- `mode`: `parallel_readonly` or `serial`;
- `toolName`;
- `toolCallId`;
- `readOnly`;
- `decision`;
- `permissionMode`;
- `resultBytes`;
- `isError`;
- `errorKind`;
- `truncated`;
- `artifactCreated`.

Phase 8 may record scheduler-shaped facts, but it must not implement
resource-aware scheduling or optimization.

## 11. Runtime / Bash Metrics

The existing `bash.observation` event already records command duration, exit
status, timeout state, byte counts, and truncation state.

Phase 8 should either:

- summarize `bash.observation` directly; or
- add a generic `runtime.execute_shell` span with only bounded metadata.

Do not duplicate stdout/stderr or command output in profile spans.

Useful attributes:

- `exitCode`;
- `timedOut`;
- `stdoutBytes`;
- `stderrBytes`;
- `stdoutTruncated`;
- `stderrTruncated`;
- `durationMs`.

## 12. MCP Metrics

MCP profiling should explain startup and tool-call latency:

- server process startup;
- initialize request;
- tools/list request;
- tool call request;
- timeout;
- stderr preview byte count.

Attributes:

- `serverName`;
- `toolName`;
- `timeoutMs`;
- `status`;
- `stderrBytes`;
- `toolCount`;
- `configHash`.

Do not record MCP arguments or result content in profile spans.

## 13. Compact Metrics

Compact profiling should explain compaction cost and effect:

- trigger: manual, auto, overflow retry;
- pre-compact token estimate;
- pairing-safe tail selection;
- compact prompt build;
- provider summary call;
- summary checkpoint write;
- post-compact token estimate;
- failures and retry behavior.

Attributes:

- `trigger`;
- `preCompactEstimatedTokens`;
- `postCompactEstimatedTokens`;
- `summarizedMessageCount`;
- `keptMessageCount`;
- `omittedOldestGroups`;
- `status`;
- `failureClass`.

Compact spans must not affect compact checkpoint replay semantics.

## 14. Transcript Write Metrics

Transcript write overhead can be on the critical path and should be measurable.

Phase 8 may wrap transcript writes with `transcript.write` spans.

Attributes:

- `eventType`;
- `bytes`;
- `status`.

Current project invariant remains: transcript write failure is fatal. If
`profile.span` is emitted through the transcript sink, failure to write it is
fatal too. Do not introduce best-effort side channels in Phase 8 unless the
project explicitly revisits transcript durability semantics.

## 15. Replay Safety

`profile.span` must be replay-invisible.

`replayProviderMessages()` and message projection must ignore profile events.
Adding or removing `profile.span` events from a transcript must not change:

- model-visible provider messages;
- internal message projection;
- tool/result pairing validation;
- compact checkpoint recovery;
- active history after replay.

Profile spans should not be used as state restoration inputs.

## 16. Profile Report Command

Phase 8 should add a local profile summary command:

```bash
lightcc profile <transcript>
lightcc profile <transcript> --out profile.report.json
lightcc profile <transcript> --json
```

If the Phase 7 `lightcc` bin is not available yet, the first implementation may
use the current CLI entry name. The command semantics are more important than
the exact binary name.

The command:

- reads one JSONL transcript;
- does not call a provider;
- does not execute tools;
- does not require workspace write access;
- does not mutate the transcript;
- can run even if the original session is no longer active;
- emits a human-readable summary by default;
- can emit stable JSON for other tooling.

The reducer should primarily consume `profile.span` events and may enrich the
summary with existing replay-invisible diagnostics:

- `context.step`;
- `bash.observation`;
- `tool.artifact`;
- `approval.requested` / `approval.responded`;
- `compact.started` / `compact.ended`;
- `mcp.server.*`;
- `error`.

## 17. JSON Report Artifact

The stable machine-readable output is a versioned JSON report. This is intended
for local developers and for separate evaluation tooling that wants to correlate
runtime costs with task outcomes without parsing the raw session transcript.

Example shape:

```json
{
  "schemaVersion": 1,
  "sourceTranscript": "/path/to/session.jsonl",
  "generatedAt": "2026-06-01T00:00:00.000Z",
  "session": {
    "sessionId": "session_123",
    "cwd": "/workspace",
    "turnCount": 2,
    "stepCount": 5
  },
  "summary": {
    "observedDurationMs": 12345,
    "profileSpanCount": 120,
    "topBottleneck": "provider"
  },
  "categoryTotals": [],
  "topSlowSpans": [],
  "provider": {},
  "context": {},
  "tools": [],
  "approval": {},
  "runtime": {},
  "mcp": {},
  "compact": {},
  "transcriptWrite": {},
  "warnings": []
}
```

`profiling/schema/profile-report.schema.json` should define the report contract.
The schema should be stable enough for another local evaluation project to
consume.

The report must not include model-visible content, tool outputs, file contents,
or credentials.

## 18. Summary Contents

The human summary and JSON report should include:

- total observed profiled duration;
- top slow spans;
- category totals by inclusive duration;
- optional best-effort self time when parent links are valid;
- provider call count, total duration, first-token p50/max, stream p50/max;
- provider retry count and failure classes;
- provider usage tokens and cache token counters when available;
- context assembly time and max token estimate;
- compact count, duration, and pre/post token estimates;
- tool count by tool name;
- tool duration p50/max and error/denied/timeout counts;
- approval wait total and max;
- MCP startup and tool-call latency;
- bash/runtime duration, nonzero exits, timeouts, truncation counts;
- transcript write count, bytes, and duration;
- warnings for malformed spans, missing parent spans, or transcripts without
  profiling data.

`topBottleneck` should be a small local heuristic based on category totals and
slowest spans. It should not claim task quality causes or prescribe automatic
optimization.

## 19. Optional Trace Viewer Export

Phase 8 may add an optional export from profile spans to Chrome Trace JSON:

```bash
lightcc profile <transcript> --chrome-trace > trace.json
```

This is useful because Chrome Trace JSON can be opened by local timeline viewers
such as Perfetto.

This export is optional. It must be derived from local transcript data and must
not become a required runtime dependency.

OTLP, OpenTelemetry SDK integration, Phoenix, Langfuse, LangSmith, OpenLIT, or
other tracing backends are later optional adapters. Phase 8 should not require
or configure any telemetry upload.

## 20. Non-Goals

Phase 8 must not implement:

- task success evaluation;
- model capability measurement;
- benchmark harnesses;
- leaderboards;
- golden dataset evaluation;
- automatic model routing;
- automatic performance optimization;
- resource-aware scheduler changes;
- provider fallback;
- production telemetry upload;
- hosted dashboard integration;
- live TUI cost/status panels;
- `doctor`, `status`, `export`, `/usage`, or `/cost` product commands unless
  separately pulled into Phase 7;
- raw prompt/provider payload capture;
- trace grading or LLM-as-judge scoring.

## 21. Tests

Phase 8 should include tests for:

- `profile.span` events are ignored by `replayProviderMessages()`;
- replay is identical with and without synthetic profile spans;
- profile spans around assistant/tool-result boundaries do not break pairing
  validation;
- profile spans before and after successful compact checkpoints do not change
  replay recovery;
- bash profiling preserves existing `bash.observation` and tool result behavior;
- MCP profiling remains replay-invisible;
- profile report generation does not call providers or tools;
- profile report JSON matches `profile-report.schema.json`;
- disabled profiling does not emit `profile.span`;
- enabled profiling emits bounded metadata only;
- transcript write failures for profile spans follow the documented fatal
  transcript semantics.

## 22. Completion Standard

Phase 8 is complete when:

- a real session can opt into profiling without changing model-visible behavior;
- the transcript contains replay-invisible `profile.span` events;
- profile spans cover startup, context, provider, tool, approval, MCP, compact,
  transcript write, and runtime/bash paths at coarse lifecycle boundaries;
- `lightcc profile <transcript>` produces a useful local human summary;
- the same command can produce a stable versioned JSON report for external local
  tooling;
- replay with profile spans is identical to replay without them;
- profile metadata is bounded and excludes sensitive or model-visible content;
- normal non-profiled runs remain clean and do not carry profiling output.
