# light-cc-coder

[English](README.md)

`light-cc-coder` 是一个运行在终端里的轻量 TypeScript coder harness。它想保留
Claude Code 更值得借鉴的部分：不是简单让 LLM 调工具，而是一个有稳定 context、
权限化文件和 shell 工具、严格 tool/result 配对、可 replay transcript、compaction
和 resume 的代码仓库工作循环。

这个项目刻意保持小。当前 `src/` 目录大约 10k 行 TypeScript。它不是完整产品壳，
也不是简单 prompt wrapper；代码量仍然可读，但已经包含真实终端 coder 需要的部件：
agent loop、tool runtime、权限、context assembly、transcript、replay，以及一个能
实际使用的 CLI。

## 安装

推荐安装脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/Sisyphe-lee/light-cc-coder/main/install.sh | bash
```

这个脚本会检查 Node/npm、安装 npm 包，并运行 `lightcc doctor --sandbox`，所以 sandbox
依赖问题会在安装后立刻暴露出来。它不会调用 `sudo`、`apt` 或 `brew`。

直接用 npm 安装：

```sh
npm install -g light-cc-coder
```

安装后有三个等价命令：

```sh
lightcc
light-cc
light-cc-coder
```

## 快速开始

配置一个 OpenAI-compatible provider：

```sh
export OPENAI_BASE_URL="https://api.example.com/v1"
export OPENAI_MODEL="your-model-name"
export OPENAI_API_KEY="your-api-key"
```

进入一个代码仓库并启动 REPL：

```sh
cd your-project
lightcc
```

执行一次性任务：

```sh
lightcc -p "运行测试，修复失败，并解释改动。"
```

为自动化输出 machine-readable event stream：

```sh
lightcc -p "总结这个仓库。" --json
```

只检查本地配置，不请求模型：

```sh
lightcc doctor
```

## 运行要求

- Node.js 20 或更新版本
- `rg`，用于快速文件搜索
- 一个 OpenAI-compatible chat completions endpoint

Bun 只在源码开发和打包时需要。

## 它能做什么

- **交互和一次性 CLI**：`lightcc` 进入 line-oriented REPL，`lightcc -p "..."`
  适合脚本和 smoke test。
- **仓库工具**：在解析后的 workspace 边界内读文件、搜索、glob、编辑、写文件和应用
  patch。exact edit 失败时会返回 missing/duplicate match 的上下文，方便模型精确重试。
- **Shell 执行**：`bash` 支持 timeout、stdout/stderr 捕获、截断、cwd tracking、
  approval metadata 和进程清理。
- **权限模式**：支持 `read-only`、`workspace-write`、`danger-full-access`。拒绝、
  超时、sandbox 失败和工具错误都会作为普通 tool result 回灌给模型。runtime context
  也会告诉模型当前启用的权限和 OS sandbox 限制。
- **JSON event stream**：`lightcc -p "..." --json` 会输出 live JSONL events，包括
  assistant message、tool call/result、approval、error、turn completion 和 final status。
- **可 replay 的 session**：每个 session 写 JSONL event transcript。replay 会校验
  assistant tool call 和 tool result 的配对，而不是依赖丢信息的 chat history。
- **Context 管理**：project instructions、runtime facts、tool schemas、skills、
  todo state 和历史投影通过稳定 slot 组装。大工具输出会被限制，并支持 compaction。
- **只读 Git 反馈**：`git_feedback` 可以返回 branch、HEAD、dirty files、diff stats
  和 bounded patch preview，但不会 commit，也不会修改 git 状态。
- **薄扩展面**：stdio MCP tools、显式 `SKILL.md` 加载、本地 slash commands、
  lifecycle hooks 和 session-scoped todo tool 都走同一套 tool runtime。
- **可选 OS sandbox**：宿主依赖满足时，`bash` 可以在 `auto` 或 `required` 模式下由
  `@anthropic-ai/sandbox-runtime` 包裹执行。

## 常用命令

```sh
# 在当前目录启动交互 session
lightcc

# 一次性 prompt
lightcc -p "总结这个仓库。"

# 面向自动化的 JSONL event stream
lightcc -p "总结这个仓库。" --json

# 指定工作目录
lightcc --cwd /path/to/repo

# 恢复同一 cwd 的最新 session
lightcc resume --last

# 列出当前 workspace 的 session id
lightcc sessions

# 恢复指定 session
lightcc resume <session-id>

# 在可信仓库里使用完整本地访问权限
lightcc --permission-mode danger-full-access

# 检查 sandbox 支持
lightcc doctor --sandbox

# 不请求模型，只检查配置和 session plan
lightcc --dry-run -p "hello"
```

## 配置

配置按层覆盖：

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

项目配置放在 `.lightcc/config.json`。它可以设置项目相关 runtime 选项，但 secret 应该
留在用户环境变量或全局配置中。

常用参数：

```text
-p <prompt>              执行一次性任务
--cwd <path>             workspace root，默认当前目录
--model <name>           覆盖配置中的 model
--base-url <url>         覆盖配置中的 provider base URL
--api-key-env <name>     指定保存 API key 的环境变量
--json                   为 one-shot/doctor 命令输出 JSON
--permission-mode <mode> read-only | workspace-write | danger-full-access
--os-sandbox <mode>      off | auto | required
--sandbox-settings <path> 显式 sandbox settings 路径
--max-steps <number>     最大 model/tool loop 步数
--mcp-config <path>      显式 stdio MCP server 配置
--skill <path>           启用包含 SKILL.md 的 skill 目录
```

## 设计边界

实现里有几条硬边界：

- `AgentSession.submit(op)` 和 `events()` 是公开 session 接口。
- `ToolRuntime` 是 validation、permission check、execution、result normalization、
  truncation 和 error-to-result conversion 的唯一路径。
- `ContextAssembler` 负责组装 provider request。
- transcript 写入失败是 fatal。
- host slash commands 默认不会进入 model-visible history。

这些边界让代码保持小，同时保留真实 coding agent 需要的不变量。

## 当前不做

- 全屏 TUI
- 账号登录、OAuth 或 provider account 管理
- 持久 trust rules
- background jobs 或 persistent shell sessions
- subagents 或 planner/executor 编排
- 自动 commit、push 或创建 PR
- 插件市场

## 开发

从源码开发：

```sh
bun install
bun run build
bun run test
bun run typecheck
```

请使用脚本里的测试命令。它会排除本地 reference material 和 sandbox submodule，避免
测试 runner 扫到不该扫的目录。

本地无网络 smoke test：

```sh
lightcc --fake -p "hello"
```

## Clean-Room 范围

`light-cc-coder` 受 Claude Code 的工作模型启发，但实现是 clean-room 的。不复制
Claude Code 源码、私有 prompt、恢复版实现细节或产品文件布局。

## License

Released under the [MIT License](LICENSE).
