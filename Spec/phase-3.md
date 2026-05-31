# Phase 3 Spec: Shell, Permissions, Verification

Status: draft for Phase 3 implementation.

Phase 2 completed the Context Assembly boundary: provider requests now have a
stable context prefix, stable tool schema ordering, and replay/debug snapshots.

Phase 3 adds the first real command-execution and permission layer. The goal is
not to reproduce Claude Code's full Bash classifier or OS sandbox stack. The
goal is to make shell execution useful enough for real coding tasks while
preserving the existing invariants: every tool call gets exactly one
model-visible result, dangerous calls are gated before execution, and failures
such as denial, timeout, and sandbox boundary violations are fed back to the
model.

## 1. Settled Scope

Phase 3 uses the simpler boundary agreed after reference review:

- `bash` is completely denied in `read-only` mode.
- `danger-full-access` skips approval prompts, but still respects a hard
  denylist.
- Phase 3 does not implement a real OS-level sandbox for shell commands.
- Phase 3 does implement policy-level sandbox boundaries for built-in file tools
  and `apply_patch`.
- Phase 3 only implements `LocalRuntime` / `LocalDeployment`.
- Git handling is intentionally small: common read-only git inspection commands
  may be allowlisted; mutating git commands are hard denied.
- Verification is a normal `bash` command path, not a separate autonomous test
  runner or verification subagent.

## 2. Reference Conclusions

### 2.1 Claude Code

Claude Code's relevant behavior model:

```text
assistant tool_use
  -> schema/tool validation
  -> permission decision
  -> optional approval
  -> tool.call
  -> normalize output/error/denial/timeout into tool_result
  -> append user-side tool_result
  -> continue model loop
```

Important lessons to preserve:

- validation, denial, timeout, abort, and execution errors all become
  model-visible `tool_result` blocks;
- read-only tools can run concurrently, but mutating tools and `bash` run
  serially;
- shell execution tracks cwd, env, timeout, output limits, and process cleanup;
- permission is `allow | ask | deny`, with deny/safety checks winning over
  allow rules;
- approval is a pending runtime promise resolved by the UI/CLI/session layer;
- sandbox is an execution enforcement layer underneath permission, not a
  replacement for permission.

Do not copy:

- private prompt text or implementation structure;
- full Bash AST/security classifier;
- background shell jobs;
- React/TUI approval UI;
- classifiers, hooks, swarm/coordinator flows, MCP machinery, or subagents.

### 2.2 CoreCoder

CoreCoder is useful only as a compact bash test checklist:

- basic stdout;
- stderr and non-zero exit code;
- timeout;
- dangerous command blocked before execution;
- long output truncation.

Do not borrow its implementation. It runs shell directly in the tool, has no
runtime/deployment boundary, no process-group kill, no approval flow, and no
workspace-aware permission model.

### 2.3 DeepSeek-Reasonix

Reasonix is useful for the lightweight policy shape:

- pure policy core with `deny > ask > allow > fallback`;
- subject extraction from `command`, `path`, `file_path`, and `pattern`;
- approval request backed by a pending channel/promise;
- read-only batches may run concurrently, any writer/bash batch is serial;
- blocked calls return model-visible tool results.

Do not borrow its headless behavior where `ask` without an approver defaults to
allow. light-cc-coder fails closed: if a call needs approval and no responder is
available, the call is denied as a tool result.

### 2.4 Codex / CodeWhale / Reasonix Sandbox Lesson

The shared design lesson is:

```text
permission = policy decision
sandbox    = execution enforcement
```

Phase 3 keeps this conceptual split, but ships only a policy-level sandbox for
file boundaries. A real OS shell sandbox is deferred.

## 3. Goals

Phase 3 implements:

- a `bash` tool registered with the normal tool registry;
- a narrow `Runtime` / `Deployment` abstraction;
- `LocalRuntime.executeShell(...)`;
- command timeout with process-group cleanup;
- cwd tracking for shell commands;
- runtime env construction without model-provided env;
- stdout/stderr capture with bounded truncation;
- permission modes: `read-only`, `workspace-write`, `danger-full-access`;
- policy decisions: `allow`, `ask`, `deny`;
- approval events and response ops;
- hard shell denylist;
- tiny shell allowlist for safe git inspection commands;
- unified permission/sandbox policy for file tools, `apply_patch`, and `bash`;
- model-visible results for denied, timed out, aborted, sandbox-denied, and
  failed commands;
- transcript/replay support for approval and bash observations;
- minimal verification workflow through normal `bash`.

## 4. Non-Goals

Phase 3 must not implement:

- Docker;
- remote runtime;
- persistent shell sessions;
- background jobs;
- full TUI/REPL;
- complex policy DSL;
- full Bash parser or classifier;
- automatic commit/push/PR;
- MCP, skills, hooks, or custom commands;
- compaction;
- memory;
- git context injection;
- verification subagent;
- automatic test discovery beyond documenting a suggested command path;
- OS-level sandboxing such as bubblewrap, landlock, seccomp, Seatbelt, Windows
  restricted tokens, or containers.

## 5. Existing Invariants To Preserve

- The loop continues only from finalized assistant tool calls.
- Every assistant tool call gets exactly one model-visible tool result.
- Tool result order matches provider tool call order.
- Unknown tool, invalid input, permission denied, sandbox denied, timeout,
  abort, and runtime exception all become tool results.
- Transcript write failure remains fatal.
- Replay/projection still rejects missing, duplicate, orphan, reordered, and
  cross-turn tool results.
- Read-only tools may run concurrently.
- Any batch containing `bash` or a writer must run serially.
- Built-in file tools remain workspace-scoped.

## 6. High-Level Shape

```text
AgentSession.submit(op)
  -> SessionEngine.runTurn(...)
      -> ContextAssembler.assembleStep(...)
      -> provider step
      -> assistant.toolCalls
      -> ToolRuntime.runBatch(...)
          -> schema validation
          -> access summary
          -> PermissionPolicy.decide(...)
          -> optional ApprovalManager.request(...)
          -> SandboxPolicy.check(...)
          -> tool.execute(...)
              -> bash uses LocalRuntime.executeShell(...)
          -> normalize to ToolResult
      -> append tool results
      -> continue or finish
```

`ToolRuntime` remains the only place where tools are validated, permissioned,
scheduled, executed, normalized, and truncated. No built-in tool may bypass this
path.

## 7. Expected Module Boundary

Names may shift during implementation, but keep the boundary small:

```text
src/runtime/types.ts
src/runtime/LocalRuntime.ts
src/runtime/LocalDeployment.ts
src/permissions/types.ts
src/permissions/policy.ts
src/permissions/approval.ts
src/permissions/shellPolicy.ts
src/sandbox/policy.ts
src/tools/builtins/bash.ts
src/tools/ToolRuntime.ts
src/core/ops.ts
src/core/events.ts
src/engine/transcript.ts
```

Do not introduce a deep runtime framework. `LocalDeployment` can be a thin
factory that owns one `LocalRuntime`.

## 8. Runtime / Deployment

### 8.1 Runtime Interface

The runtime interface should be narrow:

```ts
type ExecuteShellInput = {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

type ExecuteShellResult = {
  command: string
  cwd: string
  finalCwd?: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutBytes: number
  stderrBytes: number
}

interface Runtime {
  executeShell(input: ExecuteShellInput): Promise<ExecuteShellResult>
}
```

No persistent shell session in Phase 3. `executeShell` is one-shot.

### 8.2 LocalRuntime Behavior

`LocalRuntime`:

- executes with `bash -lc <command>` on POSIX;
- starts in the session cwd, initially the workspace root;
- rejects cwd outside the workspace before spawning;
- captures final cwd after command execution when possible;
- updates session cwd only if final cwd is still inside the workspace;
- uses a bounded env built by the runtime, not model-provided env;
- passes at least `PATH`, `HOME`, `SHELL`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`,
  and `TERM` when present;
- sets `GIT_EDITOR=true`, `NO_COLOR=1`, and `LIGHT_CC_CODER=1`;
- does not expose an `env` field in the model-facing `bash` schema;
- caps captured stdout/stderr while the process runs;
- returns structured failure information instead of throwing for ordinary shell
  failures.

Phase 3 does not claim env secrecy is a complete security boundary. The key
MVP rule is that the model cannot inject arbitrary extra env through the bash
schema, and runtime output is still permissioned/truncated/transcribed.

### 8.3 Timeout And Process Cleanup

`LocalRuntime` must kill the whole process group on timeout or abort.

Expected POSIX behavior:

- spawn detached so the shell has its own process group;
- on timeout, send `SIGTERM` to `-pid`;
- after a short grace period, send `SIGKILL` to `-pid`;
- do not leave child or grandchild processes running;
- return `timedOut: true` as a model-visible tool result.

The implementation should avoid waiting forever on inherited stdout/stderr fds.
Tests must include a command that backgrounds a child and exits.

### 8.4 Output Truncation

Runtime output is capped before it can grow unbounded in memory.

Default Phase 3 limits:

- stdout: 32 KiB model-visible head+tail;
- stderr: 32 KiB model-visible head+tail;
- marker: `[truncated: kept head and tail of <stream>, original bytes=<n>]`.

The exact byte limit may be centralized with existing tool-output limits if that
keeps the implementation simpler.

## 9. Bash Tool

Model-facing schema:

```ts
type BashInput = {
  command: string
  timeoutMs?: number
  description?: string
}
```

Not in Phase 3 schema:

- `cwd`;
- `env`;
- `run_in_background`;
- `dangerouslyDisableSandbox`;
- persistent session id.

Timeout:

- default: 120 seconds;
- max: 600 seconds;
- invalid or oversized timeout is validation failure before permission.

Result formatting should be compact and model-readable:

```text
Command: <command>
Cwd: <cwd>
Exit code: <code or null>
Timed out: <true|false>

Stdout:
...

Stderr:
...
```

Rules:

- exit code `0` -> `isError: false`;
- non-zero exit -> `isError: true`, but include stdout/stderr;
- timeout -> `isError: true`;
- permission/sandbox denial -> `isError: true`;
- no output should still mention exit status.

Do not special-case `grep`, `rg`, `test`, or `diff` exit semantics in Phase 3.
That can be revisited after the MVP is stable.

## 10. Permission Model

### 10.1 Modes

```ts
type PermissionMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"

type PermissionDecision =
  | { kind: "allow"; reason: string }
  | { kind: "ask"; reason: string; subject: string }
  | { kind: "deny"; reason: string }
```

Mode behavior:

- `read-only`
  - allow `read`, `grep`, and `glob`;
  - deny `edit`, `write`, `apply_patch`;
  - deny `bash` completely.
- `workspace-write`
  - allow file writes inside workspace if sandbox policy allows them;
  - allow read-only tools;
  - allow tiny git inspection allowlist;
  - ask for all other `bash`;
  - hard deny sensitive paths and shell denylist.
- `danger-full-access`
  - allow read and file writer tools, still using the built-in file tool
    workspace boundary;
  - allow `bash` without approval;
  - still hard deny sensitive paths and shell denylist;
  - record audit/permission events.

`danger-full-access` is deliberately not a request to implement arbitrary
outside-workspace file-tool writes. Built-in file tools remain project-scoped.
If a user truly wants arbitrary host access, that is a future explicit feature,
not Phase 3.

### 10.2 Decision Order

Permission checks run in this order:

1. schema validation;
2. tool access summary extraction;
3. hard sensitive path deny;
4. hard shell denylist;
5. mode-specific deny/allow;
6. static allowlist;
7. approval ask;
8. sandbox policy check immediately before execution.

Deny always wins.

### 10.3 Subject Extraction

The policy layer extracts a human-readable subject from args:

- `command` for `bash`;
- `path` for file tools;
- `file_path` when future tools use that name;
- `pattern` for search/glob;
- fallback to compact JSON for unknown tools.

Subject extraction is for policy, audit, and approval display. It is not a
security parser.

## 11. Shell Policy

### 11.1 Hard Denylist

The hard denylist blocks before approval and before spawn.

Minimum entries:

- `rm -rf /`;
- `rm -rf ~`;
- fork bomb patterns such as `:(){ :|:& };:`;
- `mkfs`, `mkswap`, and disk formatting commands;
- `dd` writing to `/dev/...`;
- `curl ... | sh`, `curl ... | bash`, `wget ... | sh`, `wget ... | bash`;
- `git push`;
- `git commit`;
- `git reset --hard`;
- `git clean`;
- `git rebase`;
- `git merge`;
- `git checkout -- ...`;
- `git restore ...`;
- `git stash`.

This is a conservative string/predicate MVP, not a complete Bash security
engine. If a command is too ambiguous to classify, workspace-write should ask,
not allow.

### 11.2 Tiny Git Inspection Allowlist

In `workspace-write` and `danger-full-access`, these may be allowed without
approval:

- `git status`;
- `git diff`;
- `git log`;
- `git show`;
- `git rev-parse`;
- `git branch --show-current`;
- `git grep`.

Keep matching simple and exact/prefix-based. Do not implement general git
semantic parsing in Phase 3.

All non-allowlisted `bash` commands in `workspace-write` ask for approval unless
hard denied.

## 12. Sandbox Policy

Phase 3 sandbox is **policy-only**, not OS isolation.

### 12.1 File Tools

For `read`, `grep`, `glob`, `edit`, `write`, and `apply_patch`:

- resolve paths through the existing workspace path boundary;
- reject `..` escape and symlink escape;
- reject sensitive paths such as `.env`, SSH keys, private keys, credentials,
  and token files;
- make denied writes model-visible;
- never partially apply a multi-file patch when one target fails policy.

These checks are the Phase 3 sandbox enforcement layer for file tools.

### 12.2 Bash

For `bash`:

- no OS jail is applied in Phase 3;
- the runtime still enforces cwd-in-workspace before spawn;
- command permission policy and hard denylist run before spawn;
- approved bash may still affect the host outside the workspace because there is
  no OS sandbox yet;
- approval text and docs must not imply otherwise.

If a future OS backend is unavailable or denies execution, the resulting error
must become a model-visible `sandbox_denied` or `sandbox_unavailable` tool
result. Phase 3 only reserves that shape.

## 13. Approval Flow

Approval is session-owned, not tool-owned.

New operation shape:

```ts
type ApprovalRespondOp = {
  type: "approval.respond"
  approvalId: string
  decision: "allow" | "deny"
}
```

New events:

```ts
type ApprovalRequestedEvent = {
  type: "approval.requested"
  approvalId: string
  turnId: string
  toolCallId: string
  toolName: string
  subject: string
  reason: string
}

type ApprovalRespondedEvent = {
  type: "approval.responded"
  approvalId: string
  decision: "allow" | "deny"
}
```

Behavior:

- `ToolRuntime` asks `ApprovalManager` when policy returns `ask`;
- `ApprovalManager` emits `approval.requested` and returns a promise;
- `AgentSession.submit({ type: "approval.respond", ... })` resolves that
  promise;
- allow continues execution;
- deny returns a denied tool result;
- abort cancels pending approvals and returns aborted/denied tool results;
- if no approval responder is available, the ask fails closed as denied;
- Phase 3 does not need persistent allow rules or allow-for-session.

## 14. Tool Result Normalization

Add normalized error kinds where useful:

```ts
type ToolErrorKind =
  | "invalid_input"
  | "permission_denied"
  | "sandbox_denied"
  | "sandbox_unavailable"
  | "timeout"
  | "aborted"
  | "runtime_error"
  | "tool_error"
```

The exact type may extend existing result types, but model-visible content must
include:

- what was attempted;
- whether it was denied/timed out/aborted/failed;
- enough stdout/stderr or diagnostic detail for the model to adapt;
- a clear instruction not to retry hard-denied commands blindly.

## 15. Verification Workflow

Phase 3 verification is intentionally minimal.

There is no new verification tool. Verification is a normal `bash` command,
usually after file edits or patches.

Required behavior:

- after modifying code, the model can call `bash` with a targeted test command;
- that command follows the same permission, approval, timeout, and truncation
  path as every other shell command;
- the transcript records the command and its model-visible result;
- final assistant responses should be able to report which verification command
  ran and whether it passed.

No automatic test discovery, no automatic post-edit test runner, and no
verification subagent in Phase 3.

## 16. Transcript / Replay

Transcript records more than provider messages, but replay remains based only on
model-visible message events.

Add or extend event coverage for:

- `approval.requested`;
- `approval.responded`;
- `permission.decision` if useful for audit;
- `bash.observation` if useful for structured diagnostics;
- existing `tool.call`;
- existing `tool.result`.

Replay rules:

- approval and diagnostic events do not project into provider messages;
- replay does not re-request approval;
- denied approval is replayed through the stored `tool.result`;
- timed-out bash is replayed through the stored `tool.result`;
- output truncation markers are part of the stored model-visible result;
- tool/result pairing validation remains unchanged and strict.

## 17. Test Plan

### 17.1 Runtime Tests

- `echo hello` captures stdout and exit code `0`.
- command writing stderr captures stderr.
- non-zero exit returns `isError: true` and includes exit code.
- timeout returns `timeout` tool result.
- timeout kills child/grandchild process group.
- background child holding stdout/stderr does not hang completion forever.
- output truncates head+tail and records byte counts.
- cwd starts in workspace.
- `cd subdir && pwd` updates session cwd when final cwd is inside workspace.
- final cwd outside workspace does not update session cwd.

### 17.2 Permission Tests

- `read-only` allows `read`, `grep`, `glob`.
- `read-only` denies `edit`, `write`, `apply_patch`.
- `read-only` denies all `bash`.
- `workspace-write` allows workspace file writes.
- `workspace-write` asks for normal `bash`.
- `workspace-write` allows the tiny git inspection allowlist.
- `danger-full-access` runs non-denied bash without approval.
- hard denylist blocks in every mode, including `danger-full-access`.
- sensitive paths are denied in every mode.
- ask without approval responder returns denied tool result.

### 17.3 Approval Tests

- approval request event contains id, tool call id, tool name, subject, reason.
- approval allow path executes the tool and returns real result.
- approval deny path does not execute the tool and returns denied result.
- abort cancels pending approval and preserves tool/result pairing.
- stale or duplicate approval response is handled deterministically.

### 17.4 Sandbox Policy Tests

- file write outside workspace is denied as model-visible result.
- symlink escape is denied.
- multi-file `apply_patch` does not partially write if one path is denied.
- bash cwd outside workspace is denied before spawn.
- bash denial is recorded even though no OS sandbox exists.

### 17.5 Transcript / Replay Tests

- approval events are persisted.
- approval events do not project into model history.
- denied approval still has exactly one tool result.
- timeout still has exactly one tool result.
- replay validates tool/result pairing after bash observations.
- replay of a verification command preserves truncated output.

### 17.6 End-To-End Tests

- fake provider edits a file, then requests a test command; approval allow lets
  the command run and the next model step sees the result.
- fake provider requests a dangerous command; the command is denied before spawn
  and the next model step sees the denial.
- fake provider in `read-only` requests bash; bash is denied and pairing remains
  correct.

## 18. Completion Criteria

Phase 3 is complete when:

- `bash` is available through `LocalRuntime`;
- command timeout, process-group cleanup, stdout/stderr capture, cwd tracking,
  and output truncation are tested;
- `read-only`, `workspace-write`, and `danger-full-access` modes work;
- approval request/response works without a full REPL;
- denied, timed-out, sandbox-denied, and failed tools are model-visible results;
- file tools and `apply_patch` use the same permission/sandbox policy path;
- dangerous shell commands do not execute directly;
- a code-edit plus targeted verification command workflow works in an
  integration test;
- transcript/replay remains strict and unambiguous.
