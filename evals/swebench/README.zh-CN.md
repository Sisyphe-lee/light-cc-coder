# SWE-bench Adapter

E3 的目标是接入 SWE-bench profile（默认 Verified，保留 Lite），但不重写官方 evaluator。

本仓库的 adapter 只负责：

- 加载公开 instance 信息。
- 过滤掉不能暴露给 agent 的字段。
- 生成 prompt。
- 可选地 clone repo、checkout `base_commit`、调用 `light-cc-coder`。
- 收集 `git diff --binary`。
- 写官方 `predictions.jsonl`。
- 可选地调用官方 `swebench.harness.run_evaluation`。

## Profile 基线

`evals/swebench/types.ts` 中的默认 profile 是 `verified`。`lite` 仍作为快速 smoke / 兼容 profile 保留。

| profile | dataset | split | dataset revision | 说明 |
| --- | --- | --- | --- | --- |
| `verified`（默认） | `SWE-bench/SWE-bench_Verified` | `test` | `91aa3ed51b709be6457e12d00300a6a596d4c6a3` | 主评测默认基线 |
| `lite` | `SWE-bench/SWE-bench_Lite` | `test` | `69611d31007e1c6731db8bd5b5c3f2d33f5bab6e` | 快速迭代和历史兼容 |

两者当前共用：

- `swebench==4.1.0`
- 默认 eval 模型：`deepseek-v4-flash`，可用 `--model` 显式覆盖。

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

固定 safe taskset 文件并离线读取：

```bash
bun run eval:swebench -- \
  --taskset-file evals/swebench/fixtures/sample-instance.json \
  --write-taskset-file .light-cc/evals/swebench-safe-taskset.jsonl \
  --offline \
  --dry-run
```

加载默认 profile（Verified）中的单个实例并生成 prompt：

```bash
bun run eval:swebench -- --instance <instance_id> --dry-run
```

加载 Lite profile 中的单个实例并生成 prompt：

```bash
bun run eval:swebench -- --profile lite --instance <instance_id> --dry-run
```

真实运行 agent 并写 `predictions.jsonl`：

```bash
bun run eval:swebench -- \
  --instance <instance_id> \
  --run-agent \
  --max-steps 80 \
  --permission-mode danger-full-access
```

从本地 repo mirror cache 离线 checkout 后运行 agent：

```bash
bun run eval:swebench -- \
  --taskset-file .light-cc/evals/swebench-safe-taskset.jsonl \
  --repo-cache-dir .light-cc/evals/swebench-repos \
  --offline \
  --run-agent \
  --max-steps 80
```

官方 gold evaluator smoke：

```bash
bun run eval:swebench -- \
  --gold \
  --evaluate \
  --instance <instance_id> \
  --max-workers 1
```

Mac ARM 上如果遇到镜像 namespace / 架构问题，可以透传空 namespace：

```bash
bun run eval:swebench -- \
  --gold \
  --evaluate \
  --instance <instance_id> \
  --max-workers 1 \
  --namespace ""
```

评估已有 predictions 文件：

```bash
bun run eval:swebench -- \
  --instance <instance_id> \
  --evaluate \
  --predictions-path .light-cc/evals/<run_id>/swebench/predictions.jsonl
```

`--profile` 取值为 `verified` 或 `lite`，默认 `verified`。如需临时验证非 profile dataset，可继续用 `--dataset-name`、`--split`、`--dataset-revision` 直接覆盖 dataset。默认模式是 dry-run。`--run-agent` 和 `--evaluate` 都需要显式传入，且一次超过 5 个实例时需要额外传 `--allow-large-run`，避免误跑完整 split。`--taskset-file` 是 `--instances-file` 的更明确别名，两者不能同时使用；文件中可以是完整 safe instance 记录，也可以只是 instance id。`--offline` 只接受完整 safe instance 记录，不会为了 id 去加载 Hugging Face dataset。

## Safe taskset 与 repo cache

safe taskset 只包含可暴露给 agent 的字段：

- `instance_id`
- `repo`
- `base_commit`
- `problem_statement`

每次选择实例后，runner 会在报告目录写：

- `taskset.json`
- `taskset.jsonl`

如果传 `--write-taskset-file <path>`，还会把同一份 safe taskset 写到指定路径，用于固定后续 smoke/batch。`.jsonl` 后缀会写 JSONL，其它后缀写 JSON array。

`--repo-cache-dir <dir>` 指向本地 git mirror cache。对 `sample/repo`，runner 会按顺序查找这些布局：

- `<dir>/sample__repo.git`
- `<dir>/sample/repo.git`
- `<dir>/sample__repo`
- `<dir>/sample/repo`
- `<dir>/sample_repo.git`
- `<dir>/sample_repo`

命中 mirror 后，workspace 使用 `git clone --no-checkout --local <mirror> <workspace>`，再 `git checkout --detach <base_commit>`，最后移除 `origin`。`--offline --run-agent` 缺少 mirror 时会失败，不会回落到 GitHub。

## 产物

默认输出：

```text
.light-cc/evals/<run_id>/swebench/
  run.json
  summary.json
  predictions.jsonl
  taskset.json
  taskset.jsonl
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
