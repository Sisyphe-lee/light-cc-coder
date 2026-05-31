# light-cc-coder

A clean-room, lightweight TypeScript coder harness inspired by the core working model of Claude Code.

`light-cc-coder` is not a teaching toy and not a full Claude Code clone. The goal is a small, fast, inspectable coding agent runtime that can operate in real repositories with reliable tool/result pairing, replayable transcripts, bounded workspace file access, and a stable agent loop.

Current status: **pre-alpha, Phase 2 complete**. It can run one-shot CLI turns against an OpenAI-compatible streaming model, use workspace-scoped file tools, and write JSONL transcripts. Shell execution, permission prompts, sandbox policy, REPL, MCP, skills, memory, and compaction are planned but not implemented yet.

## Why This Exists

Most coding-agent prototypes either start from a generic chat loop or immediately grow into a large product surface. This project keeps the first version deliberately narrow:

- `AgentSession` is the public core: submit operations in, consume events out.
- `runTurn` / `executeStep` own the model-tool loop.
- `SessionEngine` owns message projection, context assembly, transcript writing, and replay invariants.
- `ToolRuntime` owns schema validation, scheduling, result normalization, truncation, and error-to-result behavior.
- Filesystem access is restricted to the configured workspace root by default.
- JSONL event transcripts are the persistence and debugging baseline.

The repository is developed clean-room. Local Claude Code reading notes and external reference repositories inform behavior-level architecture, but implementation code is written here from scratch.

## What Works Today

- TypeScript/Bun project scaffold.
- One-shot CLI entrypoint with `-p`.
- OpenAI-compatible streaming provider adapter.
- Fake provider mode for local smoke tests without network calls.
- Built-in workspace tools:
  - `read`
  - `grep`
  - `glob`
  - `edit`
  - `write`
  - `apply_patch`
- `RealToolRuntime` with tool lookup, input validation, exceptions as tool results, output truncation, read-only batch concurrency, and writer serialization.
- Workspace path boundary checks, including symlink escape denial and sensitive path hard denies.
- Stable context assembly with runtime facts, project metadata from `AGENTS.md`, tool schema hash, and history projection diagnostics.
- JSONL transcript writing and replay projection checks for missing, duplicate, orphan, reordered, and cross-turn tool results.

## Not Implemented Yet

- Interactive REPL.
- Bash/shell tool and runtime-backed command execution.
- Permission modes, approval prompts, and sandbox policy.
- Verification workflow.
- MCP, skills, commands, memory, hooks, and compaction.
- Automatic commit, push, PR, or benchmark orchestration.

See [docs/status.md](docs/status.md) for the current handoff and [docs/plan.md](docs/plan.md) for the architecture plan.

## Requirements

- [Bun](https://bun.sh/) 1.x
- Node-compatible TypeScript tooling installed through Bun
- `rg` / ripgrep for the `grep` tool
- An OpenAI-compatible chat completions endpoint for real model runs

## Install

```bash
bun install
```

## Quick Start

Run a no-network smoke test:

```bash
bun src/cli/main.ts \
  -p "hello" \
  --fake \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-fake.jsonl
```

Run against an OpenAI-compatible model:

```bash
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"

bun src/cli/main.ts \
  -p "Inspect README.md and summarize the project state." \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-session.jsonl \
  --max-steps 5
```

You can also keep provider secrets in a custom environment variable:

```bash
export LIGHT_CC_GLM_BASE_URL="https://api.example.com/v1"
export LIGHT_CC_GLM_MODEL="your-model-name"
export ZAI_API_KEY="your-api-key"

bun src/cli/main.ts \
  -p "Read package.json and tell me the available scripts." \
  --cwd "$PWD" \
  --base-url "$LIGHT_CC_GLM_BASE_URL" \
  --model "$LIGHT_CC_GLM_MODEL" \
  --api-key-env ZAI_API_KEY \
  --transcript /tmp/light-cc-glm.jsonl \
  --max-steps 5
```

CLI options currently supported:

```text
-p <prompt>              Prompt for a one-shot turn
--cwd <path>             Workspace root, defaults to current directory
--model <name>           Model name, defaults to OPENAI_MODEL
--base-url <url>         Provider base URL, defaults to OPENAI_BASE_URL
--api-key-env <name>     Environment variable containing the API key, defaults to OPENAI_API_KEY
--transcript <path>      Write JSONL session events to this path
--max-steps <number>     Maximum model/tool loop steps
--fake                   Use the fake provider instead of a real model
```

## Debugging Sessions

The most useful debugging artifact is the JSONL transcript:

```bash
tail -n 20 /tmp/light-cc-session.jsonl
```

Each line is a session event such as `turn.started`, `context.step`, `assistant.message`, `tool.call`, or `tool.result`. The transcript is intentionally lower-level than final chat messages so a failed run can be replayed and inspected for context assembly, provider request shape, tool pairing, and tool failures.

During CLI runs:

- assistant text streams to stdout;
- tool calls and tool results are printed to stderr;
- transcript write failure is fatal, because replayability is a core invariant.

## Development

Run the repository test suite:

```bash
bun run test
```

Run TypeScript checking:

```bash
bun run typecheck
```

Do not run bare `bun test` in this repository. The configured `bun run test` command excludes local external reference clones under `references/repos/`.

## Repository Layout

```text
src/cli/          Minimal one-shot CLI
src/core/         AgentSession, events, messages, ops, errors
src/engine/       SessionEngine, context assembly, message projection, transcript replay
src/loop/         runTurn and executeStep
src/providers/    Fake and OpenAI-compatible providers
src/runtime/      Early runtime/deployment interfaces
src/tools/        Tool runtime, registry, schemas, built-in file tools
src/workspace/    Workspace filesystem and path boundary safety
test/             Unit and integration tests
docs/             Architecture plan and current status
Spec/             Phase-specific implementation specs
```

## Clean-Room Boundary

The primary local reference tree is `/data1/lcy/projects/ClaudeCode`, especially its architecture notes. This repository does not copy restored Claude Code source, private prompts, file structure, or implementation details. External repositories under `references/repos/` are local read-only references and are intentionally ignored by git.

If a design is adopted from any reference, the decision should be recorded in [docs/plan.md](docs/plan.md) in this project's own words.

## Roadmap

Phase 3 is next:

- shell/runtime/deployment implementation;
- permission modes and approval flow;
- sandbox-denied and timeout results as model-visible tool results;
- verification workflow around command execution.

Later phases cover REPL usability, MCP/skills, memory, compaction, and broader hardening.

## License

No license has been selected yet.
