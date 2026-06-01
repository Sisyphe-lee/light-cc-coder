# light-cc-coder

[English](README.md)

`light-cc-coder` 是一个 clean-room 实现的、极轻量的 Claude Code 风格终端
coding agent。

它的目标很明确：保留真实 coder 在代码仓库里必须有的核心能力，去掉庞大的产品
外壳。当前 `src/` 下 TypeScript 源码大约 9k 行，但已经包含一个 coding agent
真正需要的关键部件：模型循环、文件工具、shell 执行、权限、approval、context
assembly、session replay、compaction，以及可安装的 CLI。

这不是一个 toy prompt wrapper。它可以读文件、搜索、编辑、运行命令、在高风险
动作前请求确认、保证 tool result 和 model tool call 配对，并为每个 session 写
可 replay 的 JSONL transcript。它也不是完整 Claude Code 复刻：没有全屏 TUI、
账号系统、插件市场或后台任务平台。这里的取舍是：coder 可以很小、可读、可审计，
同时仍然真实可用。

## 安装

```bash
npm install -g light-cc-coder
```

安装后有三个等价命令：

```bash
lightcc
light-cc
light-cc-coder
```

运行时要求：

- Node.js 20+
- `rg`，用于快速搜索
- 一个 OpenAI-compatible chat completions endpoint

Bun 只用于开发、测试和打包。

## 快速开始

先配置一次 provider：

```bash
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"
```

在任意代码仓库里进入交互：

```bash
lightcc
```

执行一次性任务：

```bash
lightcc -p "读一下这个仓库，总结当前实现状态。"
```

恢复同一工作目录下最新 session：

```bash
lightcc resume --last
```

只检查配置，不发模型请求：

```bash
lightcc doctor
```

## 配置

配置按层覆盖，这样日常使用不需要每次写一长串参数：

```text
defaults < ~/.lightcc/config.json < .lightcc/config.json < environment < CLI flags
```

全局配置示例：

```json
{
  "baseUrl": "https://api.example.com/v1",
  "model": "your-model-name",
  "apiKeyEnv": "OPENAI_API_KEY",
  "permissionMode": "workspace-write"
}
```

项目配置放在 `.lightcc/config.json`。它可以设置项目相关的 model/runtime 选项，
但不能设置 `apiKeyEnv`；secret 留在用户环境变量或全局配置里。

常用参数：

```text
-p <prompt>              执行一次性任务
--cwd <path>             workspace root，默认当前目录
--model <name>           覆盖配置里的 model
--base-url <url>         覆盖配置里的 provider base URL
--api-key-env <name>     指定保存 API key 的环境变量
--permission-mode <mode> read-only | workspace-write | danger-full-access
--max-steps <number>     最大 model/tool loop 步数
--mcp-config <path>      显式 stdio MCP server 配置
--skill <path>           启用包含 SKILL.md 的 skill 目录
```

## 功能和取舍

`light-cc-coder` 故意保持小，但当前能力已经覆盖真实 coding loop：

- 交互和一次性入口：`lightcc` 默认进入 line-oriented REPL，`lightcc -p "..."`
  用于脚本和单次任务。
- Workspace 文件工具：`read`、`grep`、`glob`、`edit`、`write`、`apply_patch`
  都受 resolved workspace boundary 约束。
- Shell 工具：`bash` 和其他工具一样走统一 `ToolRuntime`，带 timeout、
  stdout/stderr 捕获、截断、cwd tracking 和 approval。
- 权限模式：`read-only`、`workspace-write`、`danger-full-access`。denied、
  timeout、runtime failure 都会作为配对 tool result 回灌模型。
- Session replay：每轮写 JSONL events。replay 会校验 assistant/tool-result
  pairing，而不是相信丢信息的 chat history。
- Context assembly：provider request 由 `ContextAssembler` 构造，project
  instructions、runtime facts、tools、skills、todo state 和历史投影都有稳定 slot。
- Compaction：大工具输出只给模型 bounded preview，旧历史可以 compact，transcript
  replay 从安全 checkpoint 恢复。
- Git feedback：只读 `git_feedback` 工具返回 branch、HEAD、dirty files、diff
  stat 和 bounded patch preview，不允许 git mutation。
- 扩展面：stdio MCP tools、显式 `SKILL.md` 加载、本地 slash commands、lifecycle
  hooks，以及 session-scoped `todo` tool。

## 设计哲学

这个项目刻意把几条边界做硬：

- `AgentSession.submit(op)` 和 `events()` 是公开交互模型。CLI/REPL 不直接改 loop
  状态。
- `ToolRuntime` 是 agent tools 的唯一执行路径。validation、permission、
  execution、truncation、error-to-result normalization 都在这里发生。
- `ContextAssembler` 负责 provider request assembly。CLI 不手拼 provider
  messages。
- transcript write failure 是 fatal。一个不能记录发生了什么的 session，不应该假装
  以后还能 replay。
- slash commands 默认是 host/session commands，不会悄悄进入 model-visible
  history。

这些约束让实现可以小，但不是随意。我们不做当前不必要的产品层，但不跳过让 coder
可调试、可 replay、可恢复的核心不变量。

## 当前不做什么

- 全屏 TUI
- 账号登录、OAuth、setup wizard 或 provider account 管理
- 持久 trust rules
- background jobs 或 persistent shell sessions
- subagents 或 planner/executor 编排
- 自动 commit、push、PR
- OS-level sandbox backend
- 插件市场

## 开发

从源码开发：

```bash
bun install
bun run build
bun run test
bun run typecheck
```

不要直接跑裸 `bun test`；仓库脚本会排除本地 reference material。

从当前 checkout 本地安装：

```bash
export PATH="$HOME/.bun/bin:$PATH"
npm install -g /path/to/light-cc-coder
```

开发用 no-network smoke test：

```bash
lightcc --fake -p "hello"
```

生成可发布 tarball：

```bash
npm pack
```

## Clean-Room 说明

本项目受 Claude Code 的工作模型启发，但实现是 clean-room 的。不复制 Claude Code
源码、私有 prompt、恢复版实现细节或产品文件布局。

更详细的实现状态和 phase 记录见 [docs/status.md](docs/status.md) 和
[docs/plan.md](docs/plan.md)。

## License

尚未选择 license。
