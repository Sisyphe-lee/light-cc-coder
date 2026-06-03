# Coder Adapter 支线

这个目录用于描述“不同 coder 如何被 eval runner 调用”，以及未来横评前的 dry-run planner、preflight、结果 schema 和 conformance fixture。

当前阶段它已经接入 SWE-bench / Terminal-Bench runner 的 `--coder` 参数，但仍保留 planner、preflight 和 conformance fixture 作为正式横评前的安全网。

## 当前边界

- draft adapter 不启动正式 benchmark。
- 不安装外部 coder。
- 不调用模型 API。
- 不在 adapter 配置中保存 API key、token、password 等 secret 值。

## 目录

```text
evals/adapters/
  README.zh-CN.md
  coders/
    types.ts       # schema 类型
    registry.ts    # 内置 adapter：lightcc/openhands/aider/opencode ready；reasonix draft
    loader.ts      # 校验、加载、模板渲染
    inspect.ts     # 离线 list / render helper，不执行评测
    drafts/        # 外部 coder JSON；reasonix 仍为 blocked draft
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
{promptFile}
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
  --prompt-file /logs/agent/prompt.md \
  --workspace /workspace \
  --artifact-dir /logs/agent \
  --transcript /logs/agent/transcript.jsonl \
  --patch /logs/agent/patch.diff \
  --model deepseek-v4-flash \
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
  --model deepseek-v4-flash \
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

1. `lightcc`、`openhands`、`aider`、`opencode` 已通过 2026-06-02 DeepSeek V4 Flash headless conformance smoke，可用于 SWE-bench 本机 agent run。
2. Terminal-Bench 的真实 Harbor installed-agent runtime 当前只验证了 `lightcc`；外部 coder 只能进入 dry-run/preflight，直到容器内安装、env 注入、退出码、transcript 和 patch 契约被验证。
3. `deepseek-reasonix` 保持 blocked draft；必须验证 headless prompt 输入、自动执行、退出码、日志、patch 捕获和 secret 传递后才能升级为 ready。
4. 为每个 ready 外部 coder 固定安装来源：npm version、pip version、release tarball 或 Docker image digest。
5. 先记录 pass/fail、wall time、patch；usage/cost 解析可以按 coder 单独补。

## 第一批外部 coder 草案

- `openhands`：使用 `openhands --headless --json --file {promptFile} --override-with-envs`，通过 `LLM_MODEL=openai/{model}`、`LLM_BASE_URL` 和 `LLM_API_KEY` 注入模型配置。
- `aider`：使用 `aider --message-file {promptFile}` 做一次性非交互编辑，DeepSeek 模型渲染为 `deepseek/{model}`，API key 由 `{apiKeyEnv}` 指向，例如 `DEEPSEEK_API_KEY`。
- `opencode`：使用 `opencode run --format json --file {promptFile}`，并通过 `OPENCODE_CONFIG_CONTENT` 写入只含 `{env:{apiKeyEnv}}`、`{baseUrl}` 和 `deepseek/{model}` 的内联配置，不保存 secret。
- 三个外部 coder 已完成本机 smoke；下一步是 Terminal-Bench installed-agent wrapper 验证。

## DeepSeek Reasonix 准入条件

Reasonix 官方集成文档中的 `npx reasonix code` 是 TUI 入口；正式 benchmark 不使用 TUI 自动化。Reasonix 项目 CLI reference 中的 `reasonix run <task>` 是候选 headless 入口。要把 `deepseek-reasonix` 从 `draft` 升级为 `ready`，必须先完成：

- 固定安装来源，例如 `reasonix@<version>` 或 tarball/digest。
- 在干净 workspace 中验证 `reasonix run <task>` 可非交互完成并返回可信 exit code。
- 验证 DeepSeek API key 可通过安全 env/env-file 注入，且不会写入命令行、日志或 artifact。
- 验证默认或显式模型为 `deepseek-v4-flash`；如需通过配置文件而非 env 控制，必须把配置写入隔离的临时 HOME。
- 验证能捕获 transcript/stdout/stderr，并能从工作树收集 patch。
- 在 SWE-bench sample 和 Terminal-Bench dry-run/conformance smoke 后，再允许真实 benchmark run。
