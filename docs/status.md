# 项目状态

这是跨 session 的简短 handoff。只记录当前仓库状态，不写流水账；详细架构看
`docs/plan.md`，具体 phase 设计看 `Spec/phase-N.md`。

## 元信息

| 字段 | 当前值 |
| --- | --- |
| 更新时间 | 2026-06-01 |
| 当前阶段 | Phase 7 Product Shell / Minimal Entry 最小闭环已实现 |
| 下一步 | Phase 7 后续可选：更完整 Ctrl-C/approval 交互测试、host-only `/diff` 数据源；Phase 8 再做 profiling |
| 验证基线 | `bun run test`、`bun run typecheck` |

## 新 session 阅读顺序

1. `AGENTS.md`
2. `docs/status.md`
3. `docs/plan.md`
4. 当前目标 phase 的 spec（Phase 6 起见 `Spec/phase-6.md`、`Spec/phase-7.md`、`Spec/phase-8.md`、`Spec/phase-9.md`）

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `bun run build` | 构建 npm 发布用 Node.js bin：`dist/main.js`。 |
| `bun run test` | 跑本仓库测试，已排除外部参考 repo 和 `WebRepo/`。 |
| `bun run typecheck` | TypeScript 类型检查。 |
| `npm install -g light-cc-coder` | 从 npm 安装当前发布包；不需要 clone，运行时只要求 Node.js 20+、`rg` 和 provider 配置。 |
| `npm install -g /data1/lcy/projects/light-cc-coder` | 从当前工作树安装 `lightcc` / `light-cc` / `light-cc-coder` 三个 bin alias；本地 source install 需要 Bun 用于 prepare/build。 |
| `lightcc doctor --cwd "$PWD"` | 检查 provider/env、cwd、session store、rg、git、permission、MCP/skills/tool registry；不发模型请求、不写普通 transcript。 |
| `lightcc` | 在当前 repo 进入 line-oriented REPL；需要有效 provider 配置。 |
| `lightcc -p "hello"` | one-shot 执行；需要有效 provider 配置。 |
| `lightcc --dry-run -p "hello" --cwd "$PWD"` | 只解析配置和 session plan，不调用 provider、不执行 agent tools、不写普通 transcript。 |
| `lightcc resume --last --cwd "$PWD"` | 从同 cwd 的最新默认 session 恢复 REPL。 |
| `lightcc --fake -p "hello" --cwd "$PWD" --transcript /tmp/light-cc-fake.jsonl` | 本地 FakeProvider smoke，不调用外部 API，用来检查 session/context/transcript 链路。 |
| `lightcc -p "Reply with pong" --cwd "$PWD" --base-url "$LIGHT_CC_GLM_BASE_URL" --model "$LIGHT_CC_GLM_MODEL" --api-key-env ZAI_API_KEY --transcript /tmp/light-cc-glm.jsonl --max-steps 5` | GLM-5.1 OpenAI-compatible smoke，可真实调用模型和文件工具。 |

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
- Phase 5 最小扩展面：
  - MCP stdio client，显式 session/CLI 配置，CLI 支持 `--mcp-config <path>`。
  - MCP tools 以 `mcp__server__tool` 注册进同一个 `ToolRuntime`，走 permission、schema、result、artifact/truncation 路径。
  - MCP startup/ready/failed/stopped diagnostics 不参与 replay；call timeout 和 permission deny 以 paired tool result 回灌。
  - explicit skills loader 只读 `SKILL.md`，CLI 支持 `--skill <path>`，active snapshot 注入 `skills_slot`。
  - built-in slash commands：`/help`、`/clear`、`/compact`、`/memory`、`/tools`、`/permissions`，默认不写入 model history。
  - typed lifecycle hooks：`user_prompt_submit`、`pre_tool`、`post_tool`、`stop`；pre-tool block 转 paired error result，post/stop diagnostic-only。
  - session-scoped `todo` builtin tool，允许 read-only mode，不写 workspace，并通过 `todo_slot` 注入 bounded context。
- Phase 6 Dogfood Hardening 最小闭环：
  - read-only `git_feedback` builtin tool，走 `ToolRuntime`，支持 non-git、branch/HEAD、dirty files、diff stat、bounded diff preview、sensitive path patch redaction。
  - richer approval display metadata：cwd、permission mode、tool description、subject、policy reason、tool reason、bounded input/access/risk summary；CLI 仍只 allow once / deny。
  - provider retry/failure classification：pre-delta 429/408/5xx/network/stream drop 有限 retry；partial delta、auth/client error、context overflow 不走普通 retry；写 replay-invisible diagnostics。
  - todo replace 单一 `in_progress` 约束，违反时返回 paired error result，不更新 state，不 emit `todo.updated`。
  - verification ergonomics：`bash.description` 进入 `bash.observation`，显式/明显 verification bash 产生 post-result replay-invisible `verification.observed`。
- Phase 7 Product Shell 最小闭环：
  - installable bin aliases：`lightcc`、`light-cc`、`light-cc-coder`；package 已去除 private 标记，发布包使用 Node.js `dist/main.js` 入口。
  - CLI 产品层拆分为 args/config/sessionStore/sessionFactory/eventRenderer/approvalPrompt/repl/doctor，`main.ts` 保持薄入口。
  - 默认数据目录 `~/.lightcc`，可由 `LIGHTCC_HOME` 覆盖；默认 session 写入 `sessions/<id>/transcript.jsonl`、`metadata.json`、`session_index.jsonl`。
  - config layering：defaults < global config < project config < env < CLI flags；effective values 可通过 `/config` 和 doctor 报告 source；API key 仍从 env 读取。
  - `-p` one-shot 保持兼容；无 `-p` 且 TTY 默认进入 line-oriented REPL；测试可用 `--repl` 强制 REPL。
  - REPL 通过 `AgentSession.submit(op)` 和 `events()` 互动，支持多轮同一 session、streamed output、tool status、approval prompt、idle double Ctrl-C/active abort 基础语义、Ctrl-D 退出。
  - product slash commands：`/help`、`/status`、`/config`、`/context`、`/diff`、`/tools`、`/permissions`、`/compact`、`/sessions`、`/resume`、`/clear`、`/quit`、`/exit`；默认不进入 model-visible history。
  - `doctor` / `--dry-run` 不发模型请求、不执行 agent tools、不写普通 transcript。
  - resume 从 canonical transcript 通过 `readJsonlTranscript` + `messagesFromEvents` 恢复 active messages，保留 replay pairing 校验，并拒绝不同 cwd session。

未实现：

- Docker / remote runtime / OS-level shell sandbox backend（Phase 9 草案只覆盖可选 `sandbox-runtime` backend）。
- persistent shell session、background jobs。
- full TUI / 持久 approval rules / 复杂 approval UI。
- 自动测试发现、verification subagent。
- implicit long-term memory。
- MCP HTTP/SSE/OAuth/resources/prompts/hot reload。
- custom markdown slash commands。
- skill assets/scripts install/search/subagents。
- Phase 6 尚未实现：
  - host-only `/diff`。
  - `turn.changed_files` diagnostic。
  - transcript health scanner。
- Phase 7 尚未实现：
  - public `--json` automation stream。
  - host-only `/diff` 的真实 changed-files 数据源（当前可报告 unavailable）。
  - 完整 session picker/search/rename/archive/export。
- Phase 8 Profiling：
  - replay-invisible profile spans and local transcript profiling summary。
- Phase 9 Optional OS Sandbox Backend：
  - optional `@anthropic-ai/sandbox-runtime` integration through `Runtime/Deployment`。

## Phase 进度

| Phase | 状态 |
| --- | --- |
| Phase 0 | Done |
| Phase 1 | Done |
| Phase 2 | Done |
| Phase 3 | Done |
| Phase 4 | Done |
| Phase 5 | Minimal closed loop implemented |
| Phase 6 | Minimal closed loop implemented |
| Phase 7 | Minimal closed loop implemented |
| Phase 8 | Planned: Profiling / Performance Observability |
| Phase 9 | Draft planned: Optional OS Sandbox Backend |

## 下一阶段边界

Phase 6 已完成第一批最小闭环：`git_feedback`、approval display metadata、
provider retry/failure classification、todo 单一 `in_progress` 约束、verification
observation diagnostic。

Phase 6 后续如继续，只做 host-only `/diff` 或 `turn.changed_files` 这类审计面；
不要扩到 REPL/TUI、profiling、sandbox、persistent shell、background jobs、repo map、
subagents 或自动 git mutation。

Phase 7 已完成最小产品入口：installable bin aliases、interactive line REPL、默认 transcript/session store、doctor/dry-run、resume 和 config/status/context 等 slash 命令。

Phase 8 再做 `profile.span` diagnostic 和 `lightcc profile <transcript>` 本地汇总。它不是 benchmark/evaluation。

Phase 9 草案是可选 OS sandbox backend，优先评估 `@anthropic-ai/sandbox-runtime`，接在 `Runtime/Deployment` 层，不替代 permission policy、workspace boundary 或 ToolRuntime。

高价值但后置：persistent shell、background jobs、full repo map/codegraph、resource-aware scheduler、rollback/fork、session/project memory、MCP resources/auth/hot reload、attachments/IDE refs、subagents。

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

- `npm publish`: `light-cc-coder@0.1.1` published as `latest`。
- `npm install light-cc-coder@latest` from registry + `lightcc --fake --repl`: pass。
- `npm install light-cc-coder@latest` from registry + real GLM REPL prompt `Reply with exactly: pong`: pass。
- `npm pack` + tarball install with scripts disabled + `lightcc` / `light-cc-coder` smoke: pass。
- `npm install --prefix <tmp> /data1/lcy/projects/light-cc-coder` + `lightcc` smoke: pass。
- `bun run test`: 269 pass。
- `bun run typecheck`: pass。
- CLI smoke：`--fake` 跑通并写出 `context.session` / `context.step` transcript。
- GLM-5.1 OpenAI-compatible smoke：`read` -> `edit` -> `bash` verification demo 跑通。

## 维护规则

- phase 边界或关键状态变化时更新。
- 原地替换内容，不追加流水账。
- 保持简短；长解释放到 `docs/plan.md` 或 phase spec。
- 命令说明必须和 `package.json` 保持一致。
