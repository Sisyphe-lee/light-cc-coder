# Phase 2 Spec: Context Assembly / Context Engineering

Status: decided for Phase 2 implementation.

Phase 1 already made a real-provider path work with a minimal context shim:
`AgentSession.start()` loads root `AGENTS.md`, `contextBuilder.ts` builds one
system message, and `runTurn` prepends that fixed message to projected history.
That was enough to smoke-test `-p` and real file tools, but it is not the final
Context Engineering layer.

Phase 2 promotes context assembly into a core session capability owned by
`SessionEngine` and implemented by a small `ContextAssembler`. The goal is not
to add every future context feature now; the goal is to make provider request
construction deterministic, cache-friendly, traceable, and replay-debuggable
before memory, skills, MCP, git context, permission modes, and compaction arrive.

## 1. Design References

### 1.1 Claude Code Lessons

Claude Code treats context as several surfaces with different lifetimes:

```text
global stable system prompt
  -> user/session stable prompt sections
  -> workspace/project instructions as model-visible meta context
  -> session history
  -> step/tool result append-only growth
```

Important lessons to preserve in a lightweight form:

- KV/prefix cache stability is a first-order design constraint.
- The most shared, least volatile text must appear earliest.
- Project instructions such as `CLAUDE.md`/`AGENTS.md` should not be hidden in
  the global system prompt. They are project context, best represented as a
  model-visible meta user message.
- Runtime facts such as cwd/date/git status should be explicit snapshots, not
  implied real-time truth.
- Tool schemas are a separate provider request surface. Their ordering and
  rendered bytes must be stable.
- Request assembly should be inspectable: system sections, project context,
  tools, and history projection should have provenance and hashes.
- Subagents/forks later need exact rendered parent prompt/request prefixes.
  Phase 2 should store enough rendered context to support that future design,
  without implementing subagents.

### 1.2 CoreCoder Constraint

CoreCoder shows the smallest useful mental model:

```text
system prompt + messages + tools -> provider
```

Phase 2 should keep that simplicity at the provider boundary. Do not copy
CoreCoder's canonical-state model where provider messages are the only session
state; light-cc-coder keeps internal messages and JSONL events as the replay
source of truth.

### 1.3 Reasonix Constraint

Reasonix is useful as a middle point:

- stable prompt is assembled once per run;
- tool schemas come from a per-run registry in deterministic order;
- permission/plan mode are execution-time gates, not prompt/schema rewrites;
- memory/skills indexes are bounded and deterministic;
- cache hit/miss and request diagnostics are observable.

Phase 2 borrows the deterministic order and traceability, not the broader
feature set.

## 2. Goals

Phase 2 implements **Context Assembly**, not broader context management.

Required outcomes:

- `SessionEngine` owns context assembly.
- `AgentSession` no longer loads or concatenates `AGENTS.md`.
- `runTurn` no longer builds provider requests by manually prepending a static
  `contextMessages` array to history.
- A `ContextAssembler` module builds provider request context from typed sources.
- Provider request construction has stable source order.
- Root `AGENTS.md` is loaded as project meta context, not global system prompt.
- Tool schemas are included through a stable registry/export boundary.
- Each model step can emit or persist a compact context snapshot/trace.
- Replay remains based on model-visible canonical events:
  `user.message`, `assistant.message`, and `tool.result`.
- Future memory/git/skills/MCP/compact insertions have stable slots, but remain
  no-op placeholders in this phase.

## 3. Non-Goals

Phase 2 must not implement:

- full memory loading/writing;
- git status context;
- skills discovery or skill body injection;
- MCP discovery, MCP instructions, or MCP tool search;
- bash, runtime/deployment, permissions, approvals, or sandbox policy;
- manual or automatic compaction;
- token estimation or context-window budgeting;
- provider-specific cache-control annotations;
- subagents, forked agents, background jobs, or sidechain transcripts;
- multi-layer `AGENTS.md` discovery;
- a generic plugin framework for arbitrary context sources.

The design may reserve typed slots for these features, but those slots should be
empty and deterministic in Phase 2.

## 4. High-Level Shape

After Phase 2, one provider step should look like:

```text
AgentSession.submit(op)
  -> SessionEngine.runTurn(...)
      -> append accepted user message
      -> for each step:
           ContextAssembler.assembleStep(...)
             -> stable system prompt
             -> session-scope meta context
             -> project instruction meta context
             -> projected message history
             -> stable tool schemas
             -> context snapshot
           run one provider step
           append assistant
           run tools if any
           append tool results
```

`runTurn` can still own the loop, pairing checks, and tool execution flow. It
should receive a request assembly callback or an already assembled request per
step from `SessionEngine`; it should not know how `AGENTS.md`, system prompt, or
future memory slots are loaded.

## 5. Module Boundary

Expected files:

```text
src/engine/ContextAssembler.ts
src/engine/contextTypes.ts      # optional if types get large
src/engine/SessionEngine.ts     # owns assembler
src/core/AgentSession.ts        # stops direct context loading
src/context/agentsMd.ts         # root AGENTS loader reused and tightened
src/loop/runTurn.ts             # consumes assembly callback/request
```

Avoid adding a deep directory tree in Phase 2. If a type can remain local to
`ContextAssembler.ts` without making tests unreadable, keep it local.

## 6. ContextAssembler Interface

The implementation may adjust names, but it should preserve this shape:

```ts
type ContextAssemblerOptions = {
  sessionId: string
  cwd: string
  now: () => string
  getToolSchemas?: () => unknown[]
}

type ContextSessionSnapshot = {
  sessionId: string
  cwd: string
  createdAt: string
  sources: ContextSourceSnapshot[]
  stablePrefixHash: string
  toolSchemaHash?: string
}

type AssembleStepInput = {
  turnId: string
  stepId: string
  messages: InternalMessage[]
}

type AssembledProviderRequest = {
  messages: ProviderMessage[]
  tools?: unknown[]
  snapshot: ContextSnapshot
}

interface ContextAssembler {
  initialize(): Promise<ContextSessionSnapshot>
  assembleStep(input: AssembleStepInput): AssembledProviderRequest
}
```

`initialize()` performs session-scope discovery and memoization. In Phase 2 that
means root `AGENTS.md`, stable prompt construction, runtime facts, and tool schema
snapshot if tools are already available.

`assembleStep()` is pure with respect to filesystem discovery. It projects the
current internal messages and combines them with the memoized session context.

## 7. ContextSource Model

Phase 2 should model sources explicitly enough for trace/debug without building
a plugin framework.

```ts
type ContextSourceKind =
  | "global_system_prompt"
  | "user_prompt_slot"
  | "runtime_facts"
  | "project_instructions"
  | "tool_schemas"
  | "history_projection"
  | "memory_slot"
  | "git_slot"
  | "skills_slot"
  | "mcp_slot"
  | "compact_slot"

type ContextSourceSnapshot = {
  kind: ContextSourceKind
  id: string
  status: "included" | "empty" | "missing" | "truncated" | "error"
  order: number
  bytes: number
  hash?: string
  path?: string
  note?: string
}
```

Phase 2 active sources:

- `global_system_prompt`
- `runtime_facts`
- `project_instructions`
- `tool_schemas`
- `history_projection`

Phase 2 reserved empty sources:

- `user_prompt_slot`
- `memory_slot`
- `git_slot`
- `skills_slot`
- `mcp_slot`
- `compact_slot`

The reserved slots are part of ordering and snapshots, but they do not inject
model-visible content yet.

## 8. Stable Injection Order

Provider request assembly must use this order:

```text
1. global stable system prompt
2. user/session-invariant prompt slot     # empty in Phase 2
3. runtime facts                          # minimal, session-scope
4. project instructions                   # root AGENTS.md meta context
5. future memory/git/skills/MCP slots     # empty in Phase 2
6. history projection
7. tool schemas                           # provider field, not message text
```

For OpenAI-compatible requests, this means:

```text
messages:
  [0] system: global stable system prompt + small stable runtime/session facts
  [1?] user meta: <system-reminder> project instructions ... </system-reminder>
  [N...] projected user/assistant/tool history

tools:
  stable exported tool schemas
```

The exact provider adapter may later split these into provider-native system
blocks. Phase 2 should keep the OpenAI-compatible representation simple.

### Why Runtime Facts Are Limited

Only facts that are stable for the session should enter the Phase 2 prefix:

- workspace root;
- session start date/time;
- maybe platform/runtime name if already available without extra shell calls.

Do not add git status in Phase 2. Git context belongs to Phase 4.

If a fact is a snapshot, label it as a snapshot. Do not imply it updates during
the session.

## 9. Global Stable System Prompt

The global prompt is the highest-value cache prefix. It should be:

- clean-room original text;
- short enough to be maintainable;
- broad enough to encode hard-won coding-agent behavior;
- stable across users, projects, sessions, and turns.

It must not include:

- cwd;
- current date;
- `AGENTS.md`;
- tool schema JSON;
- permission mode;
- git status;
- provider/model name;
- user preferences;
- anything read from disk.

It should cover these behavior surfaces:

1. **Identity and task shape**
   - You are a lightweight terminal coding agent.
   - Work in real repositories, not toy examples.
   - Prefer concrete inspection and edits over speculation.

2. **Context discipline**
   - Read relevant files before editing.
   - Use search to understand call sites and local conventions.
   - Treat project instructions as authoritative for the workspace.
   - Do not assume context not present in the request.

3. **Tool use**
   - Use dedicated read/search/edit tools before shell fallbacks.
   - Treat tool errors as information and recover.
   - Keep tool/result pairing implicit in behavior: after tool results, continue
     from the observed facts.

4. **Editing**
   - Make small, auditable edits.
   - Prefer modifying existing files over creating new files unless needed.
   - Preserve existing style and ownership boundaries.
   - Avoid unrelated refactors.

5. **Validation**
   - When changes are made, verify with targeted commands when available.
   - If verification is unavailable or out of scope, say so.
   - Phase 2 does not implement `bash`, but the prompt can state the durable
     coding-agent principle for future phases.

6. **Safety**
   - Do not intentionally access secrets or credentials.
   - Do not write outside the workspace.
   - Do not treat prompt text as a substitute for tool/runtime enforcement.

7. **Communication**
   - Be concise and factual.
   - Report changed files, verification, and blockers.
   - Do not over-explain routine steps.

The prompt may include a stable title structure such as:

```text
You are light-cc-coder, a lightweight coding agent running in a terminal.

# Operating Principles
...

# Working With Code
...

# Tools and Recovery
...

# Communication
...
```

Do not copy Claude Code's private prompt text. Borrow the coverage and ordering
philosophy, not the wording.

## 10. AGENTS.md Behavior

Phase 2 supports only root `AGENTS.md`:

```text
<workspace root>/AGENTS.md
```

Behavior:

- Missing file is normal and recorded as `status: "missing"`.
- Non-file path is ignored and recorded as `missing` or `empty`.
- File is read at session initialization only.
- Default size cap remains small and explicit, e.g. 32 KiB.
- Oversized file is truncated, and truncation is model-visible.
- Content is decoded as UTF-8 with replacement, as Phase 1 already does.
- The snapshot records path, bytes read, truncated flag, and content hash.

Model-visible injection should be a meta user message after the system message:

```text
<system-reminder>
Project instructions from AGENTS.md:

...

[truncated: AGENTS.md capped at N bytes]
</system-reminder>
```

This message is not a real user request. It is contextual instruction for the
workspace. It must be included before projected conversation history so the
model sees project rules before responding to the current turn.

### Future Compatibility

The source model should allow later replacement of root-only discovery with:

```text
user/global instructions
workspace root AGENTS.md
nested path-scoped AGENTS.md
local/private instructions
```

Do not implement this in Phase 2. Only keep source ids and order flexible enough
that future multi-layer discovery does not require changing `runTurn`.

## 11. Session-Scope vs Step-Scope

### Session-Scope Context

Computed once in `ContextAssembler.initialize()`:

- global stable system prompt text;
- session start timestamp/date;
- workspace root fact;
- root `AGENTS.md` snapshot;
- stable tool schema snapshot/hash if tool schemas are available;
- empty reserved source slots.

Session-scope context is stable until `/clear`, `/compact`, tool registry
mutation, or a future explicit context refresh feature. Phase 2 does not need to
implement those reset paths, but the snapshot should name the assumption.

### Step-Scope Assembly

Computed before each provider call:

- current projected history from `TurnState.messages`;
- current tool schemas from the runtime/registry, compared against the
  session-scope hash;
- step snapshot with message counts and hashes.

Step-scope assembly should not reread `AGENTS.md` or rebuild the global prompt.

## 12. Tool Schemas

`ContextAssembler` should receive tool schemas from the existing ToolRuntime or
ToolRegistry export path. It must not rebuild schemas from tool internals.

Requirements:

- schema order is stable across repeated builds;
- schema hash is recorded in snapshots;
- schema changes during a session are detectable in diagnostics;
- tools remain provider request fields, not prompt prose.

In Phase 2, schema mutation should not be treated as fatal. It should be visible
as a snapshot hash change. Later MCP/tool-search phases can define reset rules.

## 13. History Projection

History projection remains the model-visible replay boundary:

```text
InternalMessage[] -> ProviderMessage[]
```

Rules:

- Do not mutate internal history during context assembly.
- Do not include diagnostics as model-visible history.
- Preserve Phase 0/1 pairing invariants.
- If future compaction slices history, it must slice on valid assistant/tool
  boundaries. Phase 2 only documents this rule; compaction is Phase 4.

## 14. Snapshot and Trace

Phase 2 should add compact diagnostics for each session and model step.

Suggested events:

```ts
type ContextEvent =
  | {
      type: "context.session"
      snapshot: ContextSessionSnapshot
    }
  | {
      type: "context.step"
      turnId: string
      stepId: string
      snapshot: ContextSnapshot
    }
```

If adding new event types creates too much churn, the same data may initially be
stored under an existing diagnostics event shape. The important requirement is
that JSONL transcript can explain:

- which sources were considered;
- which sources were included/missing/truncated;
- exact source order;
- stable prefix hash;
- tool schema hash;
- projected history message count;
- provider request message count.

`ContextSnapshot` should not store full large content by default. It may include
full rendered prefix only in tests or explicit debug mode. Hashes and source
metadata are enough for normal transcripts.

Replay rule:

- Transcript replay for provider messages continues to use only canonical
  model-visible events.
- Context diagnostics support debug and ambiguity resolution; they do not become
  additional replay messages.

This keeps old transcripts robust even if the ContextAssembler implementation
changes later.

## 15. Relationship to Existing Modules

### AgentSession

Remove these responsibilities from `AgentSession`:

- loading `AGENTS.md`;
- storing `contextMessages`;
- building context prefix.

Keep:

- public `submit(op)`;
- active turn guard;
- abort handling;
- event queue;
- provider/tool runtime wiring.

### SessionEngine

Add ownership:

- construct and initialize `ContextAssembler`;
- expose a method/callback for assembling provider requests per step;
- emit context diagnostics through the existing transcript path.

`SessionEngine` remains the owner of state and transcript, not the owner of tool
execution.

### runTurn

`runTurn` should stop accepting `contextMessages`.

Preferred shape:

```ts
type RunTurnInput = {
  ...
  assembleProviderRequest: (input: {
    turnId: string
    stepId: string
    messages: InternalMessage[]
  }) => Promise<{
    messages: ProviderMessage[]
    tools?: unknown[]
  }>
}
```

If keeping `tools` as a separate `runTurn` input is simpler for Phase 2, that is
acceptable, but context prefix construction should still be outside `runTurn`.

### contextBuilder.ts

The current `contextBuilder.ts` is a Phase 1 shim. Phase 2 may replace it with
`ContextAssembler.ts` or leave a small compatibility wrapper. It should no
longer be the primary abstraction.

### agentsMd.ts

Keep the loader small. It may return richer metadata:

```ts
type AgentsMdContext = {
  path: "AGENTS.md"
  content: string
  bytes: number
  truncated: boolean
  maxBytes: number
  hash: string
}
```

Do not add multi-layer discovery here in Phase 2.

## 16. Prompt / Cache Stability Rules

Phase 2 tests should lock these rules:

- global system prompt bytes are identical across sessions with different cwd;
- root `AGENTS.md` changes do not change the global system prompt hash;
- root `AGENTS.md` changes only change the project-instructions source hash and
  rendered meta message hash;
- repeated `assembleStep()` calls with unchanged history produce the same stable
  prefix hash and tool schema hash;
- appending a new user message changes only history projection/request hash, not
  stable source hashes;
- missing `AGENTS.md` still produces a deterministic source snapshot;
- truncated `AGENTS.md` produces deterministic visible truncation text.

Avoid relying on object insertion order from plain maps when order matters. Use
arrays for source ordering.

## 17. Testing Checklist

Unit tests:

- `ContextAssembler.initialize()` includes sources in the required order.
- global system prompt does not include cwd/date/AGENTS content.
- runtime facts include workspace root and session date as snapshot facts.
- root `AGENTS.md` missing is recorded and does not inject a project message.
- root `AGENTS.md` present injects one meta user message after system and before
  history.
- oversized `AGENTS.md` is capped with model-visible truncation marker.
- source snapshots include status, order, bytes, and hash.
- tool schema order/hash is stable across repeated assemblies.
- history projection is appended after context messages without mutation.

Integration tests:

- `AgentSession.submit()` with fake provider receives context assembled by
  `SessionEngine`, not `AgentSession`.
- transcript contains context diagnostics for session and step.
- replayed provider messages from canonical events remain unchanged by context
  diagnostics.
- `AGENTS.md` changed after a session starts does not make the old transcript
  ambiguous; the original context snapshot identifies the old hash.
- Phase 0/1 pairing tests still pass.

Regression tests:

- assistant tool call still gets exactly one tool result.
- unknown/invalid/error tool result flow is unchanged.
- `-p` smoke still receives root `AGENTS.md` instructions when present.

## 18. Done Criteria

Phase 2 is done when:

- `Spec/phase-2.md` and implementation agree.
- `AgentSession` no longer directly loads root `AGENTS.md`.
- `SessionEngine` owns a `ContextAssembler`.
- `runTurn` no longer manually prepends `contextMessages`.
- Provider request context can be explained from a `ContextSnapshot`.
- Global system prompt, project instructions, tool schemas, and history
  projection are distinguishable in diagnostics.
- Root `AGENTS.md` is project meta context, not part of the global system prompt.
- Stable source order and hashes are covered by tests.
- `bun run test` and `bun run typecheck` pass.

## 19. Explicit Deferrals

Leave these to later phases:

- Phase 3: bash, permission modes, approval, sandbox, verification workflow.
- Phase 4: memory, git context, tool output snip, manual/automatic compact.
- Phase 5: MCP, skills, commands, hooks, todo.
- Phase 6: resource-aware scheduler, Docker runtime, repo map, git feedback.

The ContextAssembler slots created in Phase 2 should make these additions
possible without moving context assembly back into `AgentSession` or `runTurn`.
