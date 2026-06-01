# Phase 9 Spec: Optional OS Sandbox Backend

Status: near-term minimal loop implemented; product-grade packaging remains
pending.

Phase 9 adds an optional OS-level sandbox backend for shell execution. The
candidate backend is the public Apache-2.0 package
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).

The product goal is still a lightweight, fast, usable TypeScript coder harness.
Sandboxing is a pluggable execution backend, not a new product architecture and
not a safety claim.

## 1. Hard Boundary

The default harness must stay clean and runnable without the sandbox package.

Required properties:

- `LocalRuntime` remains the fallback execution path and the explicit `off` path.
- No core module may statically import `@anthropic-ai/sandbox-runtime`.
- `Runtime`, `ToolRuntime`, `bash`, permission policy, workspace boundary,
  transcript, replay, provider projection, and context assembly must not depend
  on sandbox-runtime types or package availability.
- The sandbox backend is loaded only when the effective sandbox mode is
  `auto|required`. Phase 9 currently defaults to `auto`; `off` is the explicit
  no-load mode.
- If the package is missing, ordinary light-cc-coder usage still runs, tests, and
  typechecks.
- All interaction with the external package is isolated under a small runtime
  adapter, for example `src/runtime/sandbox/*`.

This keeps the demo/source tree focused on the coder harness. The sandbox is a
replaceable backend behind our own `Runtime` interface.

## 2. Existing Safety Model Stays In Place

Phase 9 must not move or weaken existing checks:

- permission policy still decides `allow | ask | deny`;
- `read-only`, `workspace-write`, and `danger-full-access` keep their Phase 3
  semantics;
- shell denylist still blocks known dangerous commands before approval and
  before spawn;
- workspace path boundary still protects built-in file tools and `apply_patch`;
- `ToolRuntime` still owns schema validation, permission, approval, hooks,
  execution, result normalization, truncation, and exactly-one tool/result
  pairing;
- transcript write failure remains fatal;
- replay still projects only model-visible messages and tool results.

Sandboxing is defense-in-depth below `Runtime.executeShell`.

## 3. Integration Shape

Keep the current tool path:

```text
bash tool
  -> ToolRuntime validation / permission / approval / hooks
  -> Runtime.executeShell(...)
  -> optional sandbox backend wraps the shell command
  -> local process execution
  -> ExecuteShellResult or RuntimeExecutionError
  -> exactly one paired tool result
```

The first implementation should add:

- `SandboxedLocalRuntime implements Runtime`, or a deployment/factory that
  returns `LocalRuntime` or `SandboxedLocalRuntime`;
- a thin local adapter type that describes only the sandbox-runtime module shape
  light-cc-coder calls;
- a dynamic backend loader that validates the external module shape at runtime;
- no model-facing changes to the `bash` schema.

The adapter must preserve current `LocalRuntime` behavior:

- cwd starts inside the workspace;
- final cwd is reported, but runtime cwd updates only when final cwd remains in
  the workspace;
- timeout and abort kill the process tree;
- stdout/stderr are captured and head/tail truncated by light-cc-coder;
- runtime env remains bounded and not model-controlled;
- normal non-zero shell exit remains a shell result, not an exception.

## 4. Dependency Isolation

The sandbox package should be optional.

Implementation guidance:

- Do not use static imports from `@anthropic-ai/sandbox-runtime` in core code.
- Avoid external package types in exported public harness types.
- Prefer a dynamic import hidden behind a small loader, then validate methods
  such as `initialize`, `checkDependencies`, `wrapWithSandbox`,
  `cleanupAfterCommand`, and `reset`.
- Unit tests for the sandbox adapter should use an injected fake module so the
  main test suite does not require OS sandbox dependencies.
- E2E tests against the real backend should be opt-in and skipped with explicit
  diagnostics when unsupported.

`bun run test` and `bun run typecheck` must continue to pass in an environment
where sandbox-runtime is not installed.

## 4.1 Packaging Strategy

Phase 9 uses a two-tier packaging direction.

Near-term minimal packaging:

- keep `@anthropic-ai/sandbox-runtime` as an optional install-time package;
- keep all runtime use behind dynamic import and local shape validation;
- keep `auto` fallback and `required` fail-closed semantics unchanged;
- use `doctor --sandbox` to report package/submodule availability, platform,
  `bwrap`/`socat`/`rg`, optional seccomp helper, user namespaces, AppArmor, and
  fallback reasons;
- allow source checkout development to use the root `sandbox-runtime/` submodule
  dist as a fallback loader path, without copying upstream source into `src/`.

Product-grade one-command packaging:

- evaluate a Codex-style npm meta package plus platform-specific optional
  resource packages;
- bundled resources may include audited `bwrap`, `rg`, seccomp helper, and a
  replacement or bundled equivalent for `socat` where license/platform support
  is clear;
- runtime should prefer system helpers when usable and fall back to bundled
  helpers only when available and compatible;
- do not use npm `postinstall` to install apt/brew/system packages;
- do not describe npm installation as a safety guarantee. The product surface
  reports sandbox availability/status, not an absolute claim.

## 5. Backend Facts To Rely On Conservatively

As of the Phase 9 design discussion on 2026-06-01:

- npm latest observed: `@anthropic-ai/sandbox-runtime@0.0.52`;
- license: Apache-2.0;
- status: public beta/research preview, APIs may change;
- package exposes `srt` CLI and a TypeScript library API;
- macOS uses `sandbox-exec` / Seatbelt;
- Linux uses `bubblewrap`, network namespaces, proxy bridging, `socat`, `rg`,
  and optional seccomp Unix socket blocking;
- npm `0.0.52` should be treated as macOS/Linux only for Phase 9;
- Windows support is out of scope even if upstream development branch contains
  Windows-related work.

Before implementation, verify the package version and public API again. Do not
copy upstream implementation code.

## 6. CLI / Config

Minimal user-facing flags:

```text
--os-sandbox off|auto|required
--sandbox-settings <path>
--sandbox-allow-domain <domain>
--sandbox-allow-write <path>
```

Mode semantics:

- `off`: use `LocalRuntime`. No sandbox package is loaded.
- `auto`: default. Try to enable sandboxing. If platform or dependency checks fail, fall
  back to `LocalRuntime` and emit a replay-invisible diagnostic. Do not describe
  the command as sandboxed when fallback happens.
- `required`: fail closed. If sandboxing cannot be initialized or command
  wrapping fails before spawn, do not run the command. Return
  `sandbox_unavailable` as the paired tool result.

Nuance:

- `auto` may fail open for missing optional dependency, unsupported platform, or
  missing OS helper.
- Invalid explicit settings should fail closed. Running without the requested
  policy would be more surprising than refusing to run.
- Generated default config bugs should fail closed in `required` and should emit
  a clear diagnostic in `auto`.
- Do not auto-discover `.srt-settings.json` from the repo or home directory in
  Phase 9. A settings file is used only when explicitly passed.

## 7. Default Sandbox Policy

The default policy should be conservative and usable for local verification.

Filesystem:

- writes allowed to the workspace root;
- writes allowed to a light-cc-coder runtime temp directory needed for cwd
  markers and sandbox helper artifacts;
- writes denied to sensitive files and config surfaces, including `.env*`,
  private keys, SSH/cloud/kube/docker credentials, shell startup files, git
  hooks, and git config unless explicitly revisited;
- reads should at least deny known secret/config paths outside the workspace;
- stricter workspace-only reads are allowed through explicit
  `--sandbox-settings`, but should not be the first default if it breaks common
  toolchains.

Network:

- default is no network;
- `--sandbox-allow-domain` and settings files may add explicit allowlist
  entries;
- broad allowlists such as `github.com` or `*.npmjs.org` are user tradeoffs, not
  safety guarantees;
- no dynamic network approval loop in Phase 9.

Unix sockets and local services:

- default deny where backend supports it;
- Docker socket, SSH agent, 1Password, browser automation, simulator services,
  and similar IPC must require explicit config and should surface warnings.

## 8. Library API vs `srt` CLI

Prefer the library API for runtime execution.

Reasons:

- light-cc-coder must keep ownership of spawn, timeout, abort, process-group
  cleanup, stdout/stderr capture, truncation, and diagnostics;
- the library exposes dependency checks and lifecycle hooks that are easier to
  map to replay-invisible events;
- shelling out through `srt` makes cwd tracking, error classification, and
  cleanup harder to keep identical to `LocalRuntime`.

The `srt` CLI may still be useful for `doctor`, user instructions, or manual
debugging. It should not be the first runtime execution path.

## 9. Diagnostics

Add replay-invisible diagnostics for sandbox state. Proposed event families:

- `sandbox.status`
  - requested mode;
  - active/inactive;
  - backend name/version if available;
  - platform;
  - config hash;
  - fallback reason;
  - weak-mode warnings.
- `sandbox.dependency`
  - `srt` presence;
  - package import status;
  - macOS `sandbox-exec` and `rg`;
  - Linux `bwrap`, `socat`, `rg`, seccomp/apply binary, WSL, user namespace,
    AppArmor caveats;
  - unsupported platform reason.
- `sandbox.execution`
  - tool call id;
  - command subject hash or bounded preview;
  - wrapped true/false;
  - cleanup status;
  - violation summary when available.

Diagnostics are for transcript/debug/user display. They must not enter provider
history except through the paired tool result on actual failure.

## 10. Error Mapping

Map sandbox failures to existing runtime/tool result surfaces:

- `sandbox_unavailable`
  - package missing in `required`;
  - unsupported platform in `required`;
  - missing required OS helper in `required`;
  - invalid explicit settings;
  - backend initialization or wrapping failure before spawn.
- `sandbox_denied`
  - backend confidently reports an OS sandbox denial or violation that prevented
    the requested operation;
  - command must not be retried outside sandbox automatically.
- `runtime_error`
  - unexpected spawn/wrapper failure not clearly caused by sandbox policy.
- `aborted`
  - abort before or during wrapping/execution.

Normal command failures still return an `ExecuteShellResult`:

- exit code non-zero;
- stderr from the process;
- timeout;
- bounded stdout/stderr.

`ToolRuntime` already converts `RuntimeExecutionError` into paired tool results;
Phase 9 should use that path instead of adding a second error channel.

## 11. Doctor And Self-Test

Phase 9 extends the Phase 7 doctor/status direction with sandbox checks.

Required doctor output:

- requested mode and effective mode;
- whether OS sandbox is active for shell execution;
- backend/package version if known;
- platform support;
- dependency checks and warnings;
- config hash and settings path;
- filesystem write/read policy summary;
- network allowlist summary;
- fallback reason if inactive.

Implemented near-term doctor mode:

```text
lightcc doctor --sandbox --json
```

`doctor --sandbox` is diagnostic only: it does not send provider requests, create
a normal transcript, or execute agent bash tools. It reports whether `auto`
will fallback or `required` will fail closed.

The gated real backend E2E runs disposable probes in a temp workspace when
dependencies are available:

- write inside workspace succeeds;
- write outside workspace fails;
- stdout/stderr/exit code remain observable;
- unsupported checks skip with explicit reason rather than silently passing.

Future self-test command, if added, may extend this to empty-network-allowlist
probes and richer process cleanup checks.

## 12. MCP Sandboxing

MCP stdio sandboxing is not part of the first implementation step.

Reason:

- MCP servers often need home config, npm/package cache, network, Unix sockets,
  credential helpers, or long-lived process assumptions;
- sandboxing them too early would hurt usability and blur Phase 9's small
  runtime boundary.

If added later in Phase 9, it must be explicit and per-server or global opt-in,
for example:

```json
{
  "mcpServers": [
    {
      "name": "example",
      "command": "node",
      "args": ["server.js"],
      "osSandbox": "required",
      "sandboxSettings": "./mcp-sandbox.json"
    }
  ]
}
```

Even then, MCP tools still register through the same `ToolRuntime` and still use
the same permission/result/pairing path.

## 13. Tests / Invariants

Required non-E2E tests:

- no sandbox package installed: default `auto` path still falls back to
  `LocalRuntime`;
- `--os-sandbox off` does not load the backend;
- `auto` with unavailable fake module falls back and emits replay-invisible
  diagnostic;
- `required` with unavailable fake module returns exactly one paired
  `sandbox_unavailable` tool result and does not spawn;
- invalid explicit settings fail closed;
- sandbox diagnostics do not appear in `replayProviderMessages`;
- transcript write failure remains fatal;
- permission denial happens before sandbox wrapping;
- shell hard denylist happens before sandbox wrapping;
- timeout/abort behavior remains paired and bounded;
- cwd tracking and output truncation are unchanged through the adapter;
- typecheck passes without the external package.

Opt-in E2E checks on supported platforms:

- shell command runs under real backend;
- workspace write allowed;
- outside-workspace write denied;
- empty network allowlist blocks network (future expansion);
- backend cleanup runs after command;
- Linux dependency warnings and skips are explicit.

## 14. Non-Goals

Phase 9 must not implement:

- a custom sandbox from scratch;
- Windows support;
- Docker or remote runtime;
- persistent shell sessions;
- background jobs or dev-server task registry;
- dynamic network approval prompts;
- persistent trust rules;
- automatic `.srt-settings.json` discovery;
- default MCP sandboxing;
- automatic package-manager cache policy generation;
- claims that sandboxing replaces permissions, approval, review, or workspace
  boundaries.

## 15. Implementation Sequence

Recommended order:

1. Add sandbox config/mode types and fake module tests, with no external
   dependency.
2. Add runtime factory and sandbox runtime adapter using fake module.
3. Add CLI flags and diagnostics.
4. Add dynamic loader for `@anthropic-ai/sandbox-runtime`.
5. Add real-backend doctor/self-test and gated E2E checks.
6. Revisit MCP stdio sandboxing only after bash sandboxing is stable.

Each step must preserve the default no-sandbox harness path.
