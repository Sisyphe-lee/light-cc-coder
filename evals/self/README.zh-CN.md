# E2 Self-Eval 中文说明

这份文档解释当前 `evals/self/` 的自我评测在测什么、如何理解 PASS/FAIL，以及它和后续 SWE-bench / Terminal-Bench 的关系。

## 目标

Self-eval 不是为了证明 coder 在真实任务上有多强，而是为了快速确认 light-cc-coder 的 harness 是否健康。

它重点覆盖这些底层不变量：

- tool/result pairing 是否始终正确。
- 文件读写和精确编辑是否可靠。
- shell 成功、失败、观察事件是否能回灌。
- 权限拒绝是否作为 tool result 返回模型。
- workspace 边界是否不会被工具绕过。
- transcript 是否可 replay。
- context compaction 是否不会破坏继续执行和 replay。

这些能力如果不稳，后续跑 SWE-bench Lite 或 Terminal-Bench 时，即使失败也很难判断是模型不行、任务太难，还是 harness 自己坏了。

## 运行方式

常用命令：

```bash
bun run eval:self
bun run eval:self -- --list
bun run eval:self -- --fixture tiny-ts-bugfix
bun run eval:self -- --run-id self-smoke
```

当前 self-eval 只使用 deterministic `FakeProvider`，也就是模型行为由 fixture 固定，不依赖真实模型输出。因此它适合作为快速回归测试。

## 当前 Fixtures

| Fixture | 主要评测能力 | PASS 意味着什么 | FAIL 通常说明什么 |
|---|---|---|---|
| `file-crud` | 文件创建、读取、工具结果回灌 | `write` 和 `read` 工具能在 workspace 内稳定执行，并产生成对 tool result | 文件工具、workspace 初始化、tool runtime 或 transcript 记录有问题 |
| `exact-edit` | 精确文本替换 | `edit` 能按 `oldText/newText` 修改目标文件，且不影响 replay | 编辑工具匹配、写入、结果归一化或文件校验出错 |
| `shell-error-feedback` | shell 失败可观察与失败后继续执行 | 失败命令会生成 bash observation 和 error tool result，后续步骤还能继续 | bash runtime、错误回灌、loop continuation 或 tool error 计数有问题 |
| `permission-denied` | 权限拒绝回灌 | read-only 模式下写文件会被拒绝，并以 paired tool result 返回 | 权限策略绕过、拒绝没有进入 transcript，或 tool/result pairing 被破坏 |
| `workspace-boundary` | workspace 写边界 | `../` 逃逸写入会失败，workspace 外文件不会被创建 | path boundary、WorkspaceFs 或 permission/sandbox 层有漏洞 |
| `tool-result-pairing` | 同一步多工具调用的顺序配对 | 多个 tool call 会按顺序产生对应 tool result，ID 和 tool name 匹配 | run loop、ToolRuntime 批处理、transcript 顺序或 replay pairing 有问题 |
| `transcript-replay` | JSONL transcript replay | 运行后的 transcript 能重建 provider messages | transcript schema、assistant/tool event 顺序或 replay 逻辑退化 |
| `context-compaction` | 自动 context compact 后继续执行 | 上下文变大后会触发 compact，compact 成功后仍能继续调用工具并完成任务 | compact 触发阈值、summary 注入、pairing-safe tail 或 compact 后继续执行有问题 |
| `tiny-ts-bugfix` | 极小 TypeScript 修复流 | agent 能读文件、精确编辑、用 shell 验证修复结果 | 读改验链路、shell 验证或多 step loop 有问题 |
| `tiny-python-bugfix` | 极小 Python 修复流 | agent 能完成同样的读改验流程，但目标是 Python 文件 | 多语言文件路径、编辑工具或验证命令处理有问题 |

## 覆盖的 Coder 功能

E2 的 10 个测试不是随机小任务，而是按 coder harness 的核心功能拆出来的。

| Coder 功能 | 对应 fixtures | 覆盖点 |
|---|---|---|
| 文件读取 | `file-crud`、`transcript-replay`、`tiny-ts-bugfix`、`tiny-python-bugfix`、`context-compaction` | `read` 工具能读取 workspace 内文本文件，结果能进入下一轮模型上下文和 transcript。 |
| 文件创建 | `file-crud`、`tool-result-pairing`、`shell-error-feedback`、`context-compaction` | `write` 工具能创建文件，产出 diff 风格结果，并被后续验证读取。 |
| 精确编辑 | `exact-edit`、`tiny-ts-bugfix`、`tiny-python-bugfix` | `edit` 工具只替换唯一匹配文本，避免误改、多改或静默失败。 |
| Shell 执行 | `shell-error-feedback`、`tiny-ts-bugfix`、`tiny-python-bugfix` | `bash` 工具能执行验证命令，并记录 `bash.observation`。 |
| Shell 失败反馈 | `shell-error-feedback` | 非零退出会变成 error tool result，而不是让 loop 断掉或丢失错误信息。 |
| 权限系统 | `permission-denied` | `read-only` 下写操作会被拒绝，并以 tool result 回灌给模型。 |
| Workspace 边界 | `workspace-boundary` | `../` 路径逃逸不能写出 workspace，防止评测任务污染外部文件。 |
| Tool/result pairing | `tool-result-pairing`、全部 fixtures | 一个 assistant step 里的多个 tool call 必须按顺序、id、toolName 生成对应 tool result。 |
| Session transcript | `transcript-replay`、全部 fixtures | JSONL transcript 能重建 provider messages，后续 resume/replay 才可信。 |
| Context compaction | `context-compaction` | 上下文触发 compact 后，summary 注入、pairing-safe tail 和后续工具调用仍然能继续。 |
| 多步 agent loop | `file-crud`、`shell-error-feedback`、`tiny-ts-bugfix`、`tiny-python-bugfix`、`context-compaction` | 工具结果回到模型后，下一步 provider request 能继续推进任务。 |
| 小型真实修复链路 | `tiny-ts-bugfix`、`tiny-python-bugfix` | 模拟真实 coder 的“读代码 -> 改代码 -> 运行命令验证”闭环。 |

## PASS / FAIL 怎么读

`PASS` 表示该 fixture 的所有期望都满足，包括文件状态、事件计数、tool/result pairing、replay 等。

`FAIL` 表示至少一个期望不满足。runner 会在终端输出简短失败原因，并在 fixture 的 `metrics.json` 中保存更完整的运行指标。

需要注意：

- PASS 不代表真实模型一定会完成同类任务，因为当前使用的是固定 FakeProvider。
- FAIL 通常优先看作 harness 回归，而不是模型能力问题。
- 如果某个 fixture FAIL，先看对应 `metrics.json` 和 `transcript.jsonl`，确认失败发生在工具执行、权限判断、loop 继续、compact 还是 replay。

## 本次测试结果

最近一次 E2 验证结果是：

```bash
bun run eval:self
# 10 pass, 0 fail

bun run eval:self -- --fixture context-compaction --run-id self-smoke-context-final
# PASS context-compaction

bun run eval:self -- --list
# 正常列出 10 个 fixtures

bun run typecheck
# passed
```

这说明当前 E2 覆盖到的 harness 功能都处于健康状态：

- 文件读写、精确编辑和 shell 验证链路可用。
- 权限拒绝和 workspace 边界没有被绕过。
- 工具调用和工具结果严格配对。
- transcript 可以 replay。
- context compaction 后仍能继续执行任务。
- TypeScript 和 Python 的最小 bugfix 流程都能跑通。

但这个结果不代表真实模型已经能解决 SWE-bench 或 Terminal-Bench。E2 使用的是 deterministic `FakeProvider`，模型行为是 fixture 固定的；它验证的是 harness 能力，不是模型智能。

## 产物目录

默认输出位置：

```text
.light-cc/evals/<run_id>/self/
  summary.json
  <fixture>/
    prompt.md
    transcript.jsonl
    metrics.json
```

`summary.json` 是整次 self-eval 的总览：

- `passed` / `failed`：通过和失败数量。
- `results`：每个 fixture 的状态、耗时、workspace、artifact 路径和指标。
- `reportDir`：本次运行产物目录。

每个 fixture 的 `metrics.json` 包含：

- `events.total` 和 `events.byType`：事件总数和类型分布。
- `toolCalls` / `toolResults` / `toolErrors`：工具调用、结果和错误数量。
- `permissionDenials`：权限拒绝次数。
- `bashObservations`：shell 观察事件数量。
- `compactStarted` / `compactSucceeded` / `compactFailed`：context compact 事件。
- `replayValid`：transcript 是否能 replay。
- `toolResultsMatchToolCalls`：tool result 是否和 tool call 严格配对。

`transcript.jsonl` 是最重要的调试材料。它按事件顺序记录一次运行发生了什么，包括 user message、assistant message、tool call、permission decision、tool result、bash observation、compact event 和 turn end。

## 和 SWE-bench / Terminal-Bench 的关系

Self-eval 是内部体检，不是外部公信力 benchmark。

三层关系如下：

1. **Self-eval**：测 harness 自己是否健康。便宜、快速、确定性强，适合每次改 loop、tool、permission、context、transcript 时跑。
2. **SWE-bench Lite**：测真实 repo issue 修复能力。它告诉我们 coder 能不能在真实代码库里产出有效 patch。
3. **Terminal-Bench 2.1**：测 terminal autonomy、命令执行、环境操作和长任务能力。它更关注 shell 和任务环境操作。

推荐使用顺序：

```text
先跑 self-eval，确认 harness 没坏
再跑 SWE-bench Lite 单题/小批量
最后跑 Terminal-Bench 2.1 单题/小批量
```

如果 self-eval 没过，不建议直接跑 SWE-bench 或 Terminal-Bench。否则 benchmark 失败时，排查成本会很高。

## 当前状态

截至 E2 当前实现，self-eval 已包含 10 个 fixtures：

- `context-compaction`
- `exact-edit`
- `file-crud`
- `permission-denied`
- `shell-error-feedback`
- `tiny-python-bugfix`
- `tiny-ts-bugfix`
- `tool-result-pairing`
- `transcript-replay`
- `workspace-boundary`

最近一次验证结果：

```text
bun run eval:self
# 10 pass, 0 fail

bun run typecheck
# passed
```
