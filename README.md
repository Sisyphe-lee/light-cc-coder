# light-cc-coder

[中文](README.zh-CN.md)

`light-cc-coder` is a lightweight Claude Code-style coder harness for real
repositories. Its core `src/` tree is about 10k lines of TypeScript: small
enough to audit, but complete enough to run a disciplined terminal repo loop
with permissions, file and shell tools, stable context, replayable JSONL
transcripts, compaction, resume, and a practical CLI.

## Benchmark Snapshot

These are local evaluation snapshots on fixed small subsets, not full public
leaderboards. All runs below used `deepseek-v4-flash`.

SWE-bench Verified fixed 50-task subset:

`/ Task` is averaged over all 50 tasks; `/ Solved Task` is averaged over
officially resolved tasks only, using only the cost or run time from those
resolved tasks.
Bold underlined values mark the best column result.

| Coder | Resolved | Avg Requests / Task | Avg Cost (USD cents) / Task | Avg Cost (USD cents) / Solved Task | Avg Tokens / Task | Cache Hit Rate | Avg Run Time / Task | Avg Run Time / Solved Task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LightCC | 32/50 | <strong><u>23.5</u></strong> | <strong><u>1.087</u></strong> | <strong><u>0.752</u></strong> | <strong><u>500,358</u></strong> | 93.9% | 4.5 min | 3.2 min |
| OpenHands | 31/50 | 44.2 | 1.771 | 1.450 | 1,262,942 | 95.1% | 4.6 min | 3.8 min |
| OpenCode | <strong><u>33/50</u></strong> | 28.6 | 1.136 | 1.065 | 829,122 | 95.9% | 3.4 min | 2.7 min |
| Kimi CLI | <strong><u>33/50</u></strong> | 31.2 | 1.329 | 1.126 | 1,237,517 | <strong><u>96.7%</u></strong> | <strong><u>2.8 min</u></strong> | <strong><u>2.3 min</u></strong> |

Terminal-Bench 2.1 fixed 20-task subset:

| Coder | Set | Passed | Rate |
| --- | --- | ---: | ---: |
| LightCC | Fixed 20-task subset | 11/20 | 55% |

## Install

Recommended installer:

```sh
curl -fsSL https://raw.githubusercontent.com/Sisyphe-lee/light-cc-coder/main/install.sh | bash
```

The installer checks Node/npm, installs `@anthropic-ai/sandbox-runtime` first,
installs the lightcc npm package, and runs `lightcc doctor --sandbox` so
sandbox dependency problems are visible immediately. It does not use `sudo`,
`apt`, or `brew`.

Direct npm install:

```sh
npm install -g light-cc-coder
```

The direct npm package includes the sandbox runtime library dependency. If you
also want the standalone `srt` command for host checks, install it separately:

```sh
npm install -g @anthropic-ai/sandbox-runtime
srt -c 'echo sandbox-ok'
```

This installs three equivalent commands:

```sh
lightcc
light-cc
light-cc-coder
```

## Quick Start

Configure an OpenAI-compatible provider:

```sh
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"
```

Open a repository and start the REPL:

```sh
cd your-project
lightcc
```

Run one task and exit:

```sh
lightcc -p "Run the tests, fix the failure, and explain the change."
```

Stream machine-readable events for automation:

```sh
lightcc -p "Summarize this repository." --json
```

Check local configuration without contacting the model:

```sh
lightcc doctor
```

## Requirements

- Node.js 20 or newer
- `rg` for fast file search
- An OpenAI-compatible chat completions endpoint

Bun is only required for source development and packaging.

## What It Does

- **Interactive and one-shot CLI**: use `lightcc` for a line-oriented REPL, or
  `lightcc -p "..."` for scripts and smoke tests.
- **Repository tools**: read files, search with `grep`/`glob`, edit, write, and
  apply patches inside the resolved workspace boundary. Exact edit failures
  report missing or duplicate match context so the model can retry precisely.
- **Shell execution**: run `bash` with timeout, stdout/stderr capture,
  truncation, cwd tracking, approval metadata, and process cleanup.
- **Permission modes**: choose `read-only`, `workspace-write`, or
  `danger-full-access`. Denials, timeouts, sandbox failures, and tool errors are
  returned to the model as normal tool results. Runtime context also tells the
  model which permission and OS sandbox limits are active.
- **JSON event stream**: `lightcc -p "..." --json` emits live JSONL events for
  assistant messages, tool calls/results, approvals, errors, turn completion,
  and final status.
- **Replayable sessions**: every session writes a JSONL event transcript. Replay
  validates assistant tool calls and tool results instead of trusting a lossy
  chat history.
- **Context management**: project instructions, runtime facts, tool schemas,
  skills, todo state, and projected history are assembled through stable context
  slots. Large tool outputs are bounded and can be compacted.
- **Git awareness without mutation**: `git_feedback` reports branch, HEAD,
  dirty files, diff stats, and bounded patch previews without committing or
  changing git state.
- **Thin extensions**: stdio MCP tools, explicit `SKILL.md` loading, local slash
  commands, lifecycle hooks, and a session-scoped todo tool all go through the
  same tool runtime.
- **Optional OS sandbox**: `bash` can be wrapped by
  `@anthropic-ai/sandbox-runtime` in `auto` or `required` mode when host
  dependencies are available.

## Common Commands

```sh
# Start an interactive session in the current directory
lightcc

# One-shot prompt
lightcc -p "Summarize this repository."

# JSONL event stream for automation
lightcc -p "Summarize this repository." --json

# Work in a specific directory
lightcc --cwd /path/to/repo

# Resume the latest session for the same cwd
lightcc resume --last

# List session ids for this workspace
lightcc sessions

# Resume a specific session
lightcc resume <session-id>

# Use full local access in a trusted repository
lightcc --permission-mode danger-full-access

# Check sandbox support
lightcc doctor --sandbox

# Run without a model call, useful for config checks
lightcc --dry-run -p "hello"
```

## Profiling

Profiling is local, opt-in performance/cost observability for the harness
itself. It is not a task-quality benchmark, judge, leaderboard, telemetry
system, or model router.

Record an interactive profiled REPL session:

```sh
lightcc \
  --profile \
  --transcript /tmp/lightcc-repl-profile.jsonl \
  --cwd "$PWD"
```

When you exit the REPL with `/exit`, `/quit`, or Ctrl-D, the transcript contains
all turns from that interactive session plus the profiling spans.

Record one profiled one-shot session:

```sh
lightcc -p "Search this repository for TODOs and summarize the files." \
  --profile \
  --transcript /tmp/lightcc-profile.jsonl \
  --cwd "$PWD"
```

Summarize the transcript offline:

```sh
# Human-readable summary
lightcc profile /tmp/lightcc-profile.jsonl

# Stable JSON report
lightcc profile /tmp/lightcc-profile.jsonl \
  --json \
  --out /tmp/lightcc-profile.report.json
```

The transcript remains the canonical event log. Profiling adds replay-invisible
`profile.span` events; they do not enter model-visible history and do not affect
tool/result pairing or replay.

The single-run profile report measures:

- startup and extension initialization;
- context assembly time and estimated context size;
- provider calls, time to first token, stream duration, retries, token counts,
  and cache-read/cache-write counters when the provider returns them;
- tool batch and per-tool execution time, including errors, denials, and
  timeouts;
- approval wait time;
- runtime/bash duration, nonzero exits, timeouts, and truncation;
- MCP startup and MCP tool-call counts when MCP is configured;
- compaction count, duration, and pre/post token estimates;
- transcript write count, bytes, duration, and profiler self-overhead.

The output is a local artifact stack:

```text
transcript.jsonl        session events + replay-invisible profile spans
profile.report.json     stable single-run JSON profile report
```

From a source checkout, there are two developer-only helpers:

```sh
# Deterministic FakeProvider regression guard (implemented in tests/profiling)
bun test test/profiling/

# Optional live N-run profiling. Real provider/network, not a CI gate.
bun profiling/liveRuns/runner.ts --scenario pong --runs 7 --warmup 1 \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs \
  --model "$OPENAI_MODEL" \
  --base-url "$OPENAI_BASE_URL" \
  --api-key-env OPENAI_API_KEY

# Same runner without a real provider call, useful for smoke checks.
bun profiling/liveRuns/runner.ts --scenario pong --fake --runs 2 --warmup 1 \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs-fake \
  --os-sandbox off
```

The live runner writes one transcript and one `profile.report.json` per run,
then writes `live-runs.summary.json` with medians, min/max/IQR, bottleneck
frequency, provider token/cache summaries, tool/runtime/context/transcript-write
aggregates, and failed/skipped run accounting. Warmup runs are kept on disk but
excluded from aggregate statistics.

## Configuration

Configuration is layered:

```text
defaults < ~/.lightcc/config.json < .lightcc/config.json < environment < CLI flags
```

Example global config:

```json
{
  "baseUrl": "https://api.example.com/v1",
  "model": "your-model-name",
  "apiKeyEnv": "OPENAI_API_KEY",
  "permissionMode": "workspace-write"
}
```

Project config lives at `.lightcc/config.json`. It can set project-specific
runtime options, but secrets should stay in the user environment or global
config.

Useful flags:

```text
-p <prompt>              run one-shot mode
--cwd <path>             workspace root, defaults to current directory
--model <name>           override configured model
--base-url <url>         override configured provider base URL
--api-key-env <name>     environment variable containing the API key
--json                   emit JSON output for one-shot/doctor commands
--permission-mode <mode> read-only | workspace-write | danger-full-access
--os-sandbox <mode>      off | auto | required
--sandbox-settings <path> explicit sandbox settings path
--max-steps <number>     max model/tool loop steps
--mcp-config <path>      explicit stdio MCP server config
--skill <path>           enable a skill directory containing SKILL.md
```

## Design Notes

The implementation keeps a few boundaries hard:

- `AgentSession.submit(op)` and `events()` are the public session interface.
- `ToolRuntime` is the only path for validation, permission checks, execution,
  result normalization, truncation, and error-to-result conversion.
- `ContextAssembler` owns provider request assembly.
- Transcript write failure is fatal.
- Host slash commands do not silently enter model-visible history.

These constraints keep the code small while preserving the invariants a real
coding agent needs.

## Current Non-Goals

- Full-screen TUI
- Account login, OAuth, or provider account management
- Persistent trust rules
- Background jobs or persistent shell sessions
- Subagents or planner/executor orchestration
- Automatic commit, push, or PR creation
- Plugin marketplace

## Development

From a source checkout:

```sh
bun install
bun run build
bun run test
bun run typecheck
```

Use the scripted test command. It excludes local reference material and sandbox
submodules that should not be scanned by the test runner.

Local no-network smoke test:

```sh
lightcc --fake -p "hello"
```

## Clean-Room Scope

`light-cc-coder` is inspired by Claude Code's working model, but it is a
clean-room implementation. It does not copy Claude Code source, private prompts,
recovered implementation details, or product file layout.

## License

Released under the [MIT License](LICENSE).
