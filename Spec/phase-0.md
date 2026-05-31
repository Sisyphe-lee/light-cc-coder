# Phase 0 Spec: Loop Kernel and Minimal Session Wrapper

Status: decided for Phase 0 implementation.

Phase 0 is a kernel milestone, not a usable coder. It must prove the loop,
tool/result pairing, event stream, and transcript/replay invariants before real
file tools, shell, permissions, sandbox, MCP, skills, memory, and compaction are
added.

The implementation should stay close to CoreCoder's minimal mental model, but
with stricter harness boundaries inspired by Claude Code and Reasonix.

## 1. References and Extraction

### 1.1 Claude Code Behavior

Claude Code separates the session/input layer from the core loop:

```text
QueryEngine.submitMessage(...)
  -> processUserInput(...)
  -> append accepted user message(s)
  -> record transcript before model call
  -> query(...)
      -> queryLoop while true
          -> project messages/context
          -> call model
          -> collect assistant content
          -> scan actual tool_use blocks
          -> if no tool_use: finish turn
          -> runTools(...)
          -> append user-side tool_result messages
          -> continue
```

Important observed behaviors:

- Continuation is decided by actual `tool_use` blocks in assistant content, not
  by trusting `stop_reason`.
- Tool failures, unknown tools, validation failures, permission denials, and
  aborts are model-visible tool results.
- Transcript persistence happens before and during the loop, not only after a
  final answer.
- Claude Code has many extra mechanisms to preserve this invariant under
  streaming fallback, compact/recovery, UI tombstones, and resume repair.

Key local references:

- `/data1/lcy/projects/ClaudeCode/src/query.ts`
- `/data1/lcy/projects/ClaudeCode/src/QueryEngine.ts`
- `/data1/lcy/projects/ClaudeCode/src/services/tools/toolOrchestration.ts`
- `/data1/lcy/projects/ClaudeCode/src/services/tools/toolExecution.ts`
- `/data1/lcy/projects/ClaudeCode/src/utils/sessionStorage.ts`

### 1.2 CoreCoder Baseline

CoreCoder is the simplest useful starting point. Its `Agent.chat()` does:

```text
append user
maybe_compress
for max_rounds:
  LLM.chat(messages, tools)
  if no tool_calls:
    append assistant
    return text
  append assistant with tool_calls
  execute tool calls
  append role=tool results
  maybe_compress
```

Good ideas to keep:

- The loop is small and understandable.
- Continuation is based on `resp.tool_calls`, not a finish reason.
- Tool errors are returned as text results instead of crashing the loop.
- OpenAI-compatible message shape is straightforward:
  `{ role: "assistant", tool_calls: [...] }` followed by
  `{ role: "tool", tool_call_id, content }`.

Boundaries we should not copy:

- `Agent` owns loop, messages, context compression, and tool execution all at
  once.
- No `submit(op)+events()` API.
- No durable JSONL event transcript.
- No strict replay/pairing validation.
- Tool execution bypasses a dedicated runtime/permission/sandbox layer.
- Multiple tool calls run in parallel without read/write safety distinction.

### 1.3 Reasonix Cross-Check

Reasonix uses the same core control rule:

```text
session.Add(user)
for step:
  provider.Stream(...)
  collect text/reasoning/tool calls
  session.Add(assistant with calls)
  if len(calls) == 0: return
  executeBatch(calls)
  session.Add(tool result for each call)
  maybeCompact
```

Reasonix is useful evidence that a small loop can still have product-grade
boundaries around events, permissions, truncation, compaction, and sandbox. For
Phase 0 we only adopt the loop shape and the idea that events are separate from
model-visible messages.

## 2. Phase 0 Deliverables

Phase 0 implements two minimal pieces:

1. **0A Loop Kernel**
   - Input is already normalized.
   - Calls a fake provider.
   - Runs a fake/minimal tool runtime.
   - Guarantees every assistant tool call gets exactly one result before the
     next provider call.

2. **0B Minimal Session Wrapper**
   - Exposes `AgentSession.submit(op)` and `events()`.
   - Turns raw user text into one `UserMessage`.
   - Persists accepted user messages before the model call.
   - Owns event emission, transcript writing, replay, and message projection.

Everything else is explicitly deferred.

## 3. Phase 0A: Loop Kernel

### 3.1 Responsibility

`runTurn` controls whether a turn continues or ends:

```text
runTurn(normalizedUserMessage, state)
  append user message

  for step = 1..maxSteps:
    providerMessages = projectMessages(state.messages)
    assistant = executeStep(providerMessages)
    append assistant

    if assistant.toolCalls is empty:
      end turn as completed
      return

    results = toolRuntime.runBatch(assistant.toolCalls)
    assert exactly-one result per tool call
    append results

  end turn as max_steps
```

The loop kernel does not parse user input, load AGENTS.md, decide permissions,
touch files, run shell commands, or format UI.

### 3.2 Continuation Rule

The only primary continuation rule is:

```text
if assistant.toolCalls.length > 0:
  execute tools and continue
else:
  end the turn
```

`finishReason` may be recorded for diagnostics, but it must not be the primary
control signal.

This is the shared behavior across Claude Code, CoreCoder, and Reasonix.

### 3.3 Assistant Step

Phase 0 uses one internal assistant message per provider response:

```ts
type AssistantMessage = {
  id: string
  role: "assistant"
  content: string
  toolCalls: ToolCall[]
  finishReason?: string
  usage?: TokenUsage
  raw?: unknown
}
```

This intentionally does not copy Claude Code's content-block-level assistant
message stream. Later provider adapters may expose lower-level deltas, but the
loop kernel receives one finalized assistant message per step.

### 3.4 Tool Calls and Results

```ts
type ToolCall = {
  id: string
  name: string
  input: unknown
}

type ToolResultMessage = {
  id: string
  role: "tool"
  toolCallId: string
  toolName: string
  content: string
  isError: boolean
}
```

Invariant:

```text
assistant.toolCalls = [A, B, C]

before the next provider call, state must contain exactly:
  toolResult(A)
  toolResult(B)
  toolResult(C)
```

Result order must match provider tool call order in Phase 0.

Tool failures are represented as `ToolResultMessage { isError: true }`, not as
uncaught loop exceptions.

### 3.5 Tool Runtime Contract

Phase 0 defines the boundary even though it uses fake/minimal tools:

```ts
interface ToolRuntime {
  runBatch(calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]>
}
```

Rules:

- Unknown tool returns an error result.
- Invalid input returns an error result.
- Tool exception returns an error result.
- Abort after assistant tool calls have been appended returns abort error
  results for pending calls.
- `runBatch` must return one result per call in the original call order.

The real permission/sandbox/tool registry layers plug into this boundary in
later phases.

### 3.6 Max Steps

`maxSteps` counts model steps, not tool calls.

If the last allowed model step returns tool calls, those calls must still be
paired with tool results. The turn then ends as `max_steps` without making the
next provider call.

No `max_steps` path may leave an assistant tool call without a result.

### 3.7 Abort

Phase 0 abort semantics:

- Abort before final assistant message: do not append partial assistant content
  to replay-visible history; end turn as `aborted`.
- Abort after assistant tool calls are appended: append one abort result for
  each pending call; end turn as `aborted`.
- Abort must preserve tool/result pairing.

### 3.8 Deferred Claude Code Loop Mechanisms

These mechanisms are important, but not Phase 0:

| Claude Code mechanism | Why it exists | Why Phase 0 defers it |
| --- | --- | --- |
| Streaming fallback | Handles real provider stream fallback/retry without keeping stale tool IDs. | Fake provider has no fallback path. Add with real streaming provider. |
| Content-block assistant messages | Anthropic stream yields completed content blocks incrementally. | Phase 0 can reason over one finalized assistant step. |
| Tombstones | Remove partial/orphaned messages from UI/transcript after fallback. | No streaming fallback or partial persisted assistant messages yet. |
| Compact recovery | Recovers from context pressure and prompt-too-long errors. | Phase 0 has no compaction. Pair-safe compaction gets its own spec. |
| Streaming tool execution | Starts tools while model is still streaming to reduce latency. | Phase 0 optimizes correctness, not latency. |
| Stop hooks | Extension mechanism can stop continuation after response/tool use. | Hooks belong to extension phase. |
| API repair heuristics | Repairs corrupted/resumed tool_use/tool_result mismatches. | Phase 0 should expose pairing bugs instead of silently repairing them. |

## 4. Phase 0B: Minimal Session Wrapper

### 4.1 Responsibility

`AgentSession` is the public entry:

```ts
interface AgentSession {
  readonly id: string
  submit(op: SessionOp): Promise<void>
  events(): AsyncIterable<SessionEvent>
  abort(reason?: string): void
  close(): Promise<void>
}
```

Phase 0 operation type:

```ts
type SessionOp =
  | { type: "user_message"; content: string; id?: string }
  | { type: "abort"; reason?: string }
```

The wrapper owns:

- session id and active turn guard.
- raw text -> `UserMessage`.
- event stream.
- transcript writes.
- replay from transcript.
- provider message projection.

It does not own tool execution internals or provider streaming internals.

### 4.2 Minimal Input Normalization

Phase 0 input normalization is deliberately tiny:

```text
submit({ type: "user_message", content })
  -> UserMessage { role: "user", content }
```

No Phase 0 support for:

- slash commands.
- bash mode.
- attachments.
- image/file refs.
- hooks.
- AGENTS.md loading.
- memory.
- skills.
- MCP.
- custom prompt composition.

Claude Code's `processUserInput` is the future reference for these, but Phase 0
does not implement it.

### 4.3 Transcript Ownership

`SessionEngine` writes transcript. `runTurn` should not write files directly.

Reason:

- Claude Code's `query()` yields messages/events; `QueryEngine` handles
  transcript and SDK/headless presentation.
- Keeping persistence outside the kernel makes the loop easier to test.
- Later CLI/TUI/SDK surfaces can consume the same event stream without changing
  the loop.

### 4.4 Persistence Order

Required write ordering:

1. `user.message` is persisted before the first provider call.
2. `assistant.message` is persisted before tool execution starts.
3. `tool.result` is persisted before the next provider call.
4. `turn.ended` is persisted before the turn task resolves.

Transcript write failure is fatal in Phase 0. Do not continue model/tool
execution with untraceable state.

### 4.5 Event and Transcript Shape

Every event has:

```ts
type EventBase = {
  seq: number
  timestamp: string
  sessionId: string
  turnId?: string
  stepId?: string
}
```

Phase 0 events:

```ts
type SessionEvent =
  | (EventBase & { type: "session.started"; cwd: string })
  | (EventBase & { type: "turn.started"; turnId: string })
  | (EventBase & { type: "user.message"; message: UserMessage })
  | (EventBase & { type: "step.started"; turnId: string; stepId: string })
  | (EventBase & { type: "assistant.delta"; text: string })
  | (EventBase & { type: "assistant.message"; message: AssistantMessage })
  | (EventBase & { type: "tool.call"; call: ToolCall })
  | (EventBase & { type: "tool.result"; result: ToolResultMessage })
  | (EventBase & { type: "step.ended"; reason: StepEndReason })
  | (EventBase & { type: "turn.ended"; reason: TurnEndReason })
  | (EventBase & { type: "error"; error: string; recoverable: boolean })
```

Provider-message replay uses only:

- `user.message`
- `assistant.message`
- `tool.result`

Other events are durable trace or UI events; they do not become provider
messages.

### 4.6 Provider Projection

Phase 0 targets OpenAI-compatible projection:

```text
UserMessage
  -> { role: "user", content }

AssistantMessage
  -> { role: "assistant", content, tool_calls }

ToolResultMessage
  -> { role: "tool", tool_call_id, content }
```

Projection must validate pairing before returning provider messages:

- no missing tool results.
- no duplicate tool results.
- no orphan tool results.
- no reordered result batch within one assistant step.

Phase 0 does not implement Claude Code-style automatic repair. Pairing
corruption is a structured replay/projection error.

## 5. Interfaces

### 5.1 Provider

```ts
interface Provider {
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}

type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "assistant_message"; message: AssistantMessage }
  | { type: "error"; error: string }
```

Phase 0 uses `FakeProvider`, but the loop consumes the interface.

### 5.2 Internal Messages

```ts
type InternalMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage

type UserMessage = {
  id: string
  role: "user"
  content: string
}
```

`AssistantMessage`, `ToolCall`, and `ToolResultMessage` are defined above.

## 6. Required Tests

### Loop Kernel Tests

1. Text-only turn completes after one assistant message.
2. Single tool call appends exactly one matching result and continues.
3. Multiple tool calls append results in provider order.
4. Unknown tool becomes `isError: true` tool result.
5. Invalid tool input becomes `isError: true` tool result.
6. Tool exception becomes `isError: true` tool result.
7. Fake runtime pairing violation emits fatal error.
8. `maxSteps` pairs final tool calls before ending.
9. Abort before final assistant does not append partial assistant history.
10. Abort after assistant tool calls appends abort results for every pending call.

### Session Wrapper Tests

1. `submit(user_message)` emits `turn.started` and persists `user.message`
   before provider call.
2. Active turn guard rejects a second user message while a turn is running.
3. Transcript replay reconstructs the same provider messages as in-memory
   projection.
4. Replay detects missing, duplicate, or orphan tool results.
5. Transcript write failure stops the turn and emits non-recoverable error.

## 7. Explicit Non-Goals

Phase 0 does not implement:

- real OpenAI-compatible provider.
- file tools.
- bash/runtime/deployment.
- workspace path boundary.
- permission approval.
- sandbox.
- AGENTS.md loading.
- slash commands.
- attachments.
- memory.
- compaction.
- MCP.
- skills.
- hooks.
- CLI/REPL polish.
- read-only tool concurrency.
- streaming tool execution.
- parent-UUID transcript DAG.

These are still core project mechanisms. They will be specified in later phase
documents before implementation.

## 8. Done Criteria

Phase 0 is done when:

- `AgentSession.submit(op)` can drive a complete fake-provider turn.
- Event stream explains the full turn lifecycle.
- JSONL transcript is written in deterministic order.
- Replay reconstructs provider messages.
- Tool/result pairing is enforced in success, error, max-step, abort, and replay paths.
- Loop tests pass without real filesystem, shell, model, MCP, memory, or compact.
