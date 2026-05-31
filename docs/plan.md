# light-cc-coder 决策版实现计划

本文档是后续实现的权威计划。它不是参考资料列表，而是已经筛选后的架构决策和分阶段交付边界。

## 0. 总目标

实现一个轻量、快速、可真实使用的 TypeScript Claude Code 风格 coder harness。

核心形态：

```mermaid
flowchart TD
  UI["CLI / simple REPL / -p"] --> CORE["AgentSession<br/>submit(op) + events()"]
  CORE --> QE["SessionEngine / QueryEngine<br/>state + context + transcript"]
  QE --> LOOP["runTurn / executeStep"]
  LOOP --> MODEL["Provider Adapter<br/>OpenAI-compatible first"]
  MODEL --> LOOP
  LOOP -->|tool calls| TR["ToolRuntime"]
  TR --> PERM["Permission + Sandbox Policy"]
  PERM --> RT["Runtime / Deployment<br/>local first, docker later"]
  TR --> TOOLS["Tools<br/>read grep glob edit write bash todo apply_patch"]
  RT --> TOOLS
  TOOLS -->|tool result| TR --> LOOP
  QE --> LOG["JSONL Event Transcript"]
  LOG --> QE
  QE --> CTX["Context + Memory + Compaction"]
  CTX --> LOOP
  EXT["MCP / Skills / Commands"] --> CTX
  EXT --> TR
```

## 1. Non-negotiable 不变量

第一版必须保证：

- 每个 model tool call 都有 exactly one paired tool result，除非 turn 在结果记录前被明确中断。
- tool result 以模型可理解的结构回灌，工具错误、权限拒绝、超时、sandbox denied 都不能只停留在 UI。
- `runTurn` 不直接读写 UI 状态；UI 只通过 `submit(op)` 和事件流互动。
- 文件写入默认限制在 workspace root 内，并处理 symlink/path traversal。
- shell 默认有 timeout、cwd、env、output truncation、kill process group。
- context 不无限增长：至少有 tool output snip 和 manual compact；后续有自动 compact。
- session 可 trace、可 replay、可 resume；JSONL event transcript 是持久化基线。
- prompt/cache 尽量稳定：system prompt、tool schema、memory 注入顺序稳定；正常 turn 只 append。

## 2. 已定模块边界

### 2.1 Core: AgentSession

职责：

- 暴露 `submit(op): Promise<void>`。
- 暴露事件流，最初可用 `EventEmitter` 或 async iterator。
- 管理 active turn、interrupt、approval response、compact request、shutdown。
- 不直接实现 model call、tool execution、filesystem operation。

采用 Codex 的核心接口思想：`Core = submit(Op) + nextEvent()`。第一版不做 app-server/JSON-RPC，先同进程内存实现。

事件最小集合：

- `session.started`
- `turn.started`
- `step.started`
- `assistant.delta`
- `assistant.message`
- `tool.call`
- `tool.result`
- `approval.requested`
- `step.ended`
- `turn.ended`
- `compact.started`
- `compact.ended`
- `error`

### 2.2 SessionEngine / QueryEngine

职责：

- session id、turn id、message history、tool state、memory state。
- 将 transcript/event log 投影成 provider messages。
- 每个 step 前通过 ContextAssembler 组装 provider request context：system prompt、runtime facts、AGENTS.md、memory/git/skills/MCP 插槽、tools schema、history projection。
- 调用 `runTurn`，处理 provider retry、context overflow、compact retry、resume。
- 写 JSONL transcript。

边界：

- 不直接执行工具。
- 不直接审批权限。
- 不把 CLI/TUI 的展示结构塞进 messages。

### 2.3 Agent Loop

核心伪代码：

```ts
async function runTurn(input) {
  appendUserMessage(input)
  for step in 1..maxSteps {
    const messages = await buildMessages()
    const response = await model.stream({ messages, tools })
    appendAssistantMessage(response)
    if (response.toolCalls.length === 0) return endTurn(response.stopReason)
    const toolResults = await toolRuntime.runBatch(response.toolCalls)
    appendToolResults(toolResults)
    maybeCompactBeforeNextStep()
  }
  return pauseWithMaxSteps()
}
```

模型是否继续由实际 `toolCalls.length` 决定，不只信 `finish_reason`。

### 2.4 Provider Adapter

Phase 1 已落地 minimal OpenAI-compatible streaming adapter，用于驱动文件型 coder
闭环。Phase 2 不重新实现 provider，而是审计 provider request assembly 与 context
source 边界，确保后续 memory/skills/MCP 注入不会污染 loop 或破坏 replay。

接口：

```ts
interface Provider {
  stream(input: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}
```

职责：

- 归一化 text delta、reasoning delta、tool call delta、final tool calls、usage、finish reason。
- 解析 streaming tool call arguments。
- 保留 provider raw metadata 到 transcript diagnostics，不污染 model-visible messages。

不做：

- 多 provider SDK 深集成。
- Anthropic native special headers。
- prompt cache control 特化。后续再加。

### 2.5 ToolRuntime

职责：

- 查 tool。
- JSON/schema validation。
- 准备 display/description。
- 调 workspace/file safety policy；Phase 3 接入完整 permission/sandbox policy。
- 调 tool execute。
- output truncation。
- 将异常、拒绝、超时转为 `ToolResult`。
- 按 provider order 记录 `tool.result`。

调度：

- Phase 1：all read-only 批次并发；任何 writer/apply_patch 出现则整个 batch 串行。
- Phase 3：`bash` 接入后仍保守串行，受 permission/sandbox policy 约束。
- 后续 hardening：升级为 resource-aware scheduler。

工具接口：

```ts
interface Tool<Input = unknown> {
  name: string
  description: string
  inputSchema: unknown
  readOnly: boolean
  approvalRule?(input: Input): string
  accesses?(input: Input): ToolAccesses
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>
}
```

### 2.6 Runtime / Deployment

采用 SWE-ReX 的窄接口思想，但做 TypeScript 子集。

接口：

```ts
interface Runtime {
  isAlive(): Promise<boolean>
  createSession(name: string, opts?: RuntimeSessionOptions): Promise<void>
  runInSession(name: string, command: ShellCommand): Promise<ShellObservation>
  execute(command: ShellCommand): Promise<ShellObservation>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  closeSession(name: string): Promise<void>
  close(): Promise<void>
}
```

Phase 3：

- `LocalRuntime`：本机执行，受 permission/workspace boundary 管控。
- `LocalDeployment`：启动和关闭 runtime，实际只是创建对象。

后续：

- `DockerDeployment`：容器隔离，runtime server 或 mounted workspace。

边界：

- agent loop 不直接使用 `child_process`。
- shell/file tools 通过 runtime 或 workspace fs adapter。

### 2.7 Permission / Sandbox / Safety

MVP 权限模型：

- `read-only`：只允许 read/grep/glob/todo。
- `workspace-write`：允许 workspace 内文件写入，bash 需要 ask 或 allow rule。
- `danger-full-access`：跳过提示，但仍记录审计事件。

Policy：

- `allow` / `ask` / `deny`。
- deny 优先级最高。
- subject 从 args 提取：`command`、`path`、`file_path`、`pattern`。
- approval 用 pending promise：tool runtime 发 `approval.requested`，CLI/REPL 回 `approval.responded`。

Safety：

- sensitive paths hard deny：`.env`、private keys、SSH keys、credentials 等。
- workspace write boundary 默认开启。
- shell denylist 默认开启：`rm -rf /`、`git reset --hard`、`git push`、disk formatting、curl pipe shell 等。
- apply patch/write/edit 走同一套 file write policy。

### 2.8 Tools

内置工具分阶段接入：

- Phase 1 file tools：
  - `read`：读文本文件，line numbers，offset/limit，大文件保护。
  - `grep`：调用系统 `rg`，遵守 `.gitignore`，限制结果数。
  - `glob`：文件发现，稳定排序，限制结果数。
  - `edit`：exact `oldText -> newText`，要求唯一匹配，返回 unified diff。
  - `write`：新建/整体覆盖，受写边界保护。
  - `apply_patch`：专门 patch 工具，parse/validate 后再写文件。
- Phase 3 shell/verification：
  - `bash`：命令执行，timeout，stdout/stderr capture，head/tail truncation，exit code。
- Phase 5 extension/usability：
  - `todo`：轻量任务状态，只影响 session，不碰文件。

编辑决策：

- 第一版主编辑面是 `edit` exact replace 和 `apply_patch`。
- Aider 的 SEARCH/REPLACE 作为后续优化输入格式，不作为第一版主协议。
- 对 patch/apply/edit 维护 turn 内 committed delta，UI diff 不只依赖 `git diff`。

### 2.9 Context / Memory / Compaction

Context 组成：

- Stable system prompt：固定行为规则、工具使用原则、输出风格。
- Runtime context：cwd、OS、date、git status、permission mode。
- Project context：AGENTS.md，后续支持多层发现。
- Memory：本地显式 memory 文件，不自动写隐式长期记忆。
- Skills：被启用 skill 的简短说明和具体指令。
- History projection：从 transcript 投影出的 provider messages。

压缩：

- Phase 1：ToolRuntime 层做 tool result output cap，避免单次结果炸上下文。
- Phase 1 已落地 minimal ContextBuilder 作为真实 provider 支撑面；它只是能跑通 `AGENTS.md` 的 shim，不是最终 Context Engineering。
- Phase 2：把 minimal ContextBuilder 升级为真正的 Context Assembly 层，接回 SessionEngine，明确 source ownership、稳定注入顺序、context snapshot/replay/debug、后续 memory/skills/MCP 插槽。
- Phase 4：history tool output snip、manual compact、context overflow 自动 compact/retry。
- compact 摘要必须保留：任务目标、已改文件、关键决策、失败命令、当前下一步。
- compact 不能产生 orphan tool result；recent tail 边界要对齐 assistant/tool pairing。

### 2.10 MCP / Skills / Commands

Phase 5 薄实现：

- MCP stdio only。
- MCP tools 命名空间化，比如 `mcp__server__tool`。
- MCP tools 注册进 ToolRuntime，必须走同一权限系统。
- Skills 读取 `SKILL.md`，手动启用或简单关键字触发，注入 context。
- Slash commands：`/help`、`/clear`、`/compact`、`/memory`、`/tools`、`/permissions`。

不做：

- OAuth。
- 插件市场。
- skill assets/scripts 自动复杂执行。

## 3. 目录规划

```text
src/
  core/
    AgentSession.ts
    events.ts
    ops.ts
  engine/
    SessionEngine.ts
    contextBuilder.ts
    messageProjection.ts
    transcript.ts
  loop/
    runTurn.ts
    executeStep.ts
    modelEvents.ts
  providers/
    openaiCompatible.ts
    types.ts
  tools/
    ToolRuntime.ts
    registry.ts
    builtins/
      read.ts
      grep.ts
      glob.ts
      edit.ts
      write.ts
      applyPatch.ts
      bash.ts
      todo.ts
  workspace/
    pathBoundary.ts
    WorkspaceFs.ts
  runtime/
    Runtime.ts
    LocalRuntime.ts
    Deployment.ts
  permissions/
    policy.ts
    approval.ts
    shellPolicy.ts
  context/
    agentsMd.ts
    memory.ts
    compaction.ts
    gitContext.ts
  extensions/
    mcp.ts
    skills.ts
    commands.ts
  cli/
    main.ts
    repl.ts
test/
  loop/
  tools/
  permissions/
  transcript/
```

## 4. Phases

### Phase 0: 核心骨架

Spec: [`Spec/phase-0.md`](../Spec/phase-0.md)

Status: implemented. Verification: `bun run test` and `bun run typecheck`.

定位：Phase 0 是 kernel milestone，不是可用 coder。它只证明 loop、tool/result pairing、事件流、transcript/replay 等核心不变量；真实文件工具、shell、权限、sandbox 从后续 phase 接入。

交付：

- TypeScript package scaffold。
- `AgentSession.submit(op)` + async event stream。
- JSONL transcript writer。
- fake provider。
- `runTurn` / `executeStep`。
- fake tool runtime。

测试：

- text-only turn completes。
- one tool call leads to one tool result and second model step。
- malformed tool call becomes error result。
- multiple tool calls produce ordered paired results。
- unknown tool / tool exception become error results。
- maxSteps pairs final tool calls before ending。
- abort cannot leave orphan tool calls。
- transcript replay recreates provider messages。
- active turn guard rejects concurrent user submit。

完成标准：

- 不接真实模型也能用 fake provider 完整 replay 一次 tool turn。

### Phase 1: Tool Runtime / File Tools

Spec: [`Spec/phase-1.md`](../Spec/phase-1.md)

Status: implemented. Verification: `bun run test` and `bun run typecheck`.

定位：Phase 1 原本主线是打牢真实 ToolRuntime 和 workspace-scoped 文件工具。并行实现已经顺带落地了 minimal real-provider/context/headless entry，用作文件工具链路的真实驱动面。后续仍把深度 Context Engineering 单独放在 Phase 2 审计和加固，不继续把新 context 能力塞回 Phase 1。

交付：

- `ToolRegistry` 和 OpenAI-compatible tool schema export。
- `ToolRuntime`：lookup、input parse/validation、error-to-result、output truncation、provider-order result normalization。
- `read`、`grep`、`glob`、`edit`、`write`、`apply_patch`。
- workspace path boundary：path traversal、absolute outside、symlink escape、新文件 deepest existing ancestor。
- sensitive path hard deny：`.env`、private keys、SSH/cloud/kube/docker credentials。
- read-only batch concurrency；writer/apply_patch serial。
- OpenAI-compatible provider streaming adapter。
- minimal context prefix：stable system prompt、workspace facts、root `AGENTS.md`、tool schemas、projected history。
- simple `-p` CLI smoke。

测试：

- Phase 0 regression 全部通过。
- unknown tool / invalid input / tool exception 都返回 exactly one error result。
- read-only batch 可并发但结果保持 provider order。
- writer 出现时整批串行。
- read before edit workflow with `FakeProvider + real ToolRuntime`。
- edit duplicate/missing oldText fails without writing。
- write outside workspace / sensitive path denied without writing。
- apply_patch malformed/conflict/outside workspace fails without partial write。
- transcript replay recreates valid provider messages。
- provider mock SSE：text delta、tool call delta、multiple interleaved tool calls、malformed JSON。
- root `AGENTS.md` missing/oversized cases。
- `-p` smoke with fake/mock provider，不依赖真实网络。

完成标准：

- 用 `FakeProvider` 触发真实 ToolRuntime，在 temp workspace 中读、搜、改、写、patch，并保持 Phase 0 pairing/transcript/replay 不变量。
- 能用 real OpenAI-compatible provider adapter 手动驱动文件型 coder 的基础链路。

### Phase 2: Context Assembly / Context Engineering

Status: implemented. Verification: `bun run test` and `bun run typecheck`.

定位：Phase 2 专门实现真正的 Context Assembly 层。Phase 1 已经落地 minimal ContextBuilder/provider/`-p`，但这只是可运行闭环；Phase 2 要把 context 组装从 `AgentSession.start()` 的临时拼接，提升为 SessionEngine 拥有、独立模块实现、可 trace/replay/debug 的核心能力。

交付：

- `ContextAssembler` 模块：明确 stable prefix、runtime facts、project context、tool schemas、history projection 的 ownership。
- `SessionEngine` owns context assembly：`AgentSession` 不再直接加载和拼接 `AGENTS.md`。
- context snapshot / provider request trace 完整化，便于 replay/debug。
- prompt/cache stability audit：system prompt、tool schema、AGENTS.md、runtime facts 的顺序稳定。
- root `AGENTS.md` 行为加固：size cap、缺失、截断、后续多层发现的兼容设计。
- context source slots：为 Phase 4 memory/git/compact 和 Phase 5 skills/MCP 预留稳定接口，但不实现它们。
- provider request assembly 从 loop 中保持解耦，`runTurn` 仍不直接拼 context。

测试：

- context request order stable。
- context snapshot can reconstruct provider request prefix。
- AGENTS.md changes after transcript do not make old transcript ambiguous。
- tool schemas remain stable across repeated builds。
- transcript replay 仍只从 `user.message`、`assistant.message`、`tool.result` 重建 model history。

完成标准：

- 能清楚解释一次 provider request 的 context prefix 来自哪些 source、顺序为何、如何 replay/debug，并为后续 memory/skills/MCP 注入保留稳定接口。

### Phase 3: Shell、权限、验证

Status: not started.

交付：

- `bash` through `LocalRuntime`。
- timeout、kill process group、stdout/stderr capture、output truncation。
- permission modes：read-only、workspace-write、danger-full-access。
- approval event + response。
- shell denylist/allowlist。
- 修改代码后运行测试命令的最小 verification workflow。

测试：

- denied shell returns tool result。
- timeout returns tool result and kills process。
- user approval allow/deny paths。
- dangerous commands denied or ask。
- workspace-write permits file tools but gates bash。
- verification command output is truncated and replay-safe。

完成标准：

- 能修改代码后运行测试命令；危险命令不会直接执行。

### Phase 4: Memory、Git Context、Compaction

交付：

- memory file load/write command。
- git status context。
- history tool output snip。
- manual `/compact`。
- context overflow compact/retry。

测试：

- long historical tool output is snipped.
- compact keeps recent valid assistant/tool pairing.
- compact summary is persisted as event.
- replay after compact remains valid.

完成标准：

- 长任务不会因为上下文增长直接失控，session 可恢复。

### Phase 5: MCP、Skills、Commands

交付：

- MCP stdio client。
- MCP tool registration and namespacing。
- skill loader。
- slash commands。
- minimal hooks：user prompt submit、pre tool、post tool、stop。
- `todo` session tool。

测试：

- MCP tool result pairs correctly。
- MCP tool goes through permission。
- skill injects prompt deterministically。
- slash command does not pollute model history unless intended。

完成标准：

- 最小扩展面可用，但不扩大核心 loop。

### Phase 6: Usability hardening

交付：

- Response latency profiling。
- better approval display。
- resource-aware tool scheduler。
- DockerDeployment。
- repo map prototype。
- git feedback loop prototype。

完成标准：

- 对真实中小仓库有稳定开发体验。

## 5. 外部参考结论固化

这些不是“以后每次都要重新看”的开放任务，而是已经固化进计划的设计取舍：

- Claude Code：主行为模型。保留 `query -> tool_use -> runTools -> tool_result -> next query` 的骨架。
- CoreCoder：只借极简 loop 心智模型和 exact edit，不借安全模型。
- Reasonix：借 prefix-cache 友好、read-only 并发、permission/sandbox 分层。
- morlay/deepseek-harness：借中文工具 prompt 和 shell/filesystem hook 的轻量思路，不依赖 Pi runtime。
- Kimi Code：借 TypeScript loop 分层、event transcript、tool lifecycle、AbortSignal、resource-aware scheduler 方向。
- openai/codex：借 `submit(Op)+events()`、approval pending promise、tool orchestrator、apply_patch 专门路径。
- SWE-ReX：借 Runtime/Deployment 窄接口和持久 shell session；云后端后置。
- CodeWhale：借 product-grade loop/context/sandbox 的边界校验，不搬 Rust/TUI。
- OpenHarness：借 QueryEngine/context/permission 的模块切分，不搬产品层。
- Aider：后续借 repo map、SEARCH/REPLACE 编辑失败反馈、git feedback loop；不作为主架构。

## 6. 近期任务板

下一步准备 Phase 3，不跨 phase：

1. 为 shell/runtime/deployment 写 Phase 3 细化 spec。
2. 接入 `bash` 的 timeout、输出截断和 workspace-aware cwd。
3. 增加 permission modes、approval event/response、shell denylist。
4. 保持 ContextAssembler 作为 provider request assembly 唯一路径，不把 bash/permission 状态混回 global system prompt。
