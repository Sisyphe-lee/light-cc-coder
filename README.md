# light-cc-coder

[中文](README.zh-CN.md)

`light-cc-coder` is a compact TypeScript harness for running a coding agent in
your terminal. It aims at the part Claude Code gets especially right: a
disciplined repo loop with stable context, permissioned file and shell tools,
exact tool-result pairing, replayable transcripts, compaction, and resume.

The project is intentionally compact: the current `src/` tree is about 10k
lines of TypeScript. It is small enough to inspect, but still has the pieces
that make a terminal coder useful in a real repository: an agent loop, tool
runtime, permissions, context assembly, transcripts, replay, and a usable CLI.

## Install

Recommended installer:

```sh
curl -fsSL https://raw.githubusercontent.com/Sisyphe-lee/light-cc-coder/main/install.sh | bash
```

The installer checks Node/npm, installs the npm package, and runs
`lightcc doctor --sandbox` so sandbox dependency problems are visible
immediately. It does not use `sudo`, `apt`, or `brew`.

Direct npm install:

```sh
npm install -g light-cc-coder
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
  apply patches inside the resolved workspace boundary.
- **Shell execution**: run `bash` with timeout, stdout/stderr capture,
  truncation, cwd tracking, approval metadata, and process cleanup.
- **Permission modes**: choose `read-only`, `workspace-write`, or
  `danger-full-access`. Denials, timeouts, sandbox failures, and tool errors are
  returned to the model as normal tool results.
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
