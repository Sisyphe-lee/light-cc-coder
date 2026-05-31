# 项目状态

这是跨 session 的简短 handoff。只记录当前仓库状态，不写流水账；详细架构看
`docs/plan.md`，具体 phase 设计看 `Spec/phase-N.md`。

## 元信息

| 字段 | 当前值 |
| --- | --- |
| 更新时间 | 2026-06-01 |
| 当前阶段 | Phase 4 已实现 |
| 下一步 | 准备 Phase 5：MCP、Skills、Commands |
| 验证基线 | `bun run test`、`bun run typecheck` |

## 新 session 阅读顺序

1. `AGENTS.md`
2. `docs/status.md`
3. `docs/plan.md`
4. 当前目标 phase 的 spec

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `bun run test` | 跑本仓库测试，已排除外部参考 repo 和 `WebRepo/`。 |
| `bun run typecheck` | TypeScript 类型检查。 |
| `bun src/cli/main.ts -p "hello" --fake --cwd "$PWD" --transcript /tmp/light-cc-fake.jsonl` | 本地 FakeProvider smoke，不调用外部 API，用来检查 session/context/transcript 链路。 |
| `bun src/cli/main.ts -p "Reply with pong" --cwd "$PWD" --base-url "$LIGHT_CC_GLM_BASE_URL" --model "$LIGHT_CC_GLM_MODEL" --api-key-env ZAI_API_KEY --transcript /tmp/light-cc-glm.jsonl --max-steps 5` | GLM-5.1 OpenAI-compatible smoke，可真实调用模型和文件工具。 |

不要裸跑 `bun test`，它可能扫到外部参考 repo。

GLM 调试环境变量已放在 `~/.zshrc`：`ZAI_API_KEY`、`LIGHT_CC_GLM_BASE_URL`、`LIGHT_CC_GLM_MODEL`。新 shell 直接可用；当前 shell 需要 `source ~/.zshrc`。

## 当前实现

已实现：

- TypeScript/Bun 脚手架。
- core messages/events/ops/provider/tool runtime types。
- `AgentSession.submit(op)`、`events()`、`abort()`、`close()`。
- replayable event stream，支持多个消费者。
- JSONL transcript writer/replay。
- OpenAI-compatible provider message projection。
- `runTurn` / `executeStep` loop kernel。
- `FakeProvider`、`FakeToolRuntime`。
- Phase 0 loop/session 测试。
- `ToolRegistry` 和 OpenAI-compatible tool schema export。
- 真实 `RealToolRuntime`：lookup、parse validation、exception/error-to-result、结果截断、read-only batch concurrency、writer serial。
- workspace path boundary：realpath containment、deepest existing ancestor、symlink escape deny、sensitive path hard deny。
- `WorkspaceFs` UTF-8 read/write safety primitives。
- workspace-scoped `read`、`grep`、`glob`、`edit`、`write`、`apply_patch`。
- OpenAI-compatible streaming provider adapter，支持 fragmented tool args 和 malformed JSON sentinel。
- `ContextAssembler`：SessionEngine-owned provider request assembly、稳定 source 顺序、runtime facts、project meta context、tool schema hash、history projection snapshot。
- root `AGENTS.md` 作为 project meta user context 注入，不进入 global system prompt。
- context diagnostics events：`context.session`、`context.step`，用于解释 provider request prefix、source 状态和 hash。
- `Runtime` / `LocalRuntime` / `LocalDeployment`，本机一次性 shell 执行。
- `bash` tool 通过 `ToolRuntime` 接入 `LocalRuntime`，支持 timeout、process-group cleanup、cwd tracking、runtime env、stdout/stderr capture、head+tail truncation。
- permission modes：`read-only`、`workspace-write`、`danger-full-access`。
- permission policy：deny > ask > allow；shell hard denylist；极小 git inspection allowlist。
- session-owned approval flow：`approval.requested` / `approval.responded` event，`AgentSession.submit({ type: "approval.respond" })`。
- `-p` CLI 在 `workspace-write` 下对普通 `bash` approval 做最小终端确认；非交互 stdin fail closed。
- file tools、`apply_patch`、`bash` 统一走 permission/sandbox policy；Phase 3 bash sandbox 是 policy-only，不承诺 OS jail。
- transcript 记录 approval、permission decision、bash observation；replay 仍只投影 model-visible message/tool result。
- 最小 `-p` CLI smoke，支持 `--cwd`、`--model`、`--base-url`、`--api-key-env`、`--transcript`、`--max-steps`、`--permission-mode`。
- compact-first context management：
  - large tool result artifact preview：大结果写入 workspace 外 session artifact，模型只收到 bounded preview，并记录 `tool.artifact` diagnostic。
  - history projection snip：旧的大型 tool result 在 provider request 中替换为 snip marker，canonical state/transcript 不变，recent tail 保持完整。
  - manual compact：`AgentSession.submit({ type: "compact.request" })` 生成 summary + pairing-safe recent tail，并写 `compact.started` / `compact.ended` checkpoint。
  - replay 从最新 successful compact checkpoint + suffix 恢复，忽略 artifact/context diagnostics。
  - auto compact 在 context hard threshold 前触发；provider context-too-large 支持一次 compact/retry；compact prompt too large 会有限次丢弃最旧完整 message group 后重试。
  - CLI 支持 `--max-context-tokens` 和 `--compact-threshold`。

未实现：

- REPL。
- Docker / remote runtime / OS-level shell sandbox。
- persistent shell session、background jobs。
- 完整 REPL / 持久 approval rules / 复杂 approval UI。
- 自动测试发现、verification subagent。
- MCP、skills、memory、hooks。

## Phase 进度

| Phase | 状态 |
| --- | --- |
| Phase 0 | Done |
| Phase 1 | Done |
| Phase 2 | Done |
| Phase 3 | Done |
| Phase 4 | Done |
| Phase 5 | Not started |
| Phase 6 | Not started |

## 当前核心不变量

- 是否继续 loop 由 `assistant.toolCalls.length` 决定。
- assistant tool call 必须有 exactly one model-visible tool result。
- 工具错误、未知工具、非法输入、异常、abort 都回灌为 tool result。
- denied、timeout、sandbox denied、runtime error 也回灌为 model-visible tool result。
- transcript write failure 是 fatal。
- replay/projection 会拒绝 missing、duplicate、orphan、reordered、cross-turn tool result。
- abort 不依赖 provider/tool 主动配合，会 race `AbortSignal`。
- provider request context 由 `SessionEngine` / `ContextAssembler` 组装；diagnostics 不参与 replay。
- global system prompt 不混入 cwd/date/AGENTS/git/permission/user preference；这些通过稳定 source slot 诊断。
- large tool result artifact 只通过 paired preview 进入 model history；artifact diagnostic 不参与 replay。
- compact checkpoint 是 append-only transcript event；active history 只在 successful `compact.ended` 写入成功后切换。
- compact recent tail 必须 assistant/tool pairing-safe；replay 从最新成功 checkpoint 重建 active projection。

## 最近验证

- `bun run test`: 170 pass。
- `bun run typecheck`: pass。
- CLI smoke：`--fake` 跑通并写出 `context.session` / `context.step` transcript。
- GLM-5.1 OpenAI-compatible smoke：`read` -> `edit` -> `bash` verification demo 跑通。

## 维护规则

- phase 边界或关键状态变化时更新。
- 原地替换内容，不追加流水账。
- 保持简短；长解释放到 `docs/plan.md` 或 phase spec。
- 命令说明必须和 `package.json` 保持一致。
