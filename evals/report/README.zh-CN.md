# Unified Eval Report

E5 用于汇总同一个 run id 下的 SWE-bench 和 Terminal-Bench artifacts。

## 命令

```bash
bun run eval:report -- --run-id <run_id>
```

也可以直接指定运行目录：

```bash
bun run eval:report -- --run-dir .light-cc/evals/<run_id>
```

## 输入

默认读取：

```text
.light-cc/evals/<run_id>/swebench/summary.json
.light-cc/evals/<run_id>/terminal-bench/summary.json
```

缺少其中一个 benchmark summary 不会失败，报告会把它标记为 missing。

## 输出

```text
.light-cc/evals/<run_id>/report/
  report.md
  report.zh-CN.md
  report.json
  failures.jsonl
  cost.json
```

`report.md` 为英文摘要，`report.zh-CN.md` 为中文摘要。`report.json` 会额外聚合 profile coverage：

- `wrapper`: 外部 wrapper 的 `wrapper.profile.json` 覆盖率，只统计符合 schema 的 bounded profile。
- `internal`: light-cc 内部 `profile.report.json` 覆盖率。
- `provider`: 内部 profile 中 provider 调用/用量字段的覆盖率。

`wrapper.profile.json` 的草案契约位于 `evals/wrapper-profile/`。该文件只能包含 bounded metadata、路径、字节数、hash 和环境变量名，不能包含 raw args、prompt、stdout、stderr、patch、diff、环境变量值或其它正文内容。

失败类型固定为：

- `model_failure`
- `verifier_flake`
- `harness_failure`
- `timeout`
- `empty_patch`
- `api_or_network_failure`
- `environment_failure`
