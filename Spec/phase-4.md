# Phase 4 Spec: Compact-First Context Management

Status: draft for Phase 4 implementation.

Phase 3 completed shell execution, permission decisions, approval events, and
policy-level sandboxing. Phase 4 focuses on the part that makes long coding
sessions viable: keeping provider context bounded without losing the ability to
audit and resume from transcript.

Memory is intentionally minimized in this phase. The core deliverable is not a
general long-term memory system. The core deliverable is a compact pipeline that
preserves tool/result pairing, writes replayable checkpoints, and avoids waiting
until the provider request is already too large to summarize.

## 1. Settled Scope

Phase 4 is compact-first:

- large tool results may be persisted as session artifacts and replaced with a
  model-visible preview;
- old tool results may be snipped during history projection;
- manual compact creates a compact checkpoint with summary plus recent tail;
- auto compact runs before the provider hard limit is reached;
- prompt-too-large overflow gets one compact-and-retry path;
- replay after compact remains valid and deterministic.

Memory and git context are not the center of this phase:

- memory remains empty or read-only only if it is trivial to add;
- no automatic memory extraction;
- no model-callable memory write tool;
- git context may be a small session-start snapshot, but it must not delay the
  compact pipeline.

## 2. Reference Conclusions

### 2.1 Claude Code

Claude Code has several context-management mechanisms rather than one linear
five-stage compact function:

- large tool output persistence: big tool results are replaced with a short
  preview and reference to the persisted output;
- historical snip/projection: the UI and transcript can retain more than the
  provider request sends;
- context collapse: selected historical spans can be represented by summaries
  and a commit log;
- full compact: older conversation is summarized, a compact boundary is written,
  and recent state is restored around the summary;
- auto compact and prompt-too-long retry: compact is triggered before the hard
  provider limit, with fallback when the compact request itself is too large.

The important behavior to preserve is not the exact implementation shape. The
important behavior is:

- canonical transcript stays auditable;
- provider request uses an active projection;
- compact boundaries are explicit;
- compact tail never starts with an orphan tool result;
- compact happens early enough to leave room for the summary request.

### 2.2 CoreCoder

CoreCoder shows that useful compact can start small:

- cap single tool outputs;
- snip old tool results;
- summarize old messages;
- keep a recent tail.

Do not copy its direct mutation of `messages` as the durable truth. In
light-cc-coder, transcript remains append-only and replay must understand
compact checkpoints.

### 2.3 DeepSeek-Reasonix

Reasonix reinforces the cache-friendly rule:

- stable prefix stays stable;
- normal turns append;
- compact is an explicit cache reset point;
- permission and sandbox results are tool results, not prompt state;
- compact tail must be tool/result pairing safe.

### 2.4 Codex

Codex is closest to light-cc-coder's current shape:

- `AgentSession.submit(op)` is the control surface;
- approval response is an op and not model history;
- transcript contains lifecycle events, not just provider messages;
- compact should be a checkpoint/replacement-history event that replay can
  understand.

## 3. Goals

Phase 4 implements:

- configurable context budget, default `maxContextTokens = 200_000`;
- deterministic rough token/byte estimation for preflight budgeting;
- session artifact directory for large tool result payloads;
- model-visible preview for persisted tool results;
- artifact diagnostics in transcript;
- historical tool-result snip during provider history projection;
- manual compact control op;
- compact events and checkpoint state;
- no-tools compact summary provider call;
- summary plus recent valid assistant/tool tail;
- auto compact before the hard provider limit;
- one overflow compact/retry path for provider context-too-large errors;
- replay projection from the latest compact checkpoint plus suffix;
- tests proving compact does not create missing, duplicate, reordered, or orphan
  tool results.

## 4. Non-Goals

Phase 4 must not implement:

- full Claude Code context-collapse commit log;
- span-level collapse worker;
- cached microcompact or provider cache edit APIs;
- automatic long-term memory extraction;
- model-callable memory write tool;
- multi-layer user/global/team memory;
- repo map;
- full git diff injection;
- remote comparison;
- MCP or skills preservation across compact;
- background compaction agent;
- subagent or sidechain transcript support;
- database-backed session index;
- rewriting existing JSONL transcript.

## 5. Existing Invariants To Preserve

- Every assistant tool call gets exactly one model-visible tool result.
- Tool result order matches provider tool call order.
- Tool errors, denials, timeouts, sandbox denials, and runtime errors remain
  model-visible tool results.
- Transcript write failure remains fatal.
- Replay/projection rejects missing, duplicate, orphan, reordered, and
  cross-turn tool results.
- `ToolRuntime` remains the only tool execution path.
- `ContextAssembler` remains the provider request assembly path.
- Context diagnostics do not become provider history unless intentionally
  included as a context source.

## 6. Phase 4 Architecture

High-level shape:

```text
AgentSession.submit(op)
  -> SessionEngine
      -> maybe handle compact.request
      -> runTurn
          -> before provider request:
               ContextBudget.estimate(active projection)
               maybe snip historical tool results
               maybe auto compact
          -> ContextAssembler.assembleStep(...)
          -> provider step
          -> ToolRuntime.runBatch(...)
               -> maybe persist large tool result artifact
               -> return preview as exactly one tool result
          -> append tool results
```

Ownership:

- `ToolRuntime` owns per-tool-call result normalization and artifact preview.
- `SessionEngine` owns active history, compact checkpoint state, and replay
  semantics.
- `ContextAssembler` owns source slots and final provider request assembly.
- `messageProjection` or a new history projection module owns snip/projection
  logic.
- transcript remains the durable audit log.

## 7. Context Budget

Add session options:

```ts
type ContextBudgetOptions = {
  maxContextTokens: number // default 200_000
  warningTokens?: number
  softCompactTokens?: number
  hardCompactTokens?: number
  compactInputTokens?: number
  compactOutputReserveTokens?: number
}
```

Suggested defaults for `maxContextTokens = 200_000`:

- warning at about `140_000`;
- soft compact at about `155_000`;
- hard preflight compact at about `175_000`;
- provider request blocking at about `180_000`;
- reserve at least `20_000` tokens for compact summary output and failure
  recovery.

Exact numbers can be constants in Phase 4. The important rule is that summary
compact must run before the main request consumes the whole context window.

Budget estimation can be rough:

- count characters and divide by a conservative token ratio;
- include provider messages and tool schemas;
- include compact summary, memory/git sources, and recent tail;
- include tool result previews, not artifact full contents.

If provider usage is available on assistant messages, use it for diagnostics,
but do not depend on it for correctness.

## 8. Layer 1: Tool Result Artifacts

Current Phase 3 truncates tool results before they can grow without bound.
Phase 4 upgrades this for very large results:

- store full large result in a session artifact directory near the transcript;
- replace model-visible result content with a preview and artifact metadata;
- emit a diagnostic transcript event for the artifact;
- keep exactly one `tool.result` for the original tool call.

The artifact directory should not live in the user's workspace by default. It
should be tied to the session/transcript path so coding worktrees are not
polluted.

Model-visible preview should include:

- tool name;
- original byte count;
- artifact id or relative artifact path;
- a bounded head preview, optionally with tail for shell output;
- clear note that the full output was persisted outside provider context.

Phase 4 does not need a general artifact read tool. If the model needs more
detail, it should rerun a narrower command or use normal workspace tools. A
future read-only `read_artifact` tool can be added if real usage shows the need.

Proposed event:

```ts
{
  type: "tool.artifact",
  turnId,
  stepId,
  toolCallId,
  toolName,
  artifactId,
  path,
  originalBytes,
  previewBytes,
  sha256
}
```

This event is diagnostic and replay should ignore it. The model-visible preview
is stored in the paired `tool.result`.

## 9. Layer 2: Historical Tool Result Snip

Artifact preview protects the first insertion of a large result. Historical snip
protects later provider requests.

Snip is a projection step:

- canonical `state.messages` and transcript retain original tool result content;
- provider projection may replace old tool result content with a short marker;
- recent tail remains unsnipped;
- snip never removes a tool result message;
- snip never changes tool call ids or order.

The snip marker should be explicit:

```text
[snipped old tool result: bash, original bytes=84231, kept in transcript]
```

Recommended policy:

- never snip the current step;
- never snip the most recent N turns or last M messages;
- only snip tool results over a byte threshold;
- keep error/denial/timeout results longer than ordinary successful output,
  because they often carry important recovery information;
- record snip diagnostics in `context.step` source notes or a dedicated
  projection diagnostic.

This layer must be deterministic. Repeated assembly over the same active history
must produce the same projected bytes.

## 10. Layer 3: Manual Compact

Add a control op:

```ts
type SessionOp =
  | ...
  | { type: "compact.request"; id?: string; instruction?: string }
```

Manual compact is a session operation, not a model-visible user message. It
should be rejected while a turn is active unless the implementation explicitly
supports interrupt-and-compact. Phase 4 should keep this simple: no active turn
compact.

Manual compact flow:

1. emit `compact.started`;
2. choose a compactable prefix and recent tail;
3. summarize compactable history using the provider with no tools;
4. construct active history as compact summary plus recent tail;
5. emit `compact.ended` with checkpoint metadata;
6. future provider requests project from the new active history.

Summary must preserve:

- current task goal;
- explicit user constraints;
- project instructions that affected behavior;
- files read and why they mattered;
- files changed and what changed;
- important commands run and their outcomes;
- failed commands, denials, timeouts, and unresolved errors;
- decisions already made;
- current next step.

The summary prompt text should live in our codebase as a short, original
clean-room prompt. Do not copy Claude Code compact prompts.

## 11. Layer 4: Compact Checkpoint and Replay

Compact must be represented in transcript as an append-only checkpoint.

Proposed events:

```ts
{
  type: "compact.started",
  compactId,
  trigger: "manual" | "auto" | "overflow_retry",
  preCompactMessageCount,
  estimatedTokens
}
```

```ts
{
  type: "compact.ended",
  compactId,
  trigger,
  summaryMessage,
  tailStartMessageId,
  summarizedMessageCount,
  keptMessageCount,
  preCompactEstimatedTokens,
  postCompactEstimatedTokens,
  status: "succeeded"
}
```

If compaction fails:

```ts
{
  type: "compact.ended",
  compactId,
  trigger,
  status: "failed",
  error
}
```

Replay rule:

- find the latest successful `compact.ended`;
- reconstruct active messages as `summaryMessage + valid tail + subsequent
  canonical user/assistant/tool messages`;
- ignore earlier canonical messages for provider replay, but keep them in
  transcript for audit;
- replay still validates every assistant/tool group in the active projection.

The summary should be represented as a normal model-visible message in active
history. The simplest form is a user meta message such as:

```text
<system-reminder>
Conversation compacted. Summary of earlier work:
...
</system-reminder>
```

It must be clear to the model that this is a summary of prior context, not a new
user task.

## 12. Pairing-Safe Tail Selection

Tail selection must understand the current internal message model:

```ts
type InternalMessage = UserMessage | AssistantMessage | ToolResultMessage
```

Rules:

- tail may start at a user message with no pending prior assistant tool calls;
- tail may start at an assistant message only if that assistant has no tool
  calls or all of its paired tool results are also included;
- tail must never start with a tool result;
- tail must never include an assistant tool call without every paired result;
- if in doubt, move the tail boundary earlier.

This is a required test surface.

## 13. Layer 5: Auto Compact and Overflow Retry

Auto compact should happen before provider calls, not after the provider rejects
the request.

Preflight before each provider step:

1. assemble or estimate the projected request;
2. if below soft threshold, continue;
3. if above soft threshold, apply historical snip;
4. if still above hard threshold, run auto compact;
5. if auto compact succeeds, assemble request again;
6. if auto compact fails, continue only if below blocking threshold.

Provider overflow retry:

- catch provider errors that clearly mean context too large;
- run compact with trigger `overflow_retry`;
- retry the provider step once;
- if retry fails, emit a fatal error for the turn;
- never loop indefinitely.

Auto compact failure policy:

- auto compact failure should not immediately break a session if snip leaves the
  request under blocking threshold;
- if request remains over blocking threshold, fail the turn with a clear error;
- track consecutive auto compact failures and stop repeated attempts after a
  small limit, such as 3.

Manual compact failure policy:

- manual compact failure should surface as an error event and leave active
  history unchanged.

## 14. Prompt-Too-Large During Compact

The compact request itself can be too large. Phase 4 must include a robust
fallback.

Fallback:

- compact first with the selected prefix;
- if compact provider call fails as too large, drop the oldest complete API
  groups from the compact input and retry compact;
- preserve a marker in the final summary that some earliest history was omitted
  from the compact request;
- limit retries, for example 2 or 3;
- if still too large, fail compact cleanly.

The dropped groups remain in transcript. They are only omitted from the compact
summary input to unblock the session.

## 15. ContextAssembler Integration

Existing source slots stay stable:

```text
global_system_prompt
user_prompt_slot
runtime_facts
project_instructions
memory_slot
git_slot
skills_slot
mcp_slot
compact_slot
history_projection
tool_schemas
```

Phase 4 active changes:

- `compact_slot` reports latest compact checkpoint status and summary hash;
- `history_projection` reports projected count, snipped count, and estimated
  tokens;
- `memory_slot` can remain empty;
- `git_slot` can remain empty until the compact pipeline is stable.

If git context is added in Phase 4, keep it tiny:

- session-start snapshot only;
- branch;
- HEAD sha;
- dirty file count;
- bounded `git status --short --branch` lines;
- timeout and failure as `missing` or `error` source status.

Do not refresh git context on every step in Phase 4.

## 16. Expected Module Boundary

Names may shift, but keep the boundary small:

```text
src/context/compaction.ts
src/context/contextBudget.ts
src/context/toolArtifacts.ts
src/engine/SessionEngine.ts
src/engine/ContextAssembler.ts
src/engine/messageProjection.ts
src/engine/transcript.ts
src/core/events.ts
src/core/ops.ts
src/tools/ToolRuntime.ts
src/cli/main.ts
```

Avoid a deep framework. Phase 4 should be a focused context-management layer,
not a plugin system.

## 17. CLI Surface

The current `-p` CLI can expose only minimal flags:

```text
--max-context-tokens <number>
--compact-threshold <number>   # optional, can be deferred
```

Slash `/compact` is mostly a REPL concern and can wait until Phase 5 commands.
For Phase 4 tests and API use, `compact.request` on `AgentSession.submit` is the
important surface.

## 18. Tests

Required tests:

- large tool result produces one paired `tool.result` and one diagnostic
  artifact event;
- artifact preview is replay-safe and does not include full content;
- old large tool result is snipped in provider projection without mutating
  canonical transcript;
- recent tail remains unsnipped;
- compact tail never starts with a tool result;
- compact preserves complete assistant/tool groups;
- manual compact writes `compact.started` and `compact.ended`;
- replay after compact returns summary plus tail plus suffix;
- replay still rejects malformed active histories;
- auto compact triggers before hard threshold;
- provider context overflow triggers one compact retry;
- compact prompt-too-large retry drops oldest complete groups and either
  succeeds or fails cleanly;
- manual compact failure leaves `SessionEngine.state.messages` unchanged;
- auto compact failure under blocking threshold degrades without corrupting
  history;
- transcript write failure during compact is fatal and does not partially switch
  active history.

## 19. Acceptance Criteria

Phase 4 is complete when:

- long historical tool output cannot grow provider context without bound;
- oversized tool outputs are auditable through session artifacts;
- manual compact works through `AgentSession.submit`;
- auto compact runs before the provider hard limit is reached;
- provider context-too-large gets one safe compact/retry path;
- compact checkpoints are persisted as append-only events;
- replay after compact remains valid and deterministic;
- compact never creates orphan tool results;
- `bun run test` and `bun run typecheck` pass.
