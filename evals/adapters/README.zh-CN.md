# Coder Adapter 支线

这个目录用于描述“不同 coder 如何被 eval runner 调用”，以及未来横评前的 dry-run planner、preflight、结果 schema 和 conformance fixture。

当前阶段它是旁路测试/横评支撑层，不接入 SWE-bench / Terminal-Bench 主 runner，避免和正在推进的 Docker Compose / Harbor smoke 主线冲突。

## 当前边界

- 不启动 benchmark。
- 不安装外部 coder。
- 不调用模型 API。
- 不修改 `evals/terminal-bench/run.ts` 或 `evals/swebench/run.ts`。
- 不在 adapter 配置中保存 API key、token、password 等 secret 值。

## 目录

```text
evals/adapters/
  README.zh-CN.md
  coders/
    types.ts       # schema 类型
    registry.ts    # 内置 adapter：lightcc ready，aider/generic draft
    loader.ts      # 校验、加载、模板渲染
    inspect.ts     # 离线 list / render helper，不执行评测
    drafts/        # 外部 coder 草案 JSON，默认 status=draft
  planner/         # dry-run matrix planner，只生成计划
  preflight/       # adapter 离线预检，不安装、不执行
  results/         # 跨 benchmark 统一结果 schema
  testing/
    fake-coder/    # adapter conformance fixture
```

## Adapter 字段

- `schemaVersion`：当前固定为 `1`。
- `id`：稳定机器名，只允许 kebab-case 风格的 `a-z0-9-`，不能是路径。
- `displayName`：报告展示名。
- `status`：`ready` 或 `draft`。只有 `ready` 适合接入正式 smoke。
- `targets`：可用于 `swebench`、`terminal-bench`。
- `install`：安装方式说明，支持 `none`、`npm`、`pip`、`pipx`、`source`、`docker`、`custom`。
- `command`：headless 启动命令模板。
- `artifacts`：transcript、patch、usage 解析方式。
- `metadata`：说明、主页、备注。

模板变量使用 `{name}` 形式，例如：

```text
{instruction}
{workspace}
{artifactDir}
{transcriptPath}
{patchPath}
{resultPath}
{model}
{baseUrl}
{apiKeyEnv}
{maxSteps}
{permissionMode}
```

## 离线命令

列出内置 adapter：

```bash
bun evals/adapters/coders/inspect.ts --list
```

渲染一个 adapter 的命令，不执行：

```bash
bun evals/adapters/coders/inspect.ts \
  --adapter lightcc \
  --instruction "Fix the task." \
  --workspace /workspace \
  --artifact-dir /logs/agent \
  --transcript /logs/agent/transcript.jsonl \
  --patch /logs/agent/patch.diff \
  --model deepseek-v4-pro \
  --base-url https://api.deepseek.com \
  --api-key-env DEEPSEEK_API_KEY
```

加载外部 JSON adapter：

```bash
bun evals/adapters/coders/inspect.ts --adapter ./my-coder-adapter.json
```

生成横评 dry-run plan：

```bash
bun evals/adapters/planner/inspect.ts \
  --coder lightcc \
  --benchmark terminal-bench \
  --task terminal-bench/break-filter-js-from-html \
  --model deepseek-v4-pro \
  --attempts 1
```

离线 preflight：

```bash
bun evals/adapters/preflight/inspect.ts \
  --adapter lightcc \
  --benchmark terminal-bench \
  --api-key-env DEEPSEEK_API_KEY
```

## 接入主线前的下一步

1. 等 Terminal-Bench 主线 smoke 解决 Docker Compose v2 后，再把 `lightcc` adapter 接到 E4 runner。
2. 给一个外部 coder 做真实 smoke，例如 Aider 或 OpenCode。
3. 为每个外部 coder 固定安装来源：npm version、pip version、release tarball 或 Docker image digest。
4. 先记录 pass/fail、wall time、patch；usage/cost 解析可以按 coder 单独补。
