# Phase 7 Spec: Product Shell / Minimal Entry

Status: planned.

Phase 7 turns light-cc-coder from a runnable harness into a small product entry
that someone can install, open in a repository, and use repeatedly without
understanding internal test flags.

The first product shell is a reliable line-oriented terminal REPL. It is not a
full-screen TUI. The core agent loop, tool runtime, context assembler, and
transcript replay model remain unchanged.

## 1. Reference Conclusions

### 1.1 Claude Code

Claude Code is still the primary behavior reference. The relevant Phase 7
takeaways are product boundaries, not UI implementation details:

- interactive and headless entry points may render differently, but both should
  drive the same session abstraction;
- the product shell consumes events and submits operations, rather than owning
  loop state directly;
- approval, status, context, commands, and resume all need clear user-facing
  surfaces;
- local commands must not silently pollute model-visible history;
- rich full-screen UI, onboarding flows, settings panels, and session pickers
  are later product layers.

Phase 7 should preserve this interaction model without copying private source,
prompt text, React/Ink component structure, or product file layout.

### 1.2 Codex

Codex is useful for entry layering:

- a short installed command should open the interactive experience by default
  when attached to a TTY;
- one-shot execution should stay available for scripts and smoke tests;
- `doctor` should be read-mostly diagnostics, not an auto-fixer;
- JSONL transcript plus lightweight metadata is enough for a first session
  store;
- a public automation JSON event stream is valuable, but it is a separate
  product contract and should not block the interactive MVP.

### 1.3 Aider, CodeWhale, OpenHarness

These references mostly inform ergonomics:

- `/diff` should answer "what changed in this session or turn", not merely run
  a raw git command;
- config values should be explainable by source;
- diagnostics should separate ready, warning, and blocked checks;
- sessions should live under a user data directory by default, not inside every
  repository.

Auto-commit, rollback, repo maps, SQLite session graphs, setup wizards, and
complex product workflows are too large for this phase.

### 1.4 DeepSeek-Reasonix

Reasonix is useful for architecture constraints, not for direct product scope:

- central assembly from resolved config into provider, tools, permission gate,
  plugins, and frontend event sink is a good model for Phase 7 CLI setup;
- typed event streams decouple "what happened" from terminal rendering;
- permission policy and sandbox enforcement are separate layers;
- config layering keeps secrets in environment variables and reports where
  effective values came from;
- session persistence and resume are part of the product shell, but should stay
  behind the core session/replay owner.

Reasonix behavior not adopted in Phase 7:

- `setup` wizard;
- full Bubble Tea TUI;
- planner/executor or sub-agent flows;
- background jobs and persistent shell tasks;
- OS-level bash sandboxing;
- headless `ask` decisions auto-allowing when no approver exists.

light-cc-coder keeps its current fail-closed approval posture in non-interactive
contexts.

## 2. Settled Decisions

Phase 7 uses these product decisions:

- Installed command aliases:
  - `lightcc`
  - `light-cc`
  - keep `light-cc-coder` for compatibility.
- Default user data directory: `~/.lightcc`, overridable by `LIGHTCC_HOME`.
- No `-p` and interactive TTY means start the REPL.
- `-p` remains the one-shot mode.
- Resume is restricted to sessions whose recorded `cwd` matches the current
  resolved workspace root.
- Ctrl-C behavior:
  - while a turn or approval is active, first Ctrl-C aborts the current turn;
  - while idle, first Ctrl-C warns, second Ctrl-C exits;
  - Ctrl-D exits when idle.
- Full public `--json` automation stream is deferred. Phase 7 does not need a
  stable external event schema.
- Slash commands remain host/session commands by default and do not enter
  model-visible history unless a future command is explicitly designed as a
  model-visible prompt expansion.

## 3. Scope

Phase 7 may add:

- installable short bins;
- a shared CLI setup path for one-shot, REPL, doctor, dry-run, and resume;
- default transcript/session storage;
- session metadata sidecars or index files;
- interactive REPL with streaming assistant text and compact tool status lines;
- approval prompts integrated with the REPL input loop;
- Ctrl-C abort semantics;
- `doctor` and `--dry-run`;
- product slash commands;
- config layering with source reporting;
- resume from a validated transcript projection.

## 4. Non-Goals

Phase 7 must not implement:

- full-screen TUI;
- OAuth, account login, device-code auth, or provider account flows;
- setup wizard;
- plugin marketplace;
- public `--json` automation event stream;
- persistent approval or trust rules;
- rollback, undo, fork, or branchable conversations;
- IDE integration;
- persistent shell sessions or background jobs;
- OS-level sandbox backend;
- subagents, planner/executor split, or task delegation;
- automatic commit, push, or PR;
- SQLite session database or complex session graph.

## 5. Product Standard

Expected paths:

```bash
lightcc doctor
lightcc
```

```bash
lightcc -p "run the typecheck and summarize failures"
```

```bash
lightcc resume --last
```

Normal use should not require passing `--cwd`, `--transcript`, `--base-url`,
`--model`, and `--api-key-env` every time once configuration is present.

## 6. Architecture

High-level shape:

```text
bin/lightcc
  -> cli args + config resolver
  -> product mode:
       doctor | dry-run | one-shot | repl | resume
  -> session factory
       WorkspaceFs + LocalRuntime + RealToolRuntime + Provider + AgentSession
  -> event renderer
       stdout/stderr rendering + approval prompt + metadata updates
  -> AgentSession.submit(op) + AgentSession.events()
```

Ownership:

- CLI product modules own argument parsing, config resolution, session store,
  event rendering, and terminal input.
- `AgentSession` remains the only way the REPL submits user turns, approval
  responses, aborts, and compaction requests.
- `SessionEngine` remains the transcript/event owner and must remain the place
  where transcript write failure is fatal.
- `ContextAssembler` remains the only provider request assembly path.
- `ToolRuntime` remains the only tool execution path.
- Product commands may inspect exported session/tool/config snapshots, but must
  not execute hidden tools or mutate loop state directly.

Suggested module split:

```text
src/cli/
  main.ts              # thin entrypoint
  args.ts              # parse and validate CLI modes
  config.ts            # resolved config + source report
  sessionFactory.ts    # create AgentSession and shared runtime objects
  sessionStore.ts      # ~/.lightcc paths, metadata, session index
  eventRenderer.ts     # human terminal rendering
  approvalPrompt.ts    # serialized approval prompt
  repl.ts              # readline loop and Ctrl-C behavior
  doctor.ts            # readiness checks
```

This split is guidance, not a mandatory file layout, but the implementation
should keep product shell concerns out of `runTurn`, `ToolRuntime`, and
`ContextAssembler`.

## 7. Installable Bins

`package.json` should expose:

- `lightcc`;
- `light-cc`;
- `light-cc-coder` compatibility alias.

The first implementation may continue to use the Bun shebang entry directly.
Standalone packaging, npm publish automation, release installers, and shell
completion scripts are later work.

Acceptance:

- `bun link` or equivalent dev link exposes the short command;
- existing `bun src/cli/main.ts -p ...` smoke remains usable;
- one-shot CLI behavior remains backward compatible.

## 8. Config Layering

Phase 7 should resolve configuration once at CLI setup time and pass an
effective config into session creation.

Recommended precedence:

```text
defaults < global config < project config < environment < CLI flags
```

Locations:

- global config: `~/.lightcc/config.json`;
- project config: `.lightcc/config.json`;
- data root: `~/.lightcc`, overridden by `LIGHTCC_HOME`.

Rules:

- each effective value must carry a source label for `/config` and `doctor`;
- API keys should come from environment variables by default;
- project config must not store API keys or override secret values;
- provider `baseUrl`, `model`, and `apiKeyEnv` may come from global config,
  environment, or CLI flags;
- malformed config should produce a clear startup or doctor error;
- config resolution must not be done ad hoc inside provider, tool, or loop code.

Reasonix uses TOML, but Phase 7 should prefer JSON unless there is a deliberate
decision to add a TOML parser dependency.

## 9. Session Store

The session store lives under the data root:

```text
~/.lightcc/
  config.json
  sessions/
    <session-id>/
      transcript.jsonl
      metadata.json
  session_index.jsonl
```

`metadata.json` should contain at least:

- session id;
- cwd as resolved workspace root;
- model and provider identity;
- permission mode;
- transcript path;
- started time;
- updated time;
- last user prompt preview;
- last turn end reason;
- optional compact summary marker;
- optional git head/branch summary when Phase 6 data is available.

Transcript remains canonical. Metadata and index files are for listing and
resume UX. If metadata is stale, the implementation should be able to recover
or refresh it from transcript where possible.

Rules:

- default sessions should not be written into the repository;
- `--transcript` may still override the transcript path for smoke tests and
  advanced users;
- transcript write failure remains fatal;
- metadata/index update failure should be visible, but must not be represented
  as a model-visible message.

## 10. Resume

Supported entry points:

```bash
lightcc resume --last
lightcc resume <session-id>
```

REPL slash commands:

```text
/sessions
/resume <session-id|last>
```

Phase 7 constraints:

- resume only sessions whose stored `cwd` matches the current resolved
  workspace root;
- if a session belongs to another cwd, show it as unavailable or print a clear
  command to run from that cwd, but do not auto-switch directories;
- replay must validate transcript pairing before the session is resumed;
- resume must initialize internal message state from the transcript projection;
- resume must continue to use `ContextAssembler` for the next provider request;
- CLI must not directly splice provider messages into a request.

The likely core addition is an `AgentSession` or `SessionEngine` initialization
path that accepts validated `InternalMessage[]` from
`messagesFromEvents(readJsonlTranscript(path))`.

## 11. REPL

The MVP REPL is line-oriented:

- show a small startup line with session id, cwd, model, permission mode, and
  transcript path;
- read one prompt at a time;
- submit normal text through `AgentSession.submit({ type: "user_message" })`;
- render assistant deltas as they stream;
- render compact tool status lines;
- render command output;
- serialize approval prompts with the main input prompt;
- keep the session alive after recoverable errors;
- exit on `/quit`, `/exit`, idle second Ctrl-C, or idle Ctrl-D.

The REPL must not:

- maintain its own model-visible message history;
- run tools directly;
- skip `ToolRuntime` permission checks;
- create hidden transcript events outside `SessionEngine.emit()`;
- allow concurrent user turns.

## 12. Event Rendering

The human renderer should keep output compact:

- assistant text streams to stdout;
- tool calls and tool results render as one-line stderr status;
- approval prompt renders to stderr and reads one decision;
- command output renders to stdout;
- replay-invisible diagnostics stay hidden by default unless `--verbose` is
  set;
- final turn status should show completed, max steps, aborted, or error.

Example status style:

```text
Using bash (bun run typecheck)
Used bash (exit 0, 1.2s)
Used edit (src/foo.ts) ok
Denied bash (git push origin main)
```

Exact wording can evolve, but it should be stable enough for tests to assert
important facts without depending on decoration.

## 13. Approval Prompt

Approval continues to use the existing pending-promise flow:

```text
ToolRuntime -> approval.requested -> AgentSession.submit(approval.respond)
```

MVP prompt content:

- tool name;
- subject;
- cwd;
- permission reason;
- command or path preview when available.

MVP choices:

- allow once;
- deny.

Session allow rules and persistent trust rules are out of scope. Denial must
become a paired model-visible tool result through `ToolRuntime`.

Ctrl-C while approval is pending should deny or abort the current turn in a
deterministic way. The preferred MVP behavior is: Ctrl-C submits abort, pending
approval resolves deny, and the turn ends as aborted.

## 14. Doctor And Dry Run

`doctor`:

```bash
lightcc doctor
```

Checks:

- config files parse;
- effective provider config is complete enough to start;
- API key env var is present without printing the secret;
- cwd resolves and workspace boundary can be created;
- transcript/session store is writable;
- `rg` is available;
- git is available and whether cwd is a git worktree;
- permission mode is valid;
- MCP config files parse when configured;
- skill paths are readable when configured;
- builtin tool registry can be constructed.

Output categories:

- ready;
- warning;
- blocked.

`doctor` does not send model requests and does not run agent tools.

`--dry-run`:

```bash
lightcc --dry-run -p "..."
```

Dry-run should parse args, resolve config, create or validate the session plan,
and report what would be used. It must not call the provider, execute tools, or
write a normal transcript. It may check that the session store path would be
writable.

## 15. Product Slash Commands

Phase 7 command set:

- `/help`;
- `/status`;
- `/config`;
- `/context`;
- `/diff`;
- `/tools`;
- `/permissions`;
- `/compact [instruction]`;
- `/sessions`;
- `/resume <session-id|last>`;
- `/clear`;
- `/quit`;
- `/exit`.

Command classes:

- local diagnostic: emits `command.output`, no model history;
- session op: maps to an existing session operation, such as compact;
- host control: affects the REPL process, such as quit or clear;
- model-visible prompt expansion: reserved for later and not used by default in
  Phase 7.

`/diff` depends on Phase 6 git/turn-delta surfaces. If Phase 6 has not provided
changed-file data, `/diff` may print a clear unavailable message instead of
inventing a second git implementation.

`/context` should summarize actual `ContextAssembler` snapshots:

- source slots and status;
- stable prefix hash;
- tool schema hash;
- estimated tokens;
- history message count;
- compact status;
- active skills/MCP/todo state.

It should not dump the full prompt by default.

## 16. Phase Boundaries

Phase 6 dependency:

- `/diff` and changed-file status should consume Phase 6 git feedback or turn
  delta diagnostics.
- richer approval display may use Phase 6 approval metadata.
- provider retry/failure classification is Phase 6, not Phase 7.

Phase 8 dependency:

- performance spans and transcript profiling summaries stay out of Phase 7.
- event renderer may show simple duration already present in events, but it
  should not introduce the profiling system.

Phase 9 dependency:

- OS-level sandbox readiness checks may appear in doctor only after Phase 9.
- Phase 7 doctor should not claim OS sandbox enforcement exists.

Later:

- public `--json` automation stream;
- full-screen TUI;
- setup wizard;
- custom markdown commands;
- command autocomplete;
- keymap/theme/statusline customization;
- session search, rename, archive, export;
- persistent trust rules;
- persistent shell/background tasks.

## 17. Tests

Phase 7 should add focused tests for product-shell invariants:

- existing one-shot `-p --fake` still passes;
- no `--transcript` creates a default transcript and metadata under the data
  root;
- `lightcc` / `light-cc` / `light-cc-coder` resolve to the same entry;
- REPL accepts multiple prompts and keeps one `AgentSession`;
- slash diagnostics do not append `user.message`;
- `/compact` still writes compact events and remains replay-safe;
- approval allow/deny in REPL creates exactly one paired tool result;
- Ctrl-C abort leaves no orphan tool results and allows another prompt;
- idle double Ctrl-C exits;
- resume rejects malformed transcript pairing;
- resume from compacted transcript preserves pairing-safe active history;
- resume refuses sessions from a different cwd;
- doctor with missing provider config reports blocked and writes no transcript;
- dry-run writes no transcript and makes no provider request;
- transcript write failure remains fatal in default session store mode;
- metadata/index write failure is visible but does not affect
  `replayProviderMessages()`.

Use `bun run test` and `bun run typecheck` for verification. Do not run bare
`bun test`.

## 18. Completion Standard

Phase 7 is complete when a user with provider configuration can:

1. run `lightcc doctor` and understand whether the local setup is usable;
2. enter a repository and run `lightcc`;
3. have a multi-turn coding conversation in one persistent session;
4. approve or deny gated tool calls;
5. inspect status, config, tools, permissions, context, and diff availability;
6. exit and later resume the latest session from the same cwd;
7. run `lightcc -p "..."` for one-shot usage;
8. understand where transcript and session metadata were written.

All of this must preserve tool/result pairing, transcript fatality,
ContextAssembler ownership, ToolRuntime ownership, workspace write boundaries,
and replay validation.
