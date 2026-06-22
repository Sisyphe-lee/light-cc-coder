# Eval Profile Analysis

该目录实现评测 profiling 的离线分析层。输入是已有 eval run artifact，输出是一张稳定事实表和若干聚合报告；不会重跑评测，也不会读取 prompt、stdout/stderr、patch/diff、transcript 或 tool result 正文。

## 输入

```sh
bun evals/report/profile-analysis/run.ts \
  --run-root .light-cc/evals/swe20-fourway-20260602 \
  --out .light-cc/evals/swe20-fourway-20260602/profile-analysis
```

也支持：

```sh
bun evals/report/profile-analysis/run.ts --summary path/to/summary.json --out /tmp/profile-analysis
bun evals/report/profile-analysis/run.ts --profiles path/a/profile.report.json,path/b/profile.report.json --out /tmp/profile-analysis
```

`--run-root` 会递归发现：

- `wrapper.profile.json`
- `provider.profile.json`
- `agent/profile.report.json`
- `summary.json`
- `metrics.json`
- 已存在的 `final-report/swebench-analysis.rows.jsonl`

SWE-bench 优先使用已有 `swebench-analysis.rows.jsonl` 的安全元数据作为 outcome/path 事实来源；缺失时再从 matrix job summary 推断。Terminal-Bench 使用 terminal summary、job 目录名、wrapper/internal profile 路径建立 item 关联。无法逐题关联的 run-level provider profile 会进入 warning，不会被重复计入每个 row。

## 输出

```text
profile-analysis/
  eval-profile.rows.jsonl
  eval-profile.summary.json
  eval-profile.coder-summary.json
  eval-profile.item-matrix.json
  eval-profile.outliers.json
  eval-profile.outcome-splits.json
  eval-profile-analysis.zh-CN.md
```

核心事实表是 `eval-profile.rows.jsonl`，一行表示：

```text
一个 benchmark item x 一个 coder
```

公共横比只使用四个 coder 都能产出的数据：official outcome、wrapper profile、provider profile、bounded artifact metadata、patch metadata、wrapper exit/duration。LightCC internal profile 只用于 LightCC 自身诊断，不和其他 coder 的内部机制横比。

## 隐私边界

允许读取和输出：

- bounded metadata
- 路径
- 字节数
- hash
- 耗时
- 状态
- token/request/cost 计数
- artifact kind

禁止读取或输出：

- prompt 正文
- assistant/model response 正文
- stdout/stderr 正文
- patch/diff 正文
- transcript/tool result 正文
- raw provider request/response body
- API key 或环境变量值
