# Terminal-Bench Adapter

E4 的目标是接入 Terminal-Bench 2.1，但不在本仓库重写 Harbor evaluator。

本仓库的 adapter 只负责：

- 生成可复现的 `harbor run` 命令。
- 提供 `light-cc-coder` 的 Harbor installed-agent wrapper。
- 写入本仓库统一的 eval artifact。
- 做本机环境 preflight。
- 默认 dry-run，真实 Harbor 运行必须显式传 `--run`。

## 固定基线

- runner：`harbor==0.13.0`
- dataset：`terminal-bench/terminal-bench-2-1`
- 初始 attempts：`-k 1`
- leaderboard 对齐 attempts：后续使用 `-k 5`
- agent import path：`evals.terminal_bench.agent:LightCCCoderAgent`
- Harbor job name：默认使用本次 `runId`

## 常用命令

环境预检：

```bash
bun run eval:tbench -- --preflight
```

如果 Harbor 安装在独立 venv 中，建议显式指定 Harbor 和同 venv 的 Python，这样 preflight 会真实导入 agent wrapper：

```bash
bun run eval:tbench -- \
  --preflight \
  --harbor /home/sjx/.venvs/light-cc-harbor/bin/harbor \
  --python /home/sjx/.venvs/light-cc-harbor/bin/python
```

离线 dry-run，只写 artifact 和 Harbor 命令，不启动容器：

```bash
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --dry-run
```

真实运行单题：

```bash
bun run eval:tbench -- \
  --task terminal-bench/break-filter-js-from-html \
  --run \
  --attempts 1 \
  --agent-package-spec light-cc-coder \
  --max-steps 120
```

评测当前未发布分支时，可以把当前仓库和 Node 运行时挂进 Harbor 容器，避免容器安装 npm 上的旧包：

```bash
bun run eval:tbench -- \
  --task terminal-bench/break-filter-js-from-html \
  --run \
  --harbor /home/sjx/.venvs/light-cc-harbor/bin/harbor \
  --base-url https://api.deepseek.com \
  --agent-package-spec source:/opt/light-cc-coder \
  --agent-node-dir /opt/lightcc-node \
  --agent-env-file /run/lightcc/deepseek.env \
  --mounts '[{"type":"bind","source":"/home/sjx/light-cc-coder","target":"/opt/light-cc-coder","read_only":true}]' \
  --mounts '[{"type":"bind","source":"/home/sjx/.local/opt/node-v22","target":"/opt/lightcc-node","read_only":true}]' \
  --mounts '[{"type":"bind","source":"/home/sjx/.lightcc/deepseek.env","target":"/run/lightcc/deepseek.env","read_only":true}]'
```

如果 verifier 需要从 GitHub 下载依赖，而远程代理只监听宿主机 `127.0.0.1:7897`，可以使用 host-network overlay 并只给 verifier 注入代理：

```bash
bun run eval:tbench -- \
  --task terminal-bench/break-filter-js-from-html \
  --run \
  --verifier-proxy http://127.0.0.1:7897 \
  --verifier-env UV_HTTP_TIMEOUT=120 \
  --agent-timeout-multiplier 2 \
  --extra-docker-compose evals/terminal-bench/docker-compose.host-network.yml
```

## 产物

默认输出：

```text
.light-cc/evals/<run_id>/terminal-bench/
  run.json
  summary.json
  harbor-command.json
  selected_tasks.jsonl
  preflight.json
  tasks/<task_id>/
    prompt.md
    metrics.json
  harbor/
    command.json
    stdout.log
    stderr.log
  jobs/
    # Harbor job output
```

## 当前边界

- 第一版不解析 Harbor job 结果为统一分数，只保存 Harbor 原始 jobs 目录和 stdout/stderr。
- 真实 Harbor run 后会读取 `jobs/<run_id>/result.json`，把 completed/error 和 mean reward 写入本仓库的 `summary.json`。
- preflight 会检查 Harbor CLI、Docker、Docker daemon，并通过 Python 实际导入 `evals.terminal_bench.agent:LightCCCoderAgent`。
- 当前 runner 对 dataset 内单题使用 `-d terminal-bench/terminal-bench-2-1 -i <task>`。如果要直接运行 registry 单任务，后续可以再加 `--registry-task` 形态映射到 Harbor 的 `-t terminal-bench/<task>`。
- `--model` 会同时写入 Harbor `-m` 和容器内 `LIGHT_CC_MODEL`，避免报告模型名和实际执行模型不一致。
- `--base-url` 会自动把 hostname 加入 Harbor `--allow-agent-host`，也可以手动重复传 `--allow-agent-host <host>`。
- `--verifier-env KEY=VALUE` 会透传给 Harbor verifier；`--verifier-proxy <url>` 会自动生成 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` verifier env，并把 proxy hostname 加入 `--allow-environment-host`。
- `--extra-docker-compose <path>` 会透传给 Harbor，可用于附加 host-network 或 extra_hosts overlay；`evals/terminal-bench/docker-compose.host-network.yml` 是远程代理只绑定 loopback 时的 smoke 稳定性模板。
- `--timeout-multiplier`、`--agent-timeout-multiplier`、`--verifier-timeout-multiplier` 等会直接透传给 Harbor；DeepSeek 响应较慢的 smoke 建议至少设置 `--agent-timeout-multiplier 2`。
- `--api-key-env` 支持自定义环境变量名；agent wrapper 会把该变量值透传进容器命令，但不会写入本仓库的 JSON artifact。
- 推荐用 `--agent-env-file <container-path>` 配合只读 mount 传 API key，避免 Docker Compose 进程参数暴露 secret。
- 多个 `--mounts` 参数会在 adapter 内合并为 Harbor 期望的单个 JSON array。
- `--agent-package-spec source:<path>` 会在容器内直接使用已挂载源码的 `dist/main.js`，适合当前分支 smoke；正式可复现实验仍建议改为固定 npm 包、tarball 或镜像 digest。
- `--limit` 用于小规模 smoke；真实大规模运行必须传 `--allow-large-run`。
- 默认传给 container 内 lightcc 的 OS sandbox 是 `off`，因为 Terminal-Bench/Harbor 已经在容器层隔离任务。
- 如果要评测本分支未发布版本，需要先让 container 可安装对应 npm spec，或者后续扩展 setup 逻辑支持本地 tarball。

## 验证

```bash
bun test test/evals/terminal-bench-adapter.test.ts
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --dry-run --run-id tbench-dry-smoke
bun run typecheck
```
