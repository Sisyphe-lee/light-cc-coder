# SWE-bench Lite Adapter

E3 的目标是接入 SWE-bench Lite，但不重写官方 evaluator。

本仓库的 adapter 只负责：

- 加载公开 instance 信息。
- 过滤掉不能暴露给 agent 的字段。
- 生成 prompt。
- 可选地 clone repo、checkout `base_commit`、调用 `light-cc-coder`。
- 收集 `git diff --binary`。
- 写官方 `predictions.jsonl`。
- 可选地调用官方 `swebench.harness.run_evaluation`。

## 固定基线

- `swebench==4.1.0`
- dataset：`SWE-bench/SWE-bench_Lite`
- split：`test`
- dataset revision：`69611d31007e1c6731db8bd5b5c3f2d33f5bab6e`

## 常用命令

本机环境预检：

```bash
bun run eval:swebench -- --preflight
```

离线 dry-run，不访问 Hugging Face 或 GitHub：

```bash
bun run eval:swebench -- \
  --instances-file evals/swebench/fixtures/sample-instance.json \
  --dry-run
```

加载官方 dataset 中的单个实例并生成 prompt：

```bash
bun run eval:swebench -- --instance sympy__sympy-20590 --dry-run
```

真实运行 agent 并写 `predictions.jsonl`：

```bash
bun run eval:swebench -- \
  --instance sympy__sympy-20590 \
  --run-agent \
  --max-steps 80 \
  --permission-mode danger-full-access
```

官方 gold evaluator smoke：

```bash
bun run eval:swebench -- \
  --gold \
  --evaluate \
  --instance sympy__sympy-20590 \
  --max-workers 1
```

Mac ARM 上如果遇到镜像 namespace / 架构问题，可以透传空 namespace：

```bash
bun run eval:swebench -- \
  --gold \
  --evaluate \
  --instance sympy__sympy-20590 \
  --max-workers 1 \
  --namespace ""
```

评估已有 predictions 文件：

```bash
bun run eval:swebench -- \
  --instance sympy__sympy-20590 \
  --evaluate \
  --predictions-path .light-cc/evals/<run_id>/swebench/predictions.jsonl
```

默认模式是 dry-run。`--run-agent` 和 `--evaluate` 都需要显式传入，且一次超过 5 个实例时需要额外传 `--allow-large-run`，避免误跑完整 split。

## 产物

默认输出：

```text
.light-cc/evals/<run_id>/swebench/
  run.json
  summary.json
  predictions.jsonl
  dataset/instances.json
  instances/<instance_id>/
    instance.json
    prompt.md
    patch.diff
    metrics.json
    agent/
      transcript.jsonl
      summary.json
      stdout.log
      stderr.log
  evaluator/
    stdout.log
    stderr.log
```

当前 runner 还会写：

- `selected_instances.jsonl`
- `dataset/loader-command.json`，当从 Hugging Face dataset 加载实例时存在
- `evaluator/command.json`，当调用官方 evaluator 时存在

## 防泄漏规则

prompt 和 per-instance artifacts 只写入这些字段：

- `instance_id`
- `repo`
- `base_commit`
- `problem_statement`

以下字段不能进入 prompt，也不能写进 agent workspace：

- `patch`
- `test_patch`
- `FAIL_TO_PASS`
- `PASS_TO_PASS`
- evaluator logs
- hidden tests

## 当前边界

第一版 adapter 支持 dry-run 和 agent/evaluator 调用路径，但真实 SWE-bench 运行仍依赖本机环境：

- Python 环境中安装 `swebench==4.1.0` 或至少安装 `datasets`。
- Docker 可用。
- 能访问 GitHub clone 目标 repo。
- provider 环境变量配置完整。

如果这些外部条件未准备好，仍可以先用 sample instance 跑 dry-run 验证 prompt、metadata、predictions 格式和 artifact contract。

## 当前已验证

本仓库当前已验证：

```bash
bun test test/evals/swebench-adapter.test.ts
bun run eval:swebench -- --instances-file evals/swebench/fixtures/sample-instance.json --dry-run --run-id swebench-dry-smoke
bun run eval:swebench -- --preflight --run-id swebench-preflight-local
bun run typecheck
```

这说明 E3 adapter 的离线路径、prompt 防泄漏、官方 prediction shape 和 artifact contract 已经打通。真实 SWE-bench 分数仍需要先准备 Python `swebench==4.1.0`、Docker 和 provider 配置。

当前本机 preflight 结果：

- Python 3.11 可用。
- `datasets` 可用。
- `swebench==4.1.0` 未安装。
- Docker CLI 可用，但 Docker daemon 未启动。
- 当前磁盘可用空间约 26GiB，低于官方建议的 120GB。
- 当前机器是 Mac ARM，需要准备好必要时使用 `--namespace ""`。
