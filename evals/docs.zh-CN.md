# light-cc-coder 评测环境推进计划

这份文档用于跟踪我们评测环境建设推进到哪一层，以及每一层的交付标准。

## 当前结论

评测环境先放在本仓库中实现，原因是它和当前 coder 的 CLI、transcript、权限、workspace 边界、artifact 输出强相关。

第一版不做大型评测平台，只做轻量 adapter 和自评 runner：

- 官方 benchmark 尽量调用官方评测器。
- 本仓库只负责调用 `light-cc-coder`、保存运行产物、汇总指标。
- 运行结果统一放到 `.light-cc/evals/<run_id>/`，不进入 git。

## 总体分层

| 层级 | 目标 | 状态 |
|---|---|---|
| E0：目录和计划 | 创建 `evals/` 结构，写清楚路线 | 已完成 |
| E1：Headless Eval Interface | 让 coder 能被外部 runner 稳定调用 | 已实现，目标测试和 typecheck 已通过 |
| E2：Internal Self-Eval | 测 harness 自身不变量 | 已完整实现，目标验证通过 |
| E3：SWE-bench Lite | 测真实 repo 修复能力 | Adapter 已实现，dry-run 已验证 |
| E4：Terminal-Bench 2.1 | 测终端执行和长任务能力 | 未开始 |
| E5：Unified Report | 汇总所有评测结果 | 未开始 |

## E0：目录和计划

目标：先把评测代码的落点定下来。

当前结构：

```text
evals/
  docs.md
  docs.zh-CN.md
  lib/
  self/
    fixtures/
  swebench/
  terminal-bench/
```

验收标准：

- `evals/` 目录存在。
- 中文/英文计划文档存在。
- `.light-cc/evals/` 作为运行产物目录，并且被 gitignore。

## E1：Headless Eval Interface

目标：让 `light-cc-coder` 可以被 SWE-bench、Terminal-Bench 和 self-eval runner 稳定调用。

需要补齐的 CLI 能力：

- `--prompt-file`
- `--output-json`
- `--quiet`
- `--json-events`
- `--artifact-dir`

已有可复用能力：

- `--cwd`
- `--transcript`
- `--max-steps`
- `--permission-mode`
- `--model`
- `--fake`

验收标准：

- 一个命令能在任意 workspace 中 headless 跑完任务。
- 每次运行能产出 `run.json`、`summary.json`、`transcript.jsonl`、stdout/stderr 日志。

## E2：Internal Self-Eval

目标：先用小型、稳定、便宜的 fixture 检查 coder harness 是否健康。

第一批 fixtures：

- `file-crud`
- `exact-edit`
- `shell-error-feedback`
- `permission-denied`
- `workspace-boundary`
- `tool-result-pairing`
- `transcript-replay`
- `context-compaction`
- `tiny-ts-bugfix`
- `tiny-python-bugfix`

目标命令：

```bash
bun run eval:self
bun run eval:self --fixture tiny-ts-bugfix
bun run eval:self --model fake
```

验收标准：

- fake provider 可以稳定跑 deterministic fixtures。
- 真模型至少跑通工具基础、安全边界和一个小 bugfix。
- 输出 pass/fail、失败原因、turn 数、tool call 数、耗时、transcript 校验结果。

## E3：SWE-bench Lite

目标：用公开可信 benchmark 评估真实代码修复能力。

固定版本：

- `swebench==4.1.0`
- dataset：`SWE-bench/SWE-bench_Lite`
- split：`test`
- dataset revision：`69611d31007e1c6731db8bd5b5c3f2d33f5bab6e`

我们要写的只是 adapter：

- 准备 instance workspace
- 生成 prompt
- 调用 `light-cc-coder`
- 收集 `git diff --binary`
- 写 `predictions.jsonl`
- 调官方 evaluator
- 保存 transcript、patch、logs、metrics

目标命令：

```bash
bun run eval:swebench -- --instance sympy__sympy-20590 --dry-run
bun run eval:swebench -- --instance sympy__sympy-20590 --run-agent
bun run eval:swebench -- --gold --evaluate --instance sympy__sympy-20590 --max-workers 1
```

验收标准：

- gold prediction 单题 evaluator smoke 通过。
- agent 单题能生成合法 `predictions.jsonl`。
- 5 题 smoke 能输出 resolved rate 和每题失败原因。

当前状态：

- 已实现 thin adapter，不重写官方 evaluator。
- 已支持本地实例文件 dry-run、prompt 生成、防泄漏检查、official prediction shape 和 artifact 输出。
- 已支持可选真实路径：准备 base commit workspace、调用 `light-cc-coder`、收集 patch、调用官方 evaluator。
- 已验证离线 sample dry-run 和 typecheck。
- 还需要准备外部环境后执行 gold smoke、agent single smoke 和 3-5 题 smoke。

## E4：Terminal-Bench 2.1

目标：评估 terminal autonomy、命令执行、环境操作和长任务能力。

固定版本：

- `harbor==0.13.0`
- dataset：`terminal-bench/terminal-bench-2-1`
- 第一阶段：`-k 1`
- 后续对齐 leaderboard：`-k 5`

我们要写 Harbor installed-agent adapter，让 Terminal-Bench 在任务容器中调用 `light-cc-coder`。

目标命令：

```bash
bun run eval:tbench --task openssl-selfsigned-cert
bun run eval:tbench --limit 3
```

验收标准：

- Harbor oracle 单题 smoke 通过。
- `light-cc-coder` 单题 smoke 能跑完整流程。
- 3 题 smoke 能输出 pass/fail、日志和失败原因。

## E5：Unified Report

目标：把 self-eval、SWE-bench、Terminal-Bench 的结果汇总成统一报告。

统一运行目录：

```text
.light-cc/evals/<run_id>/
  run.json
  summary.json
  self/
  swebench/
  terminal-bench/
```

每个任务至少保存：

- `prompt.md`
- `transcript.jsonl`
- `stdout.log`
- `stderr.log`
- `patch.diff`
- `metrics.json`

统一指标：

- pass/fail 或 resolved/unresolved
- duration
- turn count
- tool call count
- permission denial count
- changed file count
- diff line count
- transcript validity
- failure reason

## 当前下一步

E3 adapter 离线路径已实现并验证。下一步建议先补外部环境检查，然后运行：

1. SWE-bench gold 单题 smoke。
2. agent 单题 smoke。
3. 3-5 题小批量 smoke。
