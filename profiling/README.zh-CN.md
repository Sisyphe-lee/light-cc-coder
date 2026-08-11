# light-cc-coder Profiling 中文说明

[English](README.md)

`profiling/` 是 `light-cc-coder` 的本地性能和成本观测工具集。它回答的问题是：一次 session 的时间、token 和开销花在了哪里，例如启动、context 组装、provider streaming、工具执行、approval 等待、MCP、compaction、transcript 写入和 runtime shell。

它不是 benchmark、evaluation、leaderboard、telemetry，也不判断任务是否完成或模型能力强弱。任务质量评测属于 `evals/`，profiling 只记录受限的耗时和计数。

## 功能总览

当前 profiling 包含这些能力：

- 运行时埋点：在显式开启 profiling 时，session transcript 会追加 replay-invisible 的 `profile.span` events。
- 单次离线汇总：`lightcc profile <transcript.jsonl>` 把一个 transcript 汇总成人读文本或稳定 JSON report。
- 稳定报告 schema：`profiling/schema/profile-report.schema.json` 定义 `ProfileReport` 的版本化 JSON 结构。
- 轻量 schema 校验：`validateAgainstSchema` 可以校验报告是否符合发布的 schema，不引入完整 JSON Schema 引擎。
- 程序化 API：`summarizeProfile`、`renderText`、`renderJson` 可被测试或开发脚本直接调用。
- 报告比较器：`compareReports` 用两个单次 `ProfileReport` 比较明显的 harness 回归。
- live N-run runner：`profiling/liveRuns/runner.ts` 可用真实 provider 或 FakeProvider 连跑 N 次，并聚合成 `live-runs.summary.json`。

## 边界

- `src/` 只负责很薄的运行时 instrumentation：`profile.span` 事件、可 no-op 的 `Profiler` 接口，以及粗粒度生命周期 span。
- `profiling/` 负责 schema、reducer、renderers、报告比较和 live run 聚合。
- 普通非 profiling 运行不依赖 `profiling/`。`lightcc profile` 通过 dynamic import 加载这里的 reducer。
- reducer 只消费稳定 JSONL event contract，不导入 `src/` 私有类型，不调用 provider，不运行工具，也不修改输入 transcript。

## 如何启用 profiling

profiling 是 opt-in。记录 session 时可以用 `--profile` 或环境变量开启：

```sh
lightcc -p "总结这个仓库。" --profile

LIGHTCC_PROFILE=1 lightcc -p "总结这个仓库。"
```

建议显式指定 transcript，方便之后离线汇总：

```sh
lightcc -p "搜索这个仓库里的 TODO。" \
  --profile \
  --transcript /tmp/lightcc-profile.jsonl \
  --cwd "$PWD"
```

交互 REPL 也可以记录：

```sh
lightcc \
  --profile \
  --transcript /tmp/lightcc-repl-profile.jsonl \
  --cwd "$PWD"
```

退出 REPL 后，transcript 中会包含普通 session events 和 replay-invisible 的 profiling spans。

## 单次离线汇总

离线汇总不会请求 provider、不会运行工具、不会修改 transcript。只有指定 `--out` 时才会写出 report 文件。

```sh
# 人读摘要
lightcc profile /tmp/lightcc-profile.jsonl

# 稳定 JSON report
lightcc profile /tmp/lightcc-profile.jsonl --json

# 写到文件
lightcc profile /tmp/lightcc-profile.jsonl \
  --json \
  --out /tmp/lightcc-profile.report.json
```

程序化使用：

```ts
import { summarizeProfile, renderText, renderJson } from "../profiling"

const events = transcript
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const report = summarizeProfile(events, {
  sourceTranscript: transcriptPath,
  generatedAt: new Date().toISOString(),
})

console.log(renderText(report))
console.log(renderJson(report))
```

## 输入数据

核心输入是 JSONL transcript 中的 `profile.span` event。span 使用 monotonic clock 的 `startMs` 和 `durationMs`，不要用 wall-clock timestamp 计算耗时。

```json
{
  "type": "profile.span",
  "spanId": "span_12",
  "parentSpanId": "span_3",
  "name": "provider.step",
  "category": "provider",
  "status": "ok",
  "startMs": 1234.5,
  "durationMs": 87.2,
  "attributes": {
    "firstTokenMs": 40,
    "inputTokens": 1200
  }
}
```

已使用的 span category 包括：

- `session`
- `turn`
- `step`
- `startup`
- `context`
- `provider`
- `tool`
- `permission`
- `approval`
- `runtime`
- `mcp`
- `hook`
- `compact`
- `transcript`

reducer 还会读取 transcript 中已有的诊断事件补充报告，包括：

- `context.step`
- `bash.observation`
- `permission.decision`
- `approval.requested` / `approval.responded`
- `provider.retry` / `provider.failure`
- `compact.started` / `compact.ended`
- `mcp.server.*`
- `tool.call`

无法识别的事件会被忽略。格式不完整的 span 会进入 warnings。

## 单次 ProfileReport 内容

`ProfileReport` 的稳定 schema 版本是 `schemaVersion: 1`。主要字段如下：

- `sourceTranscript` / `generatedAt`：报告来源和生成时间。
- `session`：session id、cwd、turn 数和 step 数。
- `summary`：观测总耗时、profile span 数量、最高耗时类别。
- `categoryTotals`：按 category 汇总的 inclusive duration 和 span 数。
- `topSlowSpans`：最慢 span 列表。
- `provider`：provider call 数、总耗时、TTFT p50/max、stream p50/max、retry 数、失败分类、input/output token、cache read/write token。
- `context`：context assembly 次数、总耗时、最大估算 token。
- `tools`：每个工具的调用次数、p50/max 耗时、error/denied/timeout 计数。
- `approval`：approval 请求数、allow/deny 数、等待总耗时和最大等待耗时。
- `runtime`：bash 次数、p50/max 耗时、非零退出、timeout、截断计数。
- `mcp`：MCP server 启动、ready、failed 和 tool call 数。
- `compact`：compaction 次数、失败数、耗时、compact 前后估算 token。
- `transcriptWrite`：transcript write 次数、总耗时、最大耗时、写入字节数、profiling span 写入自身开销。
- `warnings`：缺失 profiling 数据、malformed span、dangling parent span 等警告。

报告只包含耗时和受限计数，不包含 prompt、assistant 文本、工具输出、文件内容或凭据。

## 报告比较器 compareReports

`compareReports` 是 developer-only helper，不是产品 CLI，也不是 benchmark。它比较两个单次 `ProfileReport`，用于发现明显的 harness 回归。

```ts
import { compareReports, renderComparison } from "../profiling"

const comparison = compareReports({ baseline, current })
console.log(renderComparison(comparison))

if (comparison.status === "fail") {
  process.exitCode = 1
}
```

比较结果是 JSON-serializable：

```ts
{
  schemaVersion: 1,
  status: "pass" | "warn" | "fail",
  checks: [
    {
      metric: "provider.totalDurationMs",
      severity: "warn",
      baseline: 100,
      current: 180,
      ratio: 1.8,
      deltaMs: 80,
      threshold: "..."
    }
  ],
  summary: {
    failed: 0,
    warned: 1,
    passed: 10,
    topRegressions: []
  }
}
```

它做两类检查：

- 严格不变量：session turn/step 数、provider call 数、context assembly 数、tool 调用数、bash 数、compact 数、MCP tool call 数、FakeProvider 脚本化 token 计数等。变化会 `fail`。
- 粗粒度性能检查：对总耗时、category 耗时、provider/context/tool/runtime/compact/transcript write 等字段做 ratio 加 absolute delta 判断。默认忽略太小的耗时，避免 fsync、shell startup、MCP startup 和 profiler overhead 的噪声造成毫秒级误判。

默认阈值：

- 普通 duration：`minComparableMs 25`，`warnRatio 1.5`，`failRatio 2.0`，`minWarnDeltaMs 50`，`minFailDeltaMs 100`。
- runtime 和 transcript write 更吵，默认 `failRatio 3.0`。
- context token 增长只 warn，不 fail，默认 `warnRatio 1.25` 且至少增长 500 token。
- `topSlowSpans` 只做诊断展示，不参与 gate。

确定性 Stage 1 场景在 `test/profiling/scenarios.ts`：

- `startup_noop`
- `readonly_search_batch`
- `edit_verify`
- `auto_compact`

这些场景使用 FakeProvider 和 counter clock，目标是固定 harness path 的报告形状；它们仍然不是 benchmark。

## live N-run profiling

`profiling/liveRuns/` 是可选 Stage 2 developer dogfood 工具。它用真实 CLI 跑一个 prompt/scenario N 次，每次都开启 profiling 并生成单次 `ProfileReport`，最后聚合成独立版本的 `live-runs.summary.json`。

真实 provider 示例：

```sh
bun profiling/liveRuns/runner.ts --scenario pong --runs 7 --warmup 1 \
  --model "$OPENAI_MODEL" \
  --base-url "$OPENAI_BASE_URL" \
  --api-key-env OPENAI_API_KEY \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs
```

FakeProvider smoke，不打真实 provider：

```sh
bun profiling/liveRuns/runner.ts --scenario pong --fake --runs 2 --warmup 1 \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs-fake \
  --os-sandbox off
```

也可以从文件读取 prompt：

```sh
bun profiling/liveRuns/runner.ts --prompt-file /tmp/prompt.txt --runs 5 \
  --cwd "$PWD" \
  --out-dir /tmp/lightcc-live-runs
```

内置 live scenarios：

- `pong`：一轮无工具 latency probe，主要看 startup、context、provider TTFT/stream。
- `repo_overview`：只读列顶层文件并总结，覆盖 read-only tool batch 和 provider streaming。
- `search_term`：搜索 `profiling`，覆盖 grep/glob/read 组合和 provider latency。

常用参数：

- `--runs <N>`：纳入统计的正式运行次数，默认 5。
- `--warmup <n>`：warmup 次数，会保留在磁盘但排除统计，默认 0。
- `--cwd <path>`：workspace root。
- `--model` / `--base-url` / `--api-key-env`：OpenAI-compatible provider 配置。
- `--permission-mode <mode>`：`read-only`、`workspace-write` 或 `danger-full-access`。
- `--os-sandbox <mode>`：`off`、`auto` 或 `required`。
- `--max-steps <n>`：每次 run 的 agent step 上限。
- `--bin-command <cmd>`：覆盖 CLI 启动命令，默认用当前 Bun 运行源码入口。
- `--timeout-ms <n>`：每次 run 超时，默认 600000。
- `--json`：输出 aggregate JSON，不输出人读摘要。
- `--fake`：使用 FakeProvider 做 smoke test。

每次 run 会写：

- `<label>.transcript.jsonl`
- `<label>.report.json`

最终会写：

- `live-runs.summary.json`

聚合 summary 包括：

- included、warmup、skipped、failed、missing profile data、malformed report 计数；
- 总 wall-clock；
- 每次 run 的状态、是否纳入统计、transcript/report 路径和高层错误；
- observed duration 的 median/min/max/IQR；
- category totals 的 median/min/max/IQR；
- provider TTFT、stream、total duration、retry、token、cache 统计；
- context 最大估算 token 和总耗时；
- per-tool 调用数、出现 run 数、p50/max 耗时分布、error/denied/timeout；
- runtime/bash 统计；
- compact 统计；
- transcript write 总耗时和字节数；
- top bottleneck frequency；
- warnings 和 failures。

live runner 默认串行运行，避免 provider rate limit、prompt cache 行为和网络波动被并发扭曲。它不作为 CI gate；真实 provider/network 有噪声，N-run median 只能帮助定位瓶颈，不能证明模型或系统质量。

## 隐私和数据红线

profiling 数据会落盘，也可能被本地工具读取，所以必须严格限制内容。运行时 instrumentation 和 reducer 不应记录：

- prompt 文本、system instructions、assistant 文本；
- 可能包含用户数据的 tool arguments；
- tool result 内容；
- shell stdout/stderr；
- 文件内容、raw diff；
- API key、环境变量值、凭据；
- 原始 provider request/response body；
- MCP arguments 或 MCP result 内容。

允许记录的是 id、名称、状态、布尔值、计数、hash、受限字符串和受限耗时。`src/profiling/profiler.ts` 对 span attributes 有 cap：每个 span 最多 24 个 attributes，key 最多 64 字节，字符串值最多 256 字节。

## 对其他 harness 的兼容目标

`profiling/` 的 reducer 有意和 light-cc-coder runtime 解耦。其他 harness 如果想复用 reducer，应在 JSONL transcript 中输出兼容的 `profile.span`：

- 使用 monotonic clock；
- 只输出 completed span，不输出单独 started/ended pair；
- attributes 保持有界，并避开上面的隐私红线；
- 尽量使用已有 category 和属性名，例如 `provider.step` 的 `firstTokenMs`、`inputTokens`、`cacheReadInputTokens`，以及 `tool.execute` 的 `toolName`。

未识别的 span 仍会进入 category totals 和 top slow spans，因此部分接入也能退化为可用的高层耗时报告。
