# light-cc-coder

[English](README.md)

`light-cc-coder` 是一个轻量的 TypeScript coding agent harness，核心目标是实现一种接近 Claude Code 工作方式的、可检查、可复现、可以真实跑在代码仓库里的 agent runtime。

它不是完整 Claude Code 复刻，也不是教学 demo。当前重点是把基础链路做扎实：模型循环、文件工具、shell 工具、权限边界、tool/result 配对，以及可 replay 的 JSONL transcript。

项目还处在早期。现在主要入口是一次性 CLI；REPL、长期 memory 等还不是稳定能力。核心 loop、文件/shell 工具、approval、transcript replay、compact-first context management、MCP/skills/commands 的最小扩展面，以及 Phase 6 dogfood hardening 已经实现并有测试覆盖。

## 能做什么

- 调 OpenAI-compatible streaming 模型
- 在 workspace 内读、搜、改文件：`read`、`grep`、`glob`、`edit`、`write`、`apply_patch`
- 通过 `bash` 工具运行命令，带 timeout 和 stdout/stderr 捕获
- 只读 `git_feedback` 工具：返回 branch/HEAD、dirty files、diff stat、bounded diff preview，不做 git mutation
- 支持 `read-only`、`workspace-write`、`danger-full-access` 三种权限模式
- 一次性 CLI 下提供交互式 approval prompt，展示 cwd、policy reason、input/access summary 和 display-only risk summary
- compact-first context management：large tool-result artifact、历史 tool result snip、manual compact checkpoint、auto compact、context overflow 一次 retry
- 最小扩展面：stdio MCP tools、显式 `SKILL.md` 加载、内置本地 slash commands、typed lifecycle hooks、session-scoped `todo` tool
- 对 provider transient pre-delta failure 做 retry/failure classification，并写 replay-invisible diagnostic
- 对明显验证类 bash 调用写 `verification.observed` replay-invisible metadata；普通 bash tool result 仍正常回灌模型
- 写 JSONL transcript，方便调试和 replay
- 用 Bun + TypeScript 写核心模块和测试

## Dogfood Hardening

Phase 6 只补最小闭环，不扩成产品 shell：

- `git_feedback` 是标准 builtin tool，必须走 `ToolRuntime`。它在 `read-only` 下可用，`workspace-write` 下不需要 approval，只执行固定的内部 git inspection，不接受模型拼出的 shell，也不会 commit、push、reset、checkout、stash、rebase、merge 或 clean。diff preview 有文件数和字节数上限；敏感路径只报告文件变更，不展示 patch 内容。
- Approval request 现在带展示元数据：cwd、permission mode、tool description、subject、policy reason、可选工具 reason（例如 `bash.description`）、bounded input summary、access summary 和 risk summary。这些字段只用于 CLI 展示，不改变 `PermissionPolicy` 的真实 allow/ask/deny 决策。
- Provider failure 会先分类再决定是否 retry。429、408、5xx、network failure、pre-delta stream drop 可以在 assistant message 尚未 commit 且没有 assistant delta 时 retry；abort、401/403、普通 4xx、context overflow、partial delta failure 不走普通 retry。Context overflow 继续使用既有 compact/retry 路径。
- `todo replace` 最多允许一个 `in_progress`。违反时只返回一个配对的 error tool result，不更新 `TodoState`，也不 emit `todo.updated`。
- `bash.description` 会写入 `bash.observation`。明显验证类命令会额外 emit `verification.observed` diagnostic，只记录 command、cwd、description、exitCode、timedOut、duration、status 和输出 metadata，不复制大 stdout/stderr；失败输出仍通过正常的 `bash` tool result 回灌模型。

`/diff`、`turn.changed_files`、transcript health scanner、REPL/TUI、persistent shell、sandbox backend、subagents 和自动 git mutation 都不在这个 phase 的范围内。

## 安装

```bash
bun install
```

需要 Bun 1.x、`rg`，以及一个 OpenAI-compatible chat completions API。

## 快速试用

不调用模型的 smoke test：

```bash
bun src/cli/main.ts \
  -p "hello" \
  --fake \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-fake.jsonl
```

调用真实模型：

```bash
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"

bun src/cli/main.ts \
  -p "读 README.md，总结这个项目。" \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-session.jsonl \
  --max-steps 5
```

如果要让一次性 CLI 执行 shell 命令，保留默认 `workspace-write` 并在终端里确认 approval：

```bash
bun src/cli/main.ts \
  -p "运行 bun run typecheck，并汇报结果。" \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-check.jsonl
```

当模型请求 approval 时，CLI 会打印 tool name、cwd、permission mode、subject、policy reason、可选 tool reason、input summary、access summary 和 display-only risk summary，然后询问 `Allow this tool call? [y/N]`。输入 `y` 或 `yes` 才会执行。`danger-full-access` 可用于可信本地 demo 跳过 prompt，但 shell hard denylist 仍然生效。

最小扩展面示例：

```bash
bun src/cli/main.ts \
  -p "/tools" \
  --fake \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-tools.jsonl

bun src/cli/main.ts \
  -p "使用已启用的 skill context，总结当前任务。" \
  --skill /path/to/skill-dir \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-skill.jsonl

bun src/cli/main.ts \
  -p "如果可用 MCP tools 有帮助，就使用它们。" \
  --mcp-config /path/to/mcp-config.json \
  --cwd "$PWD" \
  --transcript /tmp/light-cc-mcp.jsonl
```

MCP 只支持 stdio，并且必须显式配置。Skills 只在显式启用时读取 `SKILL.md`；不会自动发现 skill、执行 assets/scripts，也不会加载 custom markdown commands。

## 常用参数

```text
-p <prompt>              一次性 prompt
--cwd <path>             workspace root
--model <name>           默认读 OPENAI_MODEL
--base-url <url>         默认读 OPENAI_BASE_URL
--api-key-env <name>     默认读 OPENAI_API_KEY
--transcript <path>      写 JSONL 事件
--max-steps <number>     最大 model/tool loop 步数
--max-context-tokens <n> 粗略 context budget，超过后会 compact
--compact-threshold <n>  preflight hard compact threshold
--permission-mode <mode> read-only | workspace-write | danger-full-access
--mcp-config <path>      显式 stdio MCP server 配置
--skill <path>           显式启用包含 SKILL.md 的 skill 目录
--fake                   使用 fake provider
```

## 调试

最重要的调试产物是 transcript：

```bash
tail -n 20 /tmp/light-cc-session.jsonl
```

里面会记录 context assembly、assistant message、tool call、permission decision、bash observation、verification observation、provider retry/failure diagnostic、compact checkpoint、tool result 等事件。失败时先看 transcript，通常比看最终输出更有用。

大工具输出会作为 session artifact 写到 workspace 外。模型只会在配对的 `tool.result` 里看到 bounded preview；完整 artifact path 会记录在 diagnostic `tool.artifact` event 中。

API 层支持手动 compact：

```ts
await session.submit({ type: "compact.request" })
```

Replay 会从最新 successful compact checkpoint 加合法 suffix 恢复，同时继续校验 assistant/tool-result pairing。

## 开发

```bash
bun run test
bun run typecheck
```

不要直接跑裸 `bun test`；仓库脚本会排除本地 reference material。

## 设计边界

核心接口是 `AgentSession.submit(op)` 加事件流。agent loop、context assembly、transcript projection、tool runtime、permission、runtime execution 都拆开实现，目的是让每一步都可观察、可失败、可 replay。

这是 clean-room 实现，不复制 Claude Code 源码、私有 prompt 或恢复版实现细节。

更细的实现状态和架构说明见 [docs/status.md](docs/status.md) 和 [docs/plan.md](docs/plan.md)。

## License

尚未选择 license。
