# Phase 5 Spec: MCP, Skills, Commands, Hooks, Todo

Status: minimal closed loop implemented; remaining items are hardening.

Phase 4 completed compact-first context management. Phase 5 adds the smallest
useful extension surface: MCP stdio tools, deterministic skills context,
local slash commands, minimal lifecycle hooks, and a session-scoped todo tool.

This phase must stay thin. It is not an extension framework, plugin marketplace,
or memory system. Extensions enter the core through only two doors:

- register a normal tool that runs through `ToolRuntime`;
- inject deterministic context or submit a `SessionOp` through `AgentSession`.

`runTurn` should not grow a second extension loop. `ToolRuntime` remains the
only tool execution path. `ContextAssembler` remains the provider request
assembly path. Transcript write failure remains fatal.

## 1. Settled Scope

Phase 5 implements:

- MCP stdio client;
- MCP tool discovery and registration as namespaced tools;
- deterministic skills loader for `SKILL.md`;
- built-in slash command parser and command ops;
- minimal hooks: user prompt submit, pre tool, post tool, stop;
- `todo` built-in session tool.

Phase 5 explicitly does not implement:

- MCP HTTP/SSE transports;
- MCP OAuth, marketplace, remote installation, or dynamic connector auth;
- MCP resources or MCP prompts;
- MCP hot reload within an active session;
- custom markdown slash commands;
- implicit long-term memory;
- skill assets/scripts execution;
- skill install, skill search, skill subagents, or model overrides;
- background jobs, subagents, persistent shell sessions, or resource-aware
  scheduler replacement.

## 2. Reference Conclusions

### 2.1 Claude Code

Claude Code's relevant behavior reduces to two extension exits:

- MCP tools are adapted into the normal tool pool;
- skills, memory, slash commands, and hooks affect context or session lifecycle.

Slash commands are not automatically user messages. Local commands such as help,
tool listing, permission state, and compact control run before model history is
constructed. Hooks run at lifecycle points, but cannot be allowed to bypass tool
permission and result pairing.

### 2.2 Codex

Codex reinforces `submit(op) + events()` as the control surface. Phase 5 state
changes such as command invocation, skill activation, and future MCP refreshes
should be explicit ops or session initialization data. Approval continues to use
the existing pending-response path.

Codex also reinforces keeping `apply_patch` as a first-class tool path. MCP or
commands must not turn file edits into shell fallbacks.

### 2.3 Kimi Code

Kimi Code reinforces lifecycle separation:

- durable replay events are different from live diagnostics;
- tool lifecycle is parse/preflight -> permission -> execute -> finalize;
- `AbortSignal` must flow through providers, tools, hooks, and MCP transports;
- tool result pairing is repaired with synthetic results when execution aborts.

Phase 5 can add diagnostics, but replay must continue to consume only
model-visible history and explicit checkpoints.

### 2.4 DeepSeek-Reasonix and CoreCoder

Reasonix is a useful reference for a small MCP design:

- external tools are stdio JSON-RPC subprocesses;
- each MCP tool becomes a namespaced normal tool such as
  `mcp__server__tool`;
- `readOnlyHint` defaults to false because remote tools are opaque;
- prefix/cache stability matters, so extension state should be stable during a
  session.

CoreCoder is useful mostly as a constraint: a simple loop should not absorb the
extension system. Phase 5 should attach around `AgentSession`,
`ContextAssembler`, and `ToolRuntime`.

## 3. Existing Invariants To Preserve

- Every assistant tool call gets exactly one model-visible tool result.
- Tool result order matches provider tool call order.
- Tool errors, denials, timeouts, sandbox denials, MCP failures, hook blocks,
  and aborts remain model-visible tool results when a tool call exists.
- Transcript write failure remains fatal.
- Replay/projection rejects missing, duplicate, orphan, reordered, and
  cross-turn tool results.
- `ToolRuntime` remains the only tool execution path.
- `ContextAssembler` remains the provider request assembly path.
- Context and extension diagnostics do not become provider history unless
  intentionally represented as context source content.
- Session-start context source order remains deterministic.

## 4. Architecture

High-level shape:

```text
AgentSession.create(...)
  -> load extension configuration
  -> connect MCP stdio servers
  -> freeze tool registry and enabled skill snapshots
  -> ContextAssembler.initialize(...)

AgentSession.submit(op)
  -> slash command ops handled locally or turned into existing ops
  -> user prompt submit hooks
  -> runTurn(...)
       -> ContextAssembler.assembleStep(...)
       -> provider step
       -> ToolRuntime.runBatch(...)
            -> parse + permission + pre tool hook
            -> builtin/MCP/todo execute
            -> normalize + artifact/truncate
            -> post tool hook diagnostic
       -> append paired tool results
  -> stop hooks
```

Ownership:

- `AgentSession` owns session control ops and active-turn guards.
- `SessionEngine` owns active history, transcript events, command diagnostics,
  and extension state snapshots that affect context.
- `ContextAssembler` owns `skills_slot`, `mcp_slot`, optional `todo_slot`, and
  source diagnostics.
- `ToolRegistry` owns stable tool order and duplicate rejection.
- `ToolRuntime` owns every tool execution, including MCP tools and `todo`.
- MCP client owns stdio process lifecycle and JSON-RPC request/response mapping.

## 5. MCP

### 5.1 Configuration

Phase 5 keeps MCP configuration explicit.

Canonical core input should be session options, for example:

```ts
type McpServerConfig = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  startupTimeoutMs?: number
  callTimeoutMs?: number
}
```

The CLI may add an explicit `--mcp-config <path>` flag with a small
light-cc-coder JSON shape, but Phase 5 must not auto-discover project
`.mcp.json`. Automatic discovery and Claude-compatible config import can come
later after the runtime path is proven.

MCP tool schemas are frozen after session initialization. Active-session hot
reload is out of scope because it makes `toolSchemaHash`, provider request hash,
and replay/debug harder to explain.

### 5.2 Transport and Lifecycle

Phase 5 supports stdio only:

1. spawn configured command with args/env/cwd;
2. speak newline-delimited JSON-RPC over stdin/stdout;
3. send `initialize`;
4. send `notifications/initialized`;
5. call `tools/list`;
6. adapt listed tools into `ToolDefinition`s;
7. call `tools/call` for tool execution;
8. terminate child process on session close or abort.

Required behavior:

- startup timeout produces a diagnostic event and no tools for that server;
- call timeout returns a paired tool error result;
- server crash returns a paired tool error result for in-flight calls;
- stderr is capped and recorded only as diagnostics;
- MCP diagnostics are ignored by provider replay.

### 5.3 Tool Naming and Read-Only Semantics

MCP tools use deterministic names:

```text
mcp__<sanitized-server-name>__<sanitized-tool-name>
```

Sanitization must be stable and reject or disambiguate collisions before the
session starts. The adapter keeps raw `{ serverName, toolName }` for routing.

Remote tools default to `readOnly: false`. MCP `annotations.readOnlyHint ===
true` may map to `readOnly: true`, but this is only a scheduling and permission
hint. It never bypasses the permission policy.

### 5.4 Result Mapping

MCP `tools/call` output should become a string tool observation for Phase 5.
Text content is joined in a deterministic order. Non-text structured content is
rendered as bounded JSON. Images, resources, and binary content may be reported
as unsupported text placeholders.

The normal `ToolRuntime` output normalization, artifact preview, truncation, and
error-to-result behavior still applies.

## 6. Skills

Phase 5 implements deterministic skill activation, not a skill ecosystem.

### 6.1 Loading

Supported input:

- explicit skill directories from session options;
- each skill directory contains a `SKILL.md`.

The loader reads `SKILL.md`, extracts a name, optional description, and bounded
instruction body. Frontmatter can be deferred. If parsing is simple, the skill
name can default to directory name and the body can be the whole file.

Malformed or oversized skills should be skipped or truncated with diagnostics,
not crash the session unless explicitly configured as required.

### 6.2 Activation

Phase 5 supports explicit activation only. No automatic keyword trigger.

Activation surfaces:

- session option `enabledSkills`;
- optional slash command such as `/skill <name>`.

When a skill is activated, the active rendered content is snapshotted and
diagnosed in transcript. Future edits to `SKILL.md` must not change the meaning
of an already activated skill snapshot in the same transcript.

### 6.3 Context Injection

Activated skills are rendered into `skills_slot` in deterministic order:

- sort by skill name unless explicit order is provided;
- cap total bytes;
- include truncation note when capped;
- expose source bytes/hash/status in context diagnostics.

Skills are model-visible context. They are not tools, memory writes, or
subagents.

## 7. Slash Commands

Slash commands are parsed before `user.message` creation. They default to local
behavior and do not pollute active model history.

Phase 5 built-ins:

- `/help`: return local help text;
- `/tools`: list builtin and MCP tools with read-only status;
- `/permissions`: show current permission mode and high-level policy;
- `/compact`: submit existing `compact.request`;
- `/memory`: report that implicit memory is not implemented and show any
  explicit memory/todo context that exists;
- `/clear`: simplest behavior only. The command host should close/discard the
  current `AgentSession` and start a new one. Phase 5 should not implement an
  in-place transcript rewrite or active-history reset.

Suggested command events:

```ts
{ type: "command.invoked", command, args }
{ type: "command.output", command, content }
```

These events are diagnostics and replay ignores them.

No custom markdown commands in Phase 5. No MCP prompt slash commands in Phase 5.

## 8. Hooks

Hooks are typed lifecycle callbacks provided programmatically through session
options. Phase 5 does not load hook config files and does not run arbitrary shell
hook commands.

Hook points:

- `user_prompt_submit`;
- `pre_tool`;
- `post_tool`;
- `stop`.

### 8.1 User Prompt Submit

Runs after slash-command parsing and before a normal `user.message` is appended.

Allowed outcomes:

- continue unchanged;
- block the prompt with a local diagnostic error;
- append bounded extra context to the user prompt or to a dedicated context
  source.

If blocked, no `user.message` is appended.

### 8.2 Pre Tool

Runs after tool parse and permission denial checks, before execution.

Allowed outcomes:

- continue;
- block.

No input rewriting in Phase 5. A pre-tool block for a model-issued tool call
must return exactly one paired error tool result for that call.

Hooks cannot allow a denied tool. Permission and hard-deny policy remain
authoritative.

### 8.3 Post Tool

Runs after a tool observation has been normalized. Phase 5 post-tool hooks are
observe-only:

- they may emit diagnostics;
- they may not mutate the model-visible tool result;
- hook failure does not turn a successful tool into a failed tool result.

### 8.4 Stop

Runs after turn end. It may emit diagnostics only. It must not append model
history.

### 8.5 Hook Failure Policy

Every hook has timeout and output caps. Hook errors are transcript diagnostics.
Pre-tool hook failures default to continue unless the hook explicitly returns a
block result before failing.

Transcript write failure while writing hook diagnostics is fatal, consistent
with the rest of the system.

## 9. Todo Tool

Phase 5 adds a session-scoped `todo` builtin tool.

The simplest schema is replace-full-list:

```ts
type TodoItem = {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
}

type TodoInput =
  | { action: "replace"; items: TodoItem[] }
  | { action: "list" }
  | { action: "clear" }
```

Rules:

- `todo` is read-only for permission purposes because it only mutates session
  state, not workspace files;
- it is allowed in `read-only` permission mode;
- it returns a short, model-visible ack or listing;
- it does not write workspace files;
- live state may be reconstructed from successful `todo` tool results during
  transcript replay or resume.

Context exposure:

- Phase 5 adds a small `todo_slot` after `memory_slot`.
- Keep it bounded and deterministic.

## 10. ContextAssembler Integration

Existing source slots remain stable. Phase 5 fills reserved slots:

```text
global_system_prompt
  user_prompt_slot
  runtime_facts
  project_instructions
  memory_slot
todo_slot
  git_slot
  skills_slot
mcp_slot
compact_slot
history_projection
tool_schemas
```

Guidelines:

- `skills_slot` contains active skill snapshots only;
- `mcp_slot` contains connected server/tool counts and config hashes, not tool
  schemas themselves;
- provider-visible tool schemas still come from `ToolRegistry`;
- changing enabled skills or MCP servers during a session is out of scope;
- diagnostics record hashes, bytes, status, and truncation.

If adding `todo_slot` creates too much churn, place a bounded todo summary in
`memory_slot` with an explicit label. Do not introduce long-term memory writes.

## 11. Transcript and Replay

New Phase 5 events are diagnostic unless explicitly listed otherwise.

Potential diagnostic events:

- `mcp.server.started`;
- `mcp.server.ready`;
- `mcp.server.failed`;
- `mcp.server.stopped`;
- `skill.activated`;
- `command.invoked`;
- `command.output`;
- `hook.started`;
- `hook.ended`;
- `todo.updated` if needed for non-message state diagnostics.

Replay rules:

- `replayProviderMessages` continues to ignore diagnostics;
- model-visible replay still comes from `user.message`, `assistant.message`,
  `tool.result`, and compact checkpoints;
- extension diagnostics must never create orphan tool results;
- if a model-issued tool call is blocked by MCP/permission/hook failure, it is
  represented by the normal paired `tool.result`.

If a future resume path needs active skills or todo state, it should reconstruct
them from explicit extension events or paired todo tool results, not from current
filesystem contents.

## 12. CLI Surface

Keep CLI minimal:

- existing `-p` remains the main smoke path;
- slash commands can be accepted through `-p` when the prompt starts with `/`;
- optional `--mcp-config <path>` can load explicit MCP servers;
- optional `--skill <path-or-name>` can enable a skill if the loader needs a CLI
  surface.

No interactive REPL is required for Phase 5, but command parsing should be a
shared module so a future REPL can reuse it.

## 13. Expected Module Boundary

Names may change, but keep the implementation shallow:

```text
src/extensions/mcp.ts
src/extensions/skills.ts
src/extensions/commands.ts
src/extensions/hooks.ts
src/tools/builtins/todo.ts
src/tools/builtins/index.ts
src/tools/registry.ts
src/tools/ToolRuntime.ts
src/engine/ContextAssembler.ts
src/engine/contextTypes.ts
src/engine/transcript.ts
src/core/events.ts
src/core/ops.ts
src/core/AgentSession.ts
src/cli/main.ts
```

Avoid introducing a deep plugin manager. Phase 5 should be a small adapter layer.

## 14. Tests

Required MCP tests:

- stdio server startup succeeds and registers namespaced tools;
- startup failure records diagnostics and does not crash the session;
- tool schema order and hash are stable;
- name sanitization and collision handling are deterministic;
- successful MCP tool call produces exactly one paired `tool.result`;
- MCP invalid args, server error, server crash, timeout, permission deny, and
  abort each produce exactly one paired error result;
- `readOnlyHint` controls read-only scheduling but does not bypass permission;
- MCP diagnostics do not appear in `replayProviderMessages`.

Required skills tests:

- loading `SKILL.md` is deterministic;
- explicit activation fills `skills_slot`;
- active skill order and hash are stable;
- byte caps produce truncation diagnostics;
- editing `SKILL.md` after activation does not change active snapshot;
- no automatic keyword trigger occurs.

Required command tests:

- `/help`, `/tools`, `/permissions`, `/memory` produce local output and no
  `user.message`;
- `/compact` maps to compact events and preserves Phase 4 replay invariants;
- `/clear` returns a host action or local output without rewriting transcript;
- unknown command is a local error, not a user message.

Required hook tests:

- user prompt submit block appends no `user.message`;
- user prompt submit extra context is bounded and diagnosed;
- pre-tool block returns a paired error result and does not execute the tool;
- pre-tool cannot allow a permission-denied tool;
- post-tool failure does not mutate the original tool result;
- stop hook failure is diagnostic only;
- hook diagnostics are ignored by replay.

Required todo tests:

- `todo` list/replace/clear validates schema;
- `todo` is allowed in read-only mode;
- successful todo call produces a paired result and does not touch workspace;
- todo state can be reconstructed from transcript according to the chosen
  replay rule;
- compact after todo does not create orphan, duplicate, reordered, or cross-turn
  tool results.

Regression tests:

- all Phase 0-4 pairing, replay, permission, artifact, and compact tests still
  pass;
- transcript write failure during new Phase 5 events remains fatal.

## 15. Acceptance Criteria

Phase 5 is complete when:

- a fake MCP stdio server can expose a tool, the model can call it, and the
  result is paired and replay-safe;
- MCP tools go through the same permission, truncation, artifact, and error path
  as builtin tools;
- a skill can be explicitly enabled and deterministically injected through
  `skills_slot`;
- built-in slash commands work without polluting model history;
- pre-tool hook blocks are converted into paired tool results;
- post-tool and stop hooks are diagnostic-only;
- `todo` works as a session-scoped builtin tool;
- diagnostics explain MCP, skills, commands, hooks, and todo without changing
  provider replay;
- `bun run test` and `bun run typecheck` pass.
