# Adapter Preflight

Preflight 是 adapter 的离线预检。

它只检查：

- adapter schema 能否加载。
- adapter 是否支持目标 benchmark。
- 命令模板是否能渲染。
- required env 是否在当前环境中存在。
- 可选检查 CLI executable 是否能在 PATH 中找到。

它不会：

- 安装依赖。
- 启动 coder。
- 启动 Harbor / SWE-bench。
- 调用模型 API。

示例：

```bash
bun evals/adapters/preflight/inspect.ts \
  --adapter lightcc \
  --benchmark terminal-bench \
  --api-key-env DEEPSEEK_API_KEY
```

如果要检查本机命令是否存在：

```bash
bun evals/adapters/preflight/inspect.ts \
  --adapter ./evals/adapters/coders/drafts/aider.json \
  --check-executable
```
