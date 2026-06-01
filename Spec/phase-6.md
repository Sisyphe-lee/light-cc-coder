# Phase 6 Spec: Dogfood Hardening

Status: planned.

Phase 6 hardens the existing coder kernel for real small/medium repository
dogfood. It is not the product shell phase and it is not the profiling phase.

The goal is simple: after a real task, the user and the model should be able to
answer:

- what changed;
- why a tool ran;
- what permission or approval decision happened;
- what verification happened;
- what failed and how the session continued.

Phase 6 should make those facts observable without widening the core product
surface or weakening replay/tool-result invariants.

## 1. Reference Conclusions

### 1.1 Claude Code

Claude Code is the primary behavior reference. The relevant behavior model is:

- tool execution is visible and auditable, not a black box;
- approval prompts show concrete action context before risky execution;
- file and git feedback help both the user and model inspect changes;
- failed edit/test/tool results are fed back to the model so it can recover;
- todo/task state helps long tasks converge without creating a separate planner;
- diagnostics explain system behavior but do not replace paired tool results.

Phase 6 should preserve this core workflow, not copy product UI, private prompt
text, internal file layout, or broad product features.

### 1.2 DeepSeek-Reasonix

Reasonix is useful for kernel constraints:

- keep provider prefix/cache inputs stable;
- separate replay-invisible diagnostics from model-visible history;
- keep permission policy separate from sandbox/runtime failures;
- classify provider failures before retrying;
- keep read-only tools distinct from write/shell/opaque tools.

For Phase 6 this means dynamic git/diff/verification state must not be
automatically injected into the stable prefix by default. If the model needs git
state, it should get it through an explicit paired tool result.

### 1.3 Codex, Aider, Kimi

Codex reinforces `submit(op) + events()` and approval as a session pending
promise. Aider reinforces diff/test/edit failure feedback, but its auto-commit,
undo, and repo-map machinery are too heavy for Phase 6. Kimi reinforces typed
tool lifecycle events and provider retry before committing assistant history.

## 2. Settled Decisions

Phase 6 uses the following conservative decisions:

- Add `git_feedback` as a read-only builtin tool.
- Keep `git_slot` reserved by default; do not automatically inject dynamic git
  state into normal provider requests in Phase 6.
- Add a minimal host-only `/diff` surface. It emits `command.output` or
  replay-invisible diagnostics, not model-visible user/tool messages.
- Provider retry only happens before an assistant message is committed. If a
  provider step has already emitted assistant deltas, Phase 6 does not retry
  that failed step.
- Approval remains `allow once` or `deny`; persistent trust rules are out of
  scope.
- Diagnostics remain replay-invisible unless intentionally represented as a
  paired tool result.
- No git mutation is introduced: no commit, push, reset, checkout, clean, stash,
  rebase, or merge.

## 3. Non-Goals

Phase 6 must not implement:

- interactive REPL or install/config product shell;
- rich diff UI, file picker, session browser, or product `/status`;
- profiling spans and transcript profiling summaries;
- Docker or OS-level shell sandbox;
- persistent shell sessions;
- background jobs;
- full repo map/codegraph;
- resource-aware scheduler;
- subagents or planner/executor split;
- automatic test discovery or verification subagent;
- automatic commit, push, PR, rollback, or undo;
- persistent approval/trust rules.

## 4. Existing Invariants To Preserve

- `ToolRuntime` remains the only tool execution path.
- `ContextAssembler` remains the provider request assembly path.
- Tool/result pairing remains exactly one model-visible tool result for every
  assistant tool call.
- Denials, timeouts, sandbox denials, runtime failures, hook blocks, aborts, and
  tool exceptions remain model-visible tool results when a tool call exists.
- Transcript write failure remains fatal.
- Replay/projection still rejects missing, duplicate, orphan, reordered, and
  cross-turn tool results.
- Diagnostic events do not affect `replayProviderMessages()`.
- Workspace write boundaries and sensitive path denials remain unchanged.
- MCP tools continue to enter only by registering normal tools in
  `ToolRuntime`.

## 5. Architecture

High-level shape:

```text
AgentSession.submit(op)
  -> slash commands / approval responses / normal turns
  -> runTurn(...)
       -> ContextAssembler.assembleStep(...)
       -> provider step with bounded retry diagnostics
       -> ToolRuntime.runBatch(...)
            -> permission decision
            -> optional approval request with richer display metadata
            -> execute builtin/MCP tools
            -> normalize paired tool results
       -> append paired tool results
       -> emit replay-invisible turn/verification diagnostics after pairing
```

Ownership:

- `AgentSession` remains the entry point and active-turn guard. It may expose
  retry/config options and slash command routing, but it must not execute git,
  shell, or file operations directly.
- `SessionEngine` owns transcript emission, replay-invisible diagnostics, and
  any lightweight status snapshot used for host output.
- `ContextAssembler` keeps source order stable. In Phase 6, `git_slot` remains
  empty/reserved unless a later explicit decision enables bounded git context.
- `ToolRuntime` owns permission, approval metadata, tool execution, result
  normalization, truncation, and artifact behavior.
- Builtin tools own their domain-specific observation formatting. New git
  behavior must be a normal builtin tool.

## 6. Git Feedback

### 6.1 `git_feedback` Tool

Add a read-only builtin tool named `git_feedback`.

It should report a bounded snapshot:

- whether the workspace is inside a git repository;
- repository root if available;
- current branch or detached HEAD;
- short HEAD sha if available;
- dirty state summary;
- staged, unstaged, and untracked files;
- diff stat;
- bounded diff preview.

The tool must:

- run only fixed internal git inspection operations, not model-provided shell
  fragments;
- operate under `ToolRuntime` permission/result/truncation/artifact handling;
- be allowed in `read-only` mode;
- never require approval in `workspace-write` mode;
- cap file lists and diff bytes;
- use safe git diff options where applicable, such as no external diff drivers
  and no textconv;
- redact diff content for sensitive paths while still reporting that the path
  changed;
- return a clear observation for non-git workspaces instead of throwing an
  unstructured error.

The model-visible result is the main way the model learns git state in Phase 6.

### 6.2 `git_slot`

`git_slot` stays reserved by default in Phase 6.

Reason: dynamic git state changes often and would perturb provider request
hashes and prefix/cache behavior. This follows the Reasonix-style constraint:
keep stable prefix inputs stable, and use explicit tools for dynamic facts.

A later phase may enable a tiny bounded git context source after the cache and
replay impact is measured.

## 7. Turn Diff / Changed Files

Phase 6 should expose changed files without relying only on final assistant
prose.

Minimum surface:

- add a host-only `/diff` slash command;
- emit a replay-invisible `turn.changed_files` diagnostic when a turn has known
  file changes;
- show changed file names and, if available, diff stat or a bounded summary.

Rules:

- `/diff` must not append a model-visible `user.message`;
- `/diff` must not create orphan `tool.result` events;
- full diff content should come from `git_feedback` or host output, not from an
  automatic context injection;
- change diagnostics must be emitted only after paired `tool.result` events have
  been persisted, so a diagnostic write failure does not create an unpaired tool
  call in transcript replay.

The first implementation may derive changed files from successful write-capable
tool calls and/or the latest `git_feedback` snapshot. It does not need a full
working-tree watcher.

## 8. Approval Display

Approval behavior remains the existing pending-promise flow:

```text
ToolRuntime -> approval.requested -> AgentSession.submit(approval.respond)
```

Phase 6 enriches the request/display metadata.

`approval.requested` should include, where available:

- `cwd`;
- `permissionMode`;
- `toolName`;
- `toolDescription`;
- `subject`;
- policy reason;
- model-provided tool reason, such as `bash.description`;
- bounded input summary;
- read/write/search access summary;
- risk summary.

Risk summary is heuristic display text, not a new permission authority. The
actual allow/ask/deny decision remains owned by permission policy.

The CLI should display the enriched metadata. It still supports only:

- allow once;
- deny.

Persistent approval rules, trust stores, and project policies are Phase 7/later.

## 9. Provider Retry And Failure Classification

Phase 6 adds bounded provider retry for transient failures.

Retryable classifications:

- rate limit / 429;
- timeout / 408 when no assistant content has been committed;
- 5xx provider errors;
- network errors;
- stream drop before any assistant delta.

Non-retryable classifications:

- abort / user interrupt;
- auth errors such as 401/403;
- ordinary 4xx invalid request errors;
- malformed provider responses that are unlikely to be transient;
- failures after assistant deltas have already been emitted;
- tool execution failures.

Context overflow remains on the existing compact/retry path. It should be
diagnosed, but not mixed into ordinary transient retry.

Retry behavior:

- retry only before appending `assistant.message`;
- default to a small bounded count, for example two retries;
- use bounded backoff;
- emit replay-invisible `provider.retry` diagnostics for attempts;
- emit replay-invisible `provider.failure` diagnostics when giving up;
- do not mutate active history until a provider step succeeds.

Tests may configure retry delay to zero.

## 10. Todo Discipline

The existing session-scoped `todo` tool remains the only todo system.

Phase 6 hardens it with one invariant:

- at most one todo item may be `in_progress`.

If a `todo replace` input violates this rule:

- return exactly one paired error tool result;
- do not update todo state;
- do not emit `todo.updated`;
- keep replay and compact behavior unchanged.

Phase 6 does not add background tasks, nested subtasks, subagents, or a
planner/executor split.

`blocked` status is deferred unless a later implementation decision explicitly
pulls it into Phase 6.

## 11. Verification Ergonomics

Phase 6 does not discover tests automatically. It makes explicit verification
more visible.

Minimum behavior:

- preserve the existing bash tool result path for verification output;
- include `bash.description` in bash diagnostics and approval display;
- emit a replay-invisible `verification.observed` diagnostic for likely
  verification commands or bash calls explicitly described as verification;
- remember the latest verification observation for host summaries.

`verification.observed` should include:

- command;
- cwd;
- optional description;
- exit code;
- timed-out flag;
- duration;
- status: passed, failed, timed out, or unknown;
- bounded output metadata, not full duplicated stdout/stderr.

Failing verification output must continue to reach the model through the normal
paired bash tool result. Diagnostics are only for explanation and host display.

## 12. Diagnostic Events

Phase 6 may add replay-invisible events such as:

- `git.feedback`;
- `turn.changed_files`;
- `provider.retry`;
- `provider.failure`;
- `verification.observed`.

Rules:

- diagnostics are written through `SessionEngine.emit()`;
- transcript write failure remains fatal;
- diagnostics must not affect `messagesFromEvents()` or
  `replayProviderMessages()`;
- diagnostics may be used by a lightweight `replayStatusState(events)` helper,
  but that helper must not change provider message projection.

A transcript health scanner may be added if it stays read-only and local:

- orphan/missing/reordered tool results;
- incomplete steps;
- failed compact checkpoints;
- unresponded approvals.

This scanner is useful but not required for the first Phase 6 closed loop.

## 13. CLI / Host Output

The existing `-p` CLI may be improved only as a thin event consumer.

Allowed improvements:

- clearer `tool.call` lines with bounded subject summaries;
- enriched approval prompt display;
- `tool.result` ok/error status;
- minimal turn-end summary from diagnostics: changed files and latest
  verification result;
- host-only `/diff` output.

Not allowed in Phase 6:

- interactive REPL;
- rich/fullscreen UI;
- default session store;
- session picker or resume command;
- config profiles or doctor command.

Those belong to Phase 7.

## 14. Test Plan

Required tests:

- `git_feedback` works in `read-only` mode and does not request approval in
  `workspace-write` mode.
- `git_feedback` reports non-git workspaces clearly.
- `git_feedback` caps file lists and diff preview.
- `git_feedback` redacts sensitive path diff content.
- `/diff` does not append `user.message`, does not call provider, and does not
  create `tool.result`.
- New diagnostics are ignored by `replayProviderMessages()`.
- Approval request events include the new display metadata for bash and opaque
  MCP tools.
- Provider retry records classification and attempt diagnostics for transient
  pre-delta failures.
- Provider retry does not run for abort, auth/ordinary 4xx, context overflow, or
  failures after assistant deltas.
- Context overflow still uses the existing compact/retry path.
- Failed provider steps do not append partial assistant history.
- Multiple `in_progress` todo items produce exactly one paired error result and
  no `todo.updated`.
- Verification failures remain visible in the next provider request through the
  paired bash tool result.
- `verification.observed` is bounded and replay-invisible.
- Diagnostic transcript write failure remains fatal without violating
  tool/result pairing.

Validation commands remain:

- `bun run test`;
- `bun run typecheck`.

Do not use bare `bun test`.

## 15. Completion Standard

Phase 6 is complete when a real small/medium repository task leaves enough
evidence in tool results, CLI output, and transcript diagnostics to reconstruct:

- files changed;
- git/workspace state requested by the model or user;
- commands run and why they were approved or denied;
- verification command and result;
- provider retry/failure behavior when it happened;
- remaining blocker or next step.

The implementation must not break:

- tool/result pairing;
- replay;
- compact checkpoints;
- workspace write boundaries;
- transcript fatal semantics;
- cache-friendly context assembly.
