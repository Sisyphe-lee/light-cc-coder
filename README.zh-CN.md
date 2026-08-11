# light-cc-coder

[English](README.md)

`light-cc-coder` 是一个面向真实代码仓库的轻量 Claude Code 风格 TypeScript coder
harness。核心 `src/` 约 10k 行：足够小，便于审计；也足够完整，已经包含一个终端
repo loop 需要的权限、文件和 shell 工具、稳定 context、可 replay 的 JSONL
transcript、compaction、resume 和实用 CLI。

## 安装

推荐安装脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/Sisyphe-lee/light-cc-coder/main/install.sh | bash
```

这个脚本会检查 Node/npm，先安装 `@anthropic-ai/sandbox-runtime`，再安装 lightcc npm
包，并运行 `lightcc doctor --sandbox`，所以 sandbox 依赖问题会在安装后立刻暴露出来。
它不会调用 `sudo`、`apt` 或 `brew`。

直接用 npm 安装：

```sh
npm install -g light-cc-coder
```

直接安装的 lightcc npm 包会包含 sandbox runtime library 依赖。如果还想要独立的 `srt`
命令做宿主检查，可以单独安装：

```sh
npm install -g @anthropic-ai/sandbox-runtime
srt -c 'echo sandbox-ok'
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

进入一个代码仓库并启动交互式 TUI：

```sh
cd your-project
lightcc
```

TUI 是 TTY 下的默认交互模式；想用旧的行式 REPL 加 `--repl`。详见下方「交互式 TUI」一节。

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

## 交互式 TUI

在终端里直接运行 `lightcc`（不带 `-p`）会进入全屏交互式 TUI：

```sh
cd your-project
lightcc
```

界面分区：

- 顶部可滚动的转录区：流式助手回复（轻量 markdown 着色：围栏代码块、行内 code、
  粗体、标题、列表），以及工具调用卡片（含输入摘要和 ok/error 状态）。
- 右侧边栏分组面板：会话信息（model、权限模式、session id）、上下文用量（已用/上限
  比值 + 带自动压缩阈值刻度的进度条，接近阈值时变黄、越过后变红）、累计 token
  用量（in/out、缓存命中率、steps）与 todo 列表。工具卡逐个显示耗时，每个 turn
  结束追加一行摘要（耗时、steps、token 增量）；空会话打开时显示欢迎横幅。
- 底部状态栏：model、权限模式、上下文 token 占用、当前 turn 状态。
- 最底部：多行输入框。粘贴走 bracketed paste，多行文本原样插入而不会逐行提交；
  输入 `/` 会弹出 slash 命令补全列表；turn 进行中输入的消息会排队，随 turn 结束
  依次发送。

快捷键（空输入时按 `?` 可查看内置帮助）：

```text
Enter              提交当前输入
\ + Enter、Alt-Enter  插入换行
Tab                补全选中的 slash 命令
↑ / ↓              先在输入行间移动，到边界后切换历史输入
← / → / Home / End 在行内移动光标
Ctrl-A / Ctrl-E    跳到行首 / 行尾
Ctrl-U / Ctrl-K / Ctrl-W  删除到行首 / 行尾 / 前一个词
PageUp / PageDown  滚动转录区（鼠标滚轮按行滚动）
Ctrl-G             复制模式：释放鼠标捕获以便终端原生选择文本
Ctrl-L             强制重绘
Esc                中止进行中的 turn（丢弃排队消息）/ 清空输入
Ctrl-C             中止当前 turn；空闲时连按两次退出
Ctrl-D             退出
?                  开关帮助覆盖层（空输入时）
```

工具需要审批时会弹出审批面板，按 `a` 允许、`d` 拒绝、`Esc` 中止。

TUI 是 TTY 下的默认交互模式。遇到管道输入、tmux 异常或终端不兼容时，可用 `--repl`
回退到行式 REPL：

```sh
lightcc --repl
```

只预览界面、不消耗 API（使用确定性的 fake provider）：

```sh
lightcc --fake
```

## 运行要求

- Node.js 20 或更新版本
- `rg`，用于快速文件搜索
- 一个 OpenAI-compatible chat completions endpoint

Bun 只在源码开发和打包时需要。

## 它能做什么

- **交互和一次性 CLI**：`lightcc` 在终端里默认进入全屏交互式 TUI（`--repl` 回退到
  line-oriented REPL），`lightcc -p "..."` 适合脚本和 smoke test。
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

## Profiling

Profiling 是本地、显式开启的 harness 性能/成本观测工具。它不是任务质量 benchmark、
judge、leaderboard、telemetry，也不做模型路由。

记录一次带 profiling 的交互 REPL session：

```sh
lightcc \
  --profile \
  --transcript /tmp/lightcc-repl-profile.jsonl \
  --cwd "$PWD"
```

用 `/exit`、`/quit` 或 Ctrl-D 退出 REPL 后，transcript 会包含这次交互 session 的所有
turn，以及 profiling spans。

记录一次带 profiling 的 one-shot session：

```sh
lightcc -p "搜索这个仓库里的 TODO，并总结涉及哪些文件。" \
  --profile \
  --transcript /tmp/lightcc-profile.jsonl \
  --cwd "$PWD"
```

离线汇总 transcript：

```sh
# 人读摘要
lightcc profile /tmp/lightcc-profile.jsonl

# 稳定 JSON report
lightcc profile /tmp/lightcc-profile.jsonl \
  --json \
  --out /tmp/lightcc-profile.report.json
```

transcript 仍然是权威 session event log。Profiling 只会额外写入 replay-invisible
`profile.span` events；这些 span 不进入 model-visible history，也不会影响 tool/result
配对或 replay。

单次 profile report 会测这些内部瓶颈：

- startup 和扩展初始化；
- context assembly 耗时和估算 context size；
- provider 调用、time to first token、stream duration、retry、token 计数，以及 provider
  返回时的 cache-read/cache-write counters；
- tool batch 和单个 tool execution 耗时，包括 error、denial、timeout；
- approval wait time；
- runtime/bash duration、nonzero exit、timeout 和 truncation；
- 配置 MCP 时的 MCP startup 和 MCP tool-call 计数；
- compaction 次数、耗时和 pre/post token estimates；
- transcript write 次数、字节数、耗时，以及 profiler 自身写入开销。

产物是本地 artifact：

```text
transcript.jsonl        session events + replay-invisible profile spans
profile.report.json     稳定的单次 run JSON profile report
```

从源码 checkout 开发时，还有两个 developer-only helper：

```sh
# 确定性 FakeProvider 回归 guard（在 test/profiling 里）
bun test test/profiling/

# 可选 live N-run profiling。真实 provider/network，不作为 CI gate。
bun profiling/liveRuns/runner.ts --scenario pong --runs 7 --warmup 1 \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs \
  --model "$OPENAI_MODEL" \
  --base-url "$OPENAI_BASE_URL" \
  --api-key-env OPENAI_API_KEY

# 不打真实 provider 的同一 runner smoke。
bun profiling/liveRuns/runner.ts --scenario pong --fake --runs 2 --warmup 1 \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs-fake \
  --os-sandbox off
```

live runner 会为每次 run 写一个 transcript 和一个 `profile.report.json`，最后写
`live-runs.summary.json`。聚合 summary 包含 median、min/max/IQR、bottleneck
frequency、provider token/cache 摘要、tool/runtime/context/transcript-write 聚合，以及
failed/skipped run 记账。warmup run 会保留在磁盘上，但不进入聚合统计。

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
