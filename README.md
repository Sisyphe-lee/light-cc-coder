# light-cc-coder

[中文](README.zh-CN.md)

`light-cc-coder` is a small TypeScript coding-agent harness inspired by the working style of Claude Code.

It is meant to be a real, inspectable runtime rather than a demo script: it can run a model loop, expose file and shell tools, keep tool results paired with model tool calls, and write replayable JSONL transcripts.

The project is still early. The current CLI is a one-shot runner; REPL, MCP, skills, memory, and compaction are not part of the stable surface yet.

## Features

- OpenAI-compatible streaming provider adapter
- Workspace-scoped tools: `read`, `grep`, `glob`, `edit`, `write`, `apply_patch`
- Runtime-backed `bash` tool with timeout and captured stdout/stderr
- Permission modes: `read-only`, `workspace-write`, `danger-full-access`
- JSONL event transcript for debugging and replay
- Bun + TypeScript test suite

## Install

```bash
bun install
```

Requirements: Bun 1.x, `rg` for search, and an OpenAI-compatible chat completions endpoint for real model runs.

## Quick Start

No-network smoke test:

```bash
bun src/cli/main.ts \
  -p "hello" \
  --fake \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-fake.jsonl
```

Run with a real model:

```bash
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"

bun src/cli/main.ts \
  -p "Read README.md and summarize this project." \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-session.jsonl \
  --max-steps 5
```

To let the model run shell commands in the one-shot CLI, use `danger-full-access`:

```bash
bun src/cli/main.ts \
  -p "Run bun run typecheck and report the result." \
  --cwd "$PWD" \
  --permission-mode danger-full-access \
  --transcript /tmp/light-cc-check.jsonl
```

`workspace-write` is the default. In that mode, ordinary `bash` calls request approval; the current one-shot CLI auto-denies approval requests because it is not an interactive UI.

## Useful Flags

```text
-p <prompt>              one-shot prompt
--cwd <path>             workspace root
--model <name>           defaults to OPENAI_MODEL
--base-url <url>         defaults to OPENAI_BASE_URL
--api-key-env <name>     defaults to OPENAI_API_KEY
--transcript <path>      write JSONL events
--max-steps <number>     max model/tool loop steps
--permission-mode <mode> read-only | workspace-write | danger-full-access
--fake                   use the fake provider
```

## Debugging

The transcript is the main debugging artifact:

```bash
tail -n 20 /tmp/light-cc-session.jsonl
```

It records events such as context assembly, assistant messages, tool calls, permission decisions, shell observations, and tool results.

## Development

```bash
bun run test
bun run typecheck
```

Use `bun run test`, not bare `bun test`; the script excludes local reference material that should not be scanned.

## Design Notes

The core boundary is `AgentSession.submit(op)` plus an event stream. The loop, context assembly, transcript projection, tool runtime, permissions, and runtime execution are separate modules so failures can be traced instead of hidden inside a chat wrapper.

This is a clean-room implementation. It does not copy Claude Code source, private prompts, or recovered implementation details.

For implementation status and deeper architecture notes, see [docs/status.md](docs/status.md) and [docs/plan.md](docs/plan.md).

## License

No license has been selected yet.
