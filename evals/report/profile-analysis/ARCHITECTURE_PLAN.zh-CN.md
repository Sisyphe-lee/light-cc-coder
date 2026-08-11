# Eval Profile Analysis 架构计划

本文档记录 profiling 数据分析系统的目标、边界、数据模型和实施计划，供后续 session 继续实现、评审和交接使用。

## 背景

当前评测系统已经能产出多层 profiling 数据：

- 官方评测结果：SWE-bench official outcome、Terminal-Bench / Harbor reward。
- 四个 coder 公用的 profile：
  - `wrapper.profile.json`
  - `provider.profile.json`
- LightCC 内部 profile：
  - `agent/profile.report.json`

现有 `summary.json` 和 final report 只摘录了少量 profile 字段，无法充分利用这些数据做成本、速度、稳定性和失败根因分析。后续需要一个可复用的数据分析层，把所有 profile 统一进评测系统。

## 目标

建立一个可复用的 profile analysis layer：

- 支持任意 eval run 目录，不绑定某一次 20-task 实验。
- 用四个 coder 都有的公共 profile 做公平横向比较。
- 用 LightCC internal profile 做 LightCC 专属根因诊断。
- 输出稳定 JSON/JSONL，供后续 report、dashboard、自动归因和优化计划复用。
- 输出中文 Markdown 报告，方便人工复盘。
- 保持 profiling 的隐私边界：只分析 metadata、计数、耗时、token、hash、路径，不读取 prompt、stdout/stderr、patch 正文或 tool output。

## 非目标

第一版不做这些事：

- 不重跑评测。
- 不重算 raw transcript 中的模型内容。
- 不读取或复制 prompt、assistant 文本、stdout/stderr、patch/diff 正文、tool result 内容。
- 不把 LightCC internal profile 和其他 coder 的内部运行机制直接横比。
- 不做模型质量裁判。质量判断仍以 official evaluator / Harbor 为准。
- 不替代现有 `evals/report/swebench-analysis.ts`，先作为独立分析层落地，稳定后再集成。

## 三层数据架构

### 1. Official Outcome Layer

官方结果层负责回答“任务是否通过”：

- SWE-bench：
  - `resolved`
  - `unresolved`
  - `empty_patch`
  - `error`
  - `incomplete`
- Terminal-Bench：
  - `meanReward`
  - `nCompletedTrials`
  - `nErroredTrials`
  - `nCancelledTrials`
  - task status

这层是最终 outcome 的权威来源。

### 2. Common Profiling Layer

公共 profiling 层覆盖四个 coder，负责公平横比：

- `wrapper.profile.json`
- `provider.profile.json`
- artifact metadata
- wrapper process duration / exit status
- provider request / latency / token / cache / error / cost metadata

公共层用于比较：

- 成本
- token 消耗
- provider request 数
- provider latency
- cache 命中
- wrapper 运行耗时
- wrapper 非零退出
- artifact 完整性
- 高成本失败

### 3. Internal Profiling Layer

内部 profiling 层用于解释单个 coder 的内部行为。

当前只有 LightCC 有 `agent/profile.report.json`，因此第一版只展开 LightCC internal profile。未来如果 aider、opencode、openhands 能输出兼容 internal profile，可以通过同一接口接入。

LightCC internal profile 用于解释：

- provider / tool / context / transcript 的内部瓶颈分布；
- bash 调用、非零退出、timeout；
- read/grep/glob/edit/write/todo/git_feedback 等工具调用分布；
- context 最大估算 token；
- transcript write 开销；
- compact / approval / MCP 触发情况；
- resolved 和 unresolved 的内部差异。

## 公平性原则

公共结论只能使用四个 coder 都能产出的数据：

- official outcome；
- `wrapper.profile.json`；
- `provider.profile.json`；
- bounded artifact metadata；
- patch 是否存在、大小、行数、hash、changed files；
- wrapper exit/duration。

LightCC internal profile 只能用于 LightCC 自身诊断，不直接参与四个 coder 的内部耗时横比。报告中要明确区分：

- Public Cross-Coder Profiling；
- LightCC Internal Diagnosis。

## 建议目录结构

```text
evals/report/profile-analysis/
  ARCHITECTURE_PLAN.zh-CN.md
  README.zh-CN.md
  types.ts
  load.ts
  normalize.ts
  aggregate.ts
  correlate.ts
  renderMarkdown.ts
  run.ts
  schema/
    eval-profile-analysis.schema.json
```

职责：

- `types.ts`：稳定输出类型。
- `load.ts`：发现并读取 eval artifacts。
- `normalize.ts`：把不同 benchmark/coder/run 结构归一成 row。
- `aggregate.ts`：聚合统计、分位数、占比、outlier。
- `correlate.ts`：outcome 与 profile 指标的关系分析。
- `renderMarkdown.ts`：人读报告。
- `run.ts`：CLI 入口。
- `schema/`：稳定 JSON schema。

## CLI 入口设计

支持三种输入：

```sh
# 从完整 eval run 目录自动发现 artifacts
bun evals/report/profile-analysis/run.ts \
  --run-root .light-cc/evals/swe20-fourway-20260602 \
  --out .light-cc/evals/swe20-fourway-20260602/profile-analysis

# 从 benchmark summary 读取已记录的 profile paths
bun evals/report/profile-analysis/run.ts \
  --summary .light-cc/evals/<run-id>/terminal-bench/summary.json \
  --out /tmp/profile-analysis

# 显式传入 profile report 列表，适合临时调试
bun evals/report/profile-analysis/run.ts \
  --profiles path/a/profile.report.json,path/b/profile.report.json \
  --out /tmp/profile-analysis
```

后续可增加：

```sh
--benchmark swebench|terminal-bench|all
--coder lightcc,aider,openhands,opencode
--format markdown,json
--language zh-CN|en
--strict
```

## Artifact 发现规则

从 `--run-root` 递归发现：

```text
**/provider.profile.json
**/wrapper.profile.json
**/agent/profile.report.json
**/summary.json
**/predictions.jsonl
**/selected_instances.jsonl
**/selected_tasks.jsonl
**/patch.diff
**/metrics.json
```

路径关联优先级：

1. 优先使用 eval summary 中已经写入的 `profileReports`、`wrapperProfilePaths`、`providerProfilePaths`。
2. 对 SWE-bench matrix job，按 job/report/instance 目录关联。
3. 对 Terminal-Bench job，按 task/job artifact 目录关联。
4. 如果无法确定 item/coder，只保留在 coverage warnings 中，不进入主要 row。

## 核心 Row 模型

一个 row 表示：

```text
一个 benchmark item × 一个 coder
```

建议类型：

```ts
type EvalProfileRow = {
  schemaVersion: 1
  benchmark: "swebench" | "terminal-bench"
  runId: string
  itemId: string
  coderId: string
  coderDisplayName: string | null

  outcome: OutcomeSummary
  commonProfile: CommonProfileSummary
  internalProfile: InternalProfileSummary | null
  paths: ArtifactPathSummary
  warnings: string[]
}
```

### OutcomeSummary

```ts
type OutcomeSummary = {
  officialOutcome: "resolved" | "unresolved" | "empty_patch" | "error" | "incomplete" | null
  tbenchReward: number | null
  completed: boolean | null
  submitted: boolean | null
  status: string | null
  patchBytes: number | null
  patchLines: number | null
  patchSha256: string | null
  changedFiles: string[]
  emptyPatch: boolean | null
}
```

### CommonProfileSummary

```ts
type CommonProfileSummary = {
  wrapper: WrapperProfileSummary
  provider: ProviderProfileSummary
  artifacts: ArtifactSummary
}
```

### WrapperProfileSummary

公共 wrapper 字段：

```ts
type WrapperProfileSummary = {
  exists: boolean
  valid: boolean
  schemaVersion: number | null
  wrapperId: string | null
  runtime: string | null
  executablePath: string | null
  cwd: string | null
  argCount: number | null
  argsSha256: string | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  warningCount: number
  artifactCount: number
  hasPrompt: boolean
  hasTranscript: boolean
  hasPatch: boolean
  hasSummary: boolean
  hasStdout: boolean
  hasStderr: boolean
  missingEnvNames: string[]
}
```

### ProviderProfileSummary

公共 provider 字段：

```ts
type ProviderProfileSummary = {
  exists: boolean
  valid: boolean
  model: string | null
  requestCount: number | null
  successCount: number | null
  errorCount: number | null
  retryableErrorCount: number | null
  totalLatencyMs: number | null
  averageLatencyMs: number | null
  averageFirstTokenMs: number | null
  latencyMsP50: number | null
  latencyMsP90: number | null
  firstTokenMsP50: number | null
  firstTokenMsP90: number | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
  reasoningTokens: number | null
  estimatedUsd: number | null
  costSource: string | null
}
```

派生公共指标：

```ts
type CommonDerivedMetrics = {
  cacheHitRatio: number | null
  outputTokenRatio: number | null
  averageInputTokensPerRequest: number | null
  averageOutputTokensPerRequest: number | null
  wrapperVsProviderOverheadMs: number | null
  wrapperVsProviderOverheadRatio: number | null
  providerErrorRate: number | null
}
```

### InternalProfileSummary

第一版只支持 LightCC internal profile：

```ts
type InternalProfileSummary = {
  kind: "lightcc-profile-report"
  exists: boolean
  valid: boolean
  observedDurationMs: number | null
  profileSpanCount: number | null
  topBottleneck: string | null
  categoryTotals: Array<{
    category: string
    totalDurationMs: number
    spanCount: number
    shareOfObserved: number | null
  }>
  provider: LightccInternalProviderSummary
  context: LightccInternalContextSummary
  tools: LightccInternalToolSummary[]
  runtime: LightccInternalRuntimeSummary
  approval: LightccInternalApprovalSummary
  mcp: LightccInternalMcpSummary
  compact: LightccInternalCompactSummary
  transcriptWrite: LightccInternalTranscriptWriteSummary
  topSlowSpans: LightccSlowSpanSummary[]
  warnings: string[]
}
```

内部 profile 字段来自顶层 `profiling/report/types.ts` 的 `ProfileReport`，不要重新定义底层契约，只在 row 中做摘要和派生指标。

## 输出产物

```text
profile-analysis/
  eval-profile.rows.jsonl
  eval-profile.summary.json
  eval-profile.coder-summary.json
  eval-profile.item-matrix.json
  eval-profile.outliers.json
  eval-profile-analysis.zh-CN.md
```

### eval-profile.rows.jsonl

权威事实表。一行一个 `EvalProfileRow`。后续分析、报告、dashboard 都基于它。

### eval-profile.summary.json

整体聚合：

- coverage；
- benchmark totals；
- public cross-coder profile totals；
- internal profile totals；
- outlier counts；
- warning counts。

### eval-profile.coder-summary.json

按 coder 聚合：

- resolved/pass 数；
- requestCount；
- totalTokens；
- input/output/reasoning/cache tokens；
- estimatedUsd；
- wrapperDurationMs；
- providerLatencyMs；
- providerErrors；
- cacheHitRatio；
- tokensPerResolved；
- requestsPerResolved；
- costPerResolved；
- wrapperNonzeroExitCount；
- artifact coverage。

### eval-profile.item-matrix.json

按 item 聚合：

- 每题四个 coder 的 outcome；
- solvedCoders；
- cheapestResolvedCoder；
- fastestResolvedCoder；
- mostExpensiveFailure；
- lightccVsBestCompetitor gap；
- per-item notes。

### eval-profile.outliers.json

异常任务列表：

- high token；
- high request；
- high provider latency；
- high wrapper duration；
- provider error；
- wrapper nonzero exit；
- empty patch；
- high transcript write overhead；
- high tool error；
- high bash nonzero/timeout；
- context token outlier。

### eval-profile-analysis.zh-CN.md

人读报告，中文优先。

## 聚合分析维度

### Coverage

必须展示：

- item 总数；
- row 总数；
- wrapper profile 覆盖率；
- provider profile 覆盖率；
- internal profile 覆盖率；
- invalid profile 数；
- missing profile 明细；
- warning 总数。

### Public Cross-Coder Profiling

公共横比必须覆盖：

- official outcome；
- wrapper duration；
- wrapper exitCode；
- provider requestCount；
- provider latency；
- provider firstToken；
- input/output/total/reasoning tokens；
- cache read/write；
- cost；
- provider error/retry；
- artifact 完整性。

### Outcome Split

按 outcome 比较：

- resolved/pass vs unresolved/fail；
- 成功任务和失败任务的 request/token/cost/latency 差异；
- 失败任务消耗的总成本；
- 高成本失败任务列表。

### Per-Task Matrix

每题比较：

- 哪些 coder 解决；
- 未解决 coder 花了多少 request/token/cost；
- 最便宜的 resolved coder；
- 最快的 resolved coder；
- LightCC 与最佳 competitor 的 gap。

### LightCC Internal Diagnosis

只对 LightCC 有值：

- topBottleneck 分布；
- internal category total；
- provider vs tool vs transcript 占比；
- tool 调用分布；
- tool error / timeout；
- bash nonzero / timeout；
- maxEstimatedTokens；
- transcript write duration/bytes/self-overhead；
- resolved vs unresolved 的 internal 差异。

## Markdown 报告结构

```text
# Eval Profile Analysis

## 1. Coverage
profile 覆盖率和缺失情况。

## 2. Official Outcomes
官方结果总览。

## 3. Public Cross-Coder Profiling
四个 coder 的公共成本、速度、稳定性横比。

## 4. Per-Task Matrix
逐题比较和 winner/gap。

## 5. Failure Cost Analysis
失败任务消耗、昂贵失败、低成本失败。

## 6. Provider Behavior
请求数、latency、TTFT、token、cache、error/retry。

## 7. Wrapper Behavior
外层进程耗时、exit、artifact 完整性。

## 8. LightCC Internal Diagnosis
LightCC 内部瓶颈和失败根因信号。

## 9. Outliers
异常任务列表和证据。

## 10. Action Items
基于数据的后续优化项。
```

## Outlier 规则草案

第一版使用简单、可解释规则：

- `high_total_tokens`：高于 p95，或超过 run median 的 2 倍。
- `high_request_count`：高于 p95，或超过 run median 的 2 倍。
- `high_provider_latency`：provider total latency 高于 p95。
- `high_wrapper_duration`：wrapper duration 高于 p95。
- `high_cost_failure`：outcome 未通过且 cost/token/request 高于 p75。
- `provider_error`：provider errorCount > 0。
- `wrapper_nonzero_exit`：wrapper exitCode 非 0 或 signal 不为空。
- `empty_patch`：official empty patch 或 patchBytes 为 0。
- `lightcc_tool_error_outlier`：LightCC tool errorCount 高于 p90。
- `lightcc_bash_timeout`：LightCC runtime timeoutCount > 0。
- `lightcc_context_outlier`：maxEstimatedTokens 高于 p95。
- `lightcc_transcript_overhead`：transcriptWriteDuration / observedDuration 高于 p90 或超过固定阈值。

所有 outlier 必须包含：

```ts
type OutlierRecord = {
  kind: string
  severity: "info" | "warn" | "critical"
  benchmark: string
  itemId: string
  coderId: string
  value: number | string | null
  threshold: number | string | null
  evidence: string[]
  paths: ArtifactPathSummary
}
```

## 和现有代码的关系

当前可复用逻辑：

- `evals/report/swebench-analysis.ts`
  - 已有 provider/wrapper/internal 读取和失败归因逻辑；
  - 可抽出 reader 与 summary helper。
- `evals/report/run.ts`
  - 已有 unified report coverage 和 profile path 收集逻辑；
  - 可复用 profile coverage 计算。
- `evals/wrapper-profile/`
  - wrapper profile schema 与 validator。
- `evals/provider-proxy/run.ts`
  - provider.profile.json 生产逻辑和字段语义。
- `profiling/report/types.ts`
  - LightCC internal `ProfileReport` 稳定类型。

第一版建议独立实现 CLI，不直接改现有 final report。稳定后再让：

```text
evals/report/run.ts
evals/report/final-run.ts
evals/report/swebench-analysis.ts
```

选择性调用 `profile-analysis`。

## 实施阶段

### Phase 1: 架构和 schema

- 定义 `EvalProfileRow`、`EvalProfileSummary`、`CoderProfileSummary`、`ItemProfileMatrix`、`OutlierRecord`。
- 写 `eval-profile-analysis.schema.json`。
- 写 `README.zh-CN.md`，说明 CLI 与输出。

验收：

- 类型能覆盖 SWE-bench 和 Terminal-Bench；
- 公共字段和 internal 字段边界清晰；
- schema 不包含 raw payload 字段。

### Phase 2: Loader

- 实现 `--run-root`、`--summary`、`--profiles`。
- 自动发现 wrapper/provider/internal profiles。
- 关联 benchmark、itemId、coderId、runId。
- 输出 coverage warnings。

验收：

- 能读 `.light-cc/evals/swe20-fourway-20260602`；
- 能读 Terminal-Bench 20 相关目录；
- 缺失/无法关联 profile 不崩溃。

### Phase 3: Normalizer

- 归一 `wrapper.profile.json`。
- 归一 `provider.profile.json`。
- 归一 LightCC `agent/profile.report.json`。
- 关联 outcome、patch metadata、artifact metadata。

验收：

- 生成 `eval-profile.rows.jsonl`；
- 每个 row 字段稳定；
- 四个 coder 公共字段可横比；
- LightCC internal 只在对应 row 出现。

### Phase 4: Aggregator

- 生成 coder summary。
- 生成 item matrix。
- 生成 coverage summary。
- 计算分位数、占比、派生指标。
- 计算 outliers。

验收：

- 能复现现有 README/final report 的基础数值；
- 能额外给出公共 provider/wrapper 深度指标；
- 能列出 LightCC internal bottleneck。

### Phase 5: Renderer

- 输出中文 Markdown。
- 表格分清公共横比和 LightCC 内部诊断。
- 输出 action items，但必须附 evidence。

验收：

- 人读报告能解释 20-task run；
- 不泄露 raw prompt/stdout/stderr/patch/tool output。

### Phase 6: 集成

- 将 `profile-analysis` 加入 package scripts，建议：

```json
{
  "eval:profile-analysis": "bun evals/report/profile-analysis/run.ts"
}
```

- 可选接入 `evals/report/run.ts` 或 `final-run.ts`。

验收：

- 一条命令能从 run root 生成所有 profile analysis artifacts；
- 现有 report 命令不被破坏。

## 测试计划

单元测试：

- provider profile parser；
- wrapper profile parser；
- internal profile parser；
- path association；
- aggregate stats；
- outlier rules；
- markdown renderer smoke。

fixture：

- 最小 SWE-bench row；
- 最小 Terminal-Bench row；
- LightCC row with internal profile；
- non-LightCC row without internal profile；
- missing provider profile；
- invalid wrapper profile；
- high token outlier；
- provider error outlier；
- wrapper nonzero exit；
- LightCC bash timeout。

回归数据：

- `.light-cc/evals/swe20-fourway-20260602`
- `.light-cc/evals/tbench20-lightcc-bounded40-20260603`
- `.light-cc/evals/tbench20-lightcc-bounded40-remainder-20260603`

测试命令建议：

```sh
bun test test/evals/profile-analysis.test.ts
bun run typecheck
```

## 隐私和安全边界

分析系统只能读取和输出：

- bounded metadata；
- 路径；
- 字节数；
- hash；
- 环境变量名；
- 耗时；
- 状态；
- token 数；
- request 计数；
- cost metadata；
- artifact kind。

禁止读取、复制或输出：

- prompt 正文；
- assistant/model response 正文；
- stdout/stderr 正文；
- patch/diff 正文；
- tool result 正文；
- raw provider request/response body；
- API key 或环境变量值；
- MCP 参数和结果正文。

如果需要引用具体 artifact，只输出路径和 hash，不输出内容。

## 后续交接要点

后续 session 开始实现时，优先顺序如下：

1. 先实现类型和 schema，不写复杂报告。
2. 先跑通 `--run-root .light-cc/evals/swe20-fourway-20260602` 生成 rows。
3. 再做 coder summary 和 item matrix。
4. 再接 Terminal-Bench。
5. 最后写 Markdown renderer 和 outlier/action items。

不要一开始重构 `swebench-analysis.ts`。第一版先独立落地，等输出稳定后再抽公共 helper 或接入 final report。

