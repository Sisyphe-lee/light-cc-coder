# light-cc-coder

[中文](README.zh-CN.md)

`light-cc-coder` is a clean-room, ultra-light Claude Code-style coding agent for
the terminal.

The goal is simple: keep the parts that make a coder useful in a real repository
and leave the product stack out. The TypeScript source under `src/` is about
9k lines today, but it still has the core pieces a coding agent needs: a model
loop, file tools, shell execution, permissions, approvals, context assembly,
session replay, compaction, and an installable CLI.

This is not a toy prompt wrapper. It can read, search, edit, run commands,
ask before risky actions, keep tool results paired with model tool calls, and
write a replayable JSONL transcript for every session. It is also not trying to
be a full Claude Code clone: no full-screen TUI, no account system, no plugin
marketplace, no background job platform. The bet is that a coder can be small,
inspectable, and still useful.

## Install

```bash
npm install -g light-cc-coder
```

This installs three equivalent commands:

```bash
lightcc
light-cc
light-cc-coder
```

Runtime requirements:

- Node.js 20+
- `rg` for fast search
- an OpenAI-compatible chat completions endpoint

Bun is only needed for development and packaging.

## Quick Start

Configure a provider once:

```bash
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"
```

Open the interactive REPL in any repository:

```bash
lightcc
```

Run a one-shot task:

```bash
lightcc -p "Read this repository and summarize the current implementation status."
```

Resume the latest session for the same working directory:

```bash
lightcc resume --last
```

Check configuration without making a model request:

```bash
lightcc doctor
```

## Configuration

Configuration is layered so normal use does not require long commands:

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

Project config lives at `.lightcc/config.json`. It may set project-specific
model/runtime options, but it cannot set `apiKeyEnv`; secrets stay in the user
environment or global config.

Useful flags:

```text
-p <prompt>              run one-shot mode
--cwd <path>             workspace root, defaults to current directory
--model <name>           override configured model
--base-url <url>         override configured provider base URL
--api-key-env <name>     environment variable containing the API key
--permission-mode <mode> read-only | workspace-write | danger-full-access
--max-steps <number>     max model/tool loop steps
--mcp-config <path>      explicit stdio MCP server config
--skill <path>           enable a skill directory containing SKILL.md
```

## What It Can Do

`light-cc-coder` is intentionally small, but the current surface is enough for
real coding loops:

- Interactive and one-shot entry: `lightcc` opens a line-oriented REPL, while
  `lightcc -p "..."` runs a single task for scripts and smoke tests.
- Workspace file tools: `read`, `grep`, `glob`, `edit`, `write`, and
  `apply_patch` operate inside the resolved workspace boundary.
- Shell tool: `bash` runs through the same tool runtime as every other tool,
  with timeout, stdout/stderr capture, truncation, cwd tracking, and approval.
- Permissions: `read-only`, `workspace-write`, and `danger-full-access` keep
  policy decisions explicit. Denials, timeouts, and runtime failures are sent
  back to the model as paired tool results.
- Session replay: every turn writes JSONL events. Replay validates
  assistant/tool-result pairing instead of trusting a lossy chat history.
- Context assembly: provider requests are built by `ContextAssembler`, with
  stable source slots for project instructions, runtime facts, tools, skills,
  todo state, and projected history.
- Compaction: large tool outputs are summarized into bounded model-visible
  previews, older history can be compacted, and transcript replay restores from
  safe checkpoints.
- Git feedback: a read-only `git_feedback` tool can report branch, HEAD, dirty
  files, diff stats, and bounded patch previews without allowing git mutation.
- Extensions: stdio MCP tools, explicit `SKILL.md` loading, local slash
  commands, lifecycle hooks, and a session-scoped `todo` tool.

## Design Philosophy

The project keeps a few boundaries deliberately hard:

- `AgentSession.submit(op)` and `events()` are the public interaction model.
  The CLI and REPL do not reach into loop state.
- `ToolRuntime` is the only execution path for agent tools. Validation,
  permission checks, execution, truncation, and error-to-result normalization
  happen there.
- `ContextAssembler` owns provider request assembly. The CLI never rebuilds
  provider messages by hand.
- Transcript write failure is fatal. A session that cannot record what happened
  should not pretend it can be replayed.
- Slash commands are host/session commands by default and do not silently enter
  model-visible history.

These constraints are why the implementation is small without being casual.
The code avoids product layers that are not necessary yet, but it does not skip
the invariants that make a coding agent debuggable.

## Current Non-Goals

- Full-screen TUI
- Account login, OAuth, setup wizard, or provider account management
- Persistent trust rules
- Background jobs or persistent shell sessions
- Subagents or planner/executor orchestration
- Automatic commit, push, or PR
- OS-level sandbox backend
- Plugin marketplace

## Development

From a source checkout:

```bash
bun install
bun run build
bun run test
bun run typecheck
```

Use `bun run test`, not bare `bun test`; the script excludes local reference
material that should not be scanned.

Local install from this checkout:

```bash
export PATH="$HOME/.bun/bin:$PATH"
npm install -g /path/to/light-cc-coder
```

No-network smoke test for development:

```bash
lightcc --fake -p "hello"
```

Create a publishable tarball:

```bash
npm pack
```

## Clean-Room Note

This project is inspired by Claude Code's working model, but it is a clean-room
implementation. It does not copy Claude Code source, private prompts, recovered
implementation details, or product file layout.

For detailed implementation status and phase notes, see
[docs/status.md](docs/status.md) and [docs/plan.md](docs/plan.md).

## License

No license has been selected yet.
