# light-cc-coder

[English](README.md)

`light-cc-coder` 是一个轻量的 TypeScript coding agent harness，核心目标是实现一种接近 Claude Code 工作方式的、可检查、可复现、可以真实跑在代码仓库里的 agent runtime。

它不是完整 Claude Code 复刻，也不是教学 demo。当前重点是把基础链路做扎实：模型循环、文件工具、shell 工具、权限边界、tool/result 配对，以及可 replay 的 JSONL transcript。

项目还处在早期。现在主要入口是一次性 CLI；REPL、MCP、skills、memory、compact 等还不是稳定能力。

## 能做什么

- 调 OpenAI-compatible streaming 模型
- 在 workspace 内读、搜、改文件：`read`、`grep`、`glob`、`edit`、`write`、`apply_patch`
- 通过 `bash` 工具运行命令，带 timeout 和 stdout/stderr 捕获
- 支持 `read-only`、`workspace-write`、`danger-full-access` 三种权限模式
- 写 JSONL transcript，方便调试和 replay
- 用 Bun + TypeScript 写核心模块和测试

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

如果要让一次性 CLI 直接执行 shell 命令，用 `danger-full-access`：

```bash
bun src/cli/main.ts \
  -p "运行 bun run typecheck，并汇报结果。" \
  --cwd "$PWD" \
  --permission-mode danger-full-access \
  --transcript /tmp/light-cc-check.jsonl
```

默认权限是 `workspace-write`。这个模式下，普通 `bash` 会请求 approval；但当前一次性 CLI 不是交互 UI，所以会自动 deny。要做 shell demo，先显式使用 `danger-full-access`。

## 常用参数

```text
-p <prompt>              一次性 prompt
--cwd <path>             workspace root
--model <name>           默认读 OPENAI_MODEL
--base-url <url>         默认读 OPENAI_BASE_URL
--api-key-env <name>     默认读 OPENAI_API_KEY
--transcript <path>      写 JSONL 事件
--max-steps <number>     最大 model/tool loop 步数
--permission-mode <mode> read-only | workspace-write | danger-full-access
--fake                   使用 fake provider
```

## 调试

最重要的调试产物是 transcript：

```bash
tail -n 20 /tmp/light-cc-session.jsonl
```

里面会记录 context assembly、assistant message、tool call、permission decision、bash observation、tool result 等事件。失败时先看 transcript，通常比看最终输出更有用。

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
