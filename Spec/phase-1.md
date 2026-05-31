# Phase 1 Spec: Tool Runtime and File Tools

Status: implemented.

Phase 0 已经完成最小 `SessionEngine + Agent Loop` 骨架：它验证了
`assistant.toolCalls -> exactly one tool.result -> next provider call` 这个
Claude Code 风格状态转移不变量。

Phase 1 的核心交付是把 Phase 0 预留的 `ToolRuntime.runBatch(...)` 从 fake
runtime 推进成真实、可测试、可审计的工具运行时，并提供第一组
workspace-scoped 文件工具。

并行实现已经顺带落地了 minimal real-provider/context/headless entry，用于驱动
文件工具链路；Phase 2 仍负责把 Context Engineering 作为独立主题实现：把当前
minimal context shim 升级为真正的 Context Assembly 层，并接回 SessionEngine。
`bash`、permission、verification 不属于 Phase 1。

## 1. 目标

Phase 1 是 **Tool Runtime / File Tools** 阶段：

- 定义真实 `ToolRegistry`。
- 定义真实 `ToolRuntime`。
- 定义工具生命周期：lookup -> input validation -> workspace/safety check ->
  schedule -> execute -> normalize result。
- 内置文件工具：`read`、`grep`、`glob`、`edit`、`write`、`apply_patch`。
- 所有文件工具受 workspace boundary 约束。
- 文件工具有最小安全底线：path traversal deny、symlink escape deny、
  sensitive path hard deny、写入前校验。
- 工具失败、非法输入、路径拒绝、patch 冲突等都作为 model-visible
  `tool.result` 回灌。
- 用 `FakeProvider + real ToolRuntime + temp workspace` 做端到端测试。
- 已落地支撑面：OpenAI-compatible provider adapter、root `AGENTS.md` minimal
  context prefix、`-p` CLI smoke。

## 2. 非目标

Phase 1 不继续扩展：

- `bash` 工具。
- `LocalRuntime` / `Deployment`。
- shell timeout、process group、stdout/stderr capture、denylist/allowlist。
- permission modes：`read-only`、`workspace-write`、`danger-full-access`。
- approval prompt / approval event response。
- sandbox、Docker、remote runtime。
- MCP、skills、hooks、slash commands、memory、compact。
- 深度 Context Engineering：context source 分层、prompt/cache stability audit、
  多 context source trace、后续 memory/skills/MCP 插槽设计。
- REPL。
- Claude Code 式 streaming tool execution。
- Kimi 式 resource-aware scheduler。
- 自动运行测试命令或 verification workflow。

后续归属：

- Phase 2：Context Assembly / Context Engineering。
- Phase 3：`bash`、LocalRuntime、permission、approval、verification。
- Phase 4：memory、git context、tool output snip、compact。
- Phase 5：MCP、skills、commands、hooks。

## 3. 必须保留的 Phase 0 不变量

- loop 是否继续仍由 finalized `assistant.toolCalls.length` 决定。
- 每个 assistant tool call 必须得到 exactly one model-visible tool result。
- tool result 顺序必须匹配 provider tool call 顺序。
- unknown tool、invalid input、tool exception、abort 都不能只停留在 UI。
- transcript write failure 仍是 fatal。
- replay/projection 仍拒绝 missing、duplicate、orphan、reordered、cross-turn
  tool result。
- abort 后如果 assistant tool calls 已写入，必须给所有 pending calls 补齐
  abort tool results。

## 4. 参考结论

### 4.1 Claude Code

Claude Code 的工具链路大致是：

```text
assistant tool_use
  -> runTools / StreamingToolExecutor
      -> lookup tool
      -> schema validation
      -> tool-specific validation
      -> permission / hooks
      -> tool.call(...)
      -> map output to tool_result block
  -> append user-side tool_result
  -> next model step
```

Phase 1 借鉴：

- 工具是对象，不只是函数。
- validation 在执行前。
- 工具失败必须回灌模型。
- read-only/concurrency-safe 工具可并发，writer 保守串行。

Phase 1 不借：

- StreamingToolExecutor 提前执行工具。
- 复杂 permission classifier、hooks、MCP tool search、repair heuristics。

### 4.2 CoreCoder

CoreCoder 值得借的是极简工具接口和 exact edit 语义：

```text
oldText missing      -> fail without writing
oldText duplicated   -> fail without writing
oldText unique once  -> replace and return diff
```

不借：

- 无 workspace boundary。
- 多工具无脑并发。
- 无 event transcript。
- 参数校验只靠 Python `TypeError`。

### 4.3 Reasonix / Kimi

Reasonix 适合 Phase 1 的硬边界：

- per-run registry。
- `ReadOnly()` 分类。
- 全 read-only 批次并发，否则整批串行。
- writer workspace confinement 使用 realpath + deepest existing ancestor。

Kimi 适合借 lifecycle 形状：

```text
preflight -> prepare -> authorize/path check -> schedule -> execute -> finalize/coerce
```

但 Kimi 的 resource-aware scheduler、hooks、完整 permission chain 超出 Phase 1。

## 5. 模块边界

期望新增/扩展模块：

```text
src/
  tools/
    ToolRuntime.ts
    registry.ts
    schemas.ts
    result.ts
    builtins/
      read.ts
      grep.ts
      glob.ts
      edit.ts
      write.ts
      applyPatch.ts
  workspace/
    pathBoundary.ts
    WorkspaceFs.ts
  providers/
    openaiCompatible.ts
  context/
    agentsMd.ts
  engine/
    contextBuilder.ts
  cli/
    main.ts
```

`runTurn` 仍然只管 loop 状态转移。它不应该知道某个工具怎么读文件、怎么解析
patch、怎么检查 symlink。

## 6. Tool Runtime 设计

### 6.1 Loop-facing 接口

Phase 0 已有最小接口：

```ts
interface ToolRuntime {
  runBatch(calls: ToolCall[], ctx: ToolContext): Promise<ToolResultMessage[]>
}
```

Phase 1 保持这个接口不变，在内部扩展真实 runtime。

### 6.2 内部工具接口

建议内部工具接口：

```ts
type ToolDefinition<Input = unknown> = {
  name: string
  description: string
  inputSchema: JsonSchema
  readOnly: boolean
  parse(input: unknown): Input
  accesses?(input: Input): ToolAccesses
  execute(input: Input, ctx: ToolExecutionContext): Promise<ToolObservation>
}
```

`inputSchema` 面向未来真实 provider；`parse` 面向 runtime。Phase 1 可先用手写
validators，不强制引入 zod/ajv。

### 6.3 ToolRegistry

`ToolRegistry` 职责：

- 按稳定顺序注册工具。
- 按 name lookup。
- 导出 OpenAI-compatible tool schemas。
- 检测重复 tool name。
- 保留 per-session/per-run registry 实例，不依赖进程级全局状态。

Phase 1 内置 registry 顺序固定：

```text
read
grep
glob
edit
write
apply_patch
```

### 6.4 runBatch 生命周期

```text
for each call in provider order:
  preflight:
    lookup tool
    parse/validate input
    compute readOnly/accesses/display metadata

schedule:
  if every known valid call is readOnly:
    may execute concurrently with bounded concurrency
  else:
    execute serially in provider order

for each execution:
  check abort signal
  run tool-specific workspace/safety checks
  execute
  normalize success/error
  truncate result with explicit marker

return ToolResultMessage[] in original provider order
```

Ordinary failures must return error tool results, not throw:

- unknown tool;
- invalid input;
- path denied;
- sensitive path denied;
- not found;
- binary / too large;
- edit not unique;
- malformed patch;
- patch conflict;
- tool exception;
- abort.

Runtime may throw only for harness-level bugs that violate pairing or transcript
fatality. Even then, Phase 0 `runTurn` must preserve pairing behavior.

### 6.5 调度

Phase 1 做小调度器，不做 resource-aware scheduler。

规则：

- `read`、`grep`、`glob` 是 read-only。
- `edit`、`write`、`apply_patch` 是 writer。
- 如果整个 batch 都是 read-only，可以并发执行，结果仍按 provider order 返回。
- 只要 batch 内出现 writer、unknown tool、invalid preflight，整批串行。
- writer 不并发，避免 read-after-write / write-write 顺序问题。

并发必须有测试锁定。如果实现时发现复杂度高，可以先串行落地，但最终 Phase 1
完成前要补上 read-only batch concurrency。

### 6.6 ToolAccesses

Phase 1 可定义轻量 `ToolAccesses`，主要用于审计和未来 scheduler：

```ts
type ToolAccesses = {
  reads?: string[]
  writes?: string[]
  searches?: string[]
}
```

Phase 1 不用它做精细冲突调度；后续再升级。

### 6.7 Tool Result 格式

成功结果应包含：

- tool name;
- workspace-relative path(s);
- relevant content / diff / match list;
- truncation marker when capped.

错误结果应包含：

- stable error code;
- short reason;
- safe subject, usually workspace-relative path;
- no stack trace by default.

建议错误码：

```text
unknown_tool
invalid_input
path_denied
sensitive_path
not_found
not_text
too_large
not_unique
malformed_patch
patch_conflict
io_error
aborted
internal_error
```

## 7. Workspace Safety

Phase 1 不做完整 permission/approval，但文件工具必须有安全底线。

### 7.1 Workspace Root

- `AgentSession.cwd` 是 Phase 1 workspace root。
- 测试可直接传临时 workspace cwd。
- session/tool runtime 创建时把 root resolve 成 absolute real path。
- 文件工具输入可用相对路径；输出统一显示 workspace-relative path。

### 7.2 Path Boundary

所有文件工具共用一个 path boundary。

规则：

- 拒绝空 path、NUL byte、URL-like path、`~`。
- 相对路径按 workspace root 解析。
- 绝对路径只有在 real target 位于 workspace 内时允许。
- 现有路径必须通过 realpath containment check。
- 新文件路径用 deepest existing ancestor 做 symlink-aware check。
- symlink 指向 workspace 外部时拒绝。
- containment 必须按 path segment 判断，不能用字符串 prefix。

### 7.3 Sensitive Path Hard Deny

Phase 1 至少 hard deny：

- `.env`、`.env.*`;
- private keys：`id_rsa`、`id_ed25519`、`*.pem`、`*.key`;
- SSH config/keys under `.ssh`;
- common cloud/kube/docker credentials。

这些拒绝也必须作为 `tool.result isError: true` 回灌模型。

### 7.4 写入原子性要求

Phase 1 要求：

- validation failure 不写任何文件；
- path denied 不写；
- edit missing/duplicate oldText 不写；
- malformed patch / patch conflict 不写任何文件；
- apply_patch 多文件变更必须先全部 validate，再开始写。

不要求完整事务回滚；如果 validate 后发生 IO failure，tool result 必须说明可能的
partial write 风险。

## 8. Built-in File Tools

工具命名使用简短 lowercase，保持稳定。

### 8.1 `read`

Input:

```ts
{
  path: string
  offset?: number
  limit?: number
}
```

行为：

- 读文本文件并带行号返回。
- `offset` 建议 1-based，默认 1。
- `limit` 默认小值，例如 200。
- 检测 binary / too large。
- 输出过长必须显式截断并给下一页提示。

### 8.2 `grep`

Input:

```ts
{
  pattern: string
  path?: string
  glob?: string
  caseSensitive?: boolean
  maxResults?: number
}
```

行为：

- 优先用 `rg`，必须 structured argv，不经 shell。
- search root 必须在 workspace 内。
- 返回 `relativePath:line:column:text`。
- 结果稳定、有限量。
- invalid regex 返回 error result。

### 8.3 `glob`

Input:

```ts
{
  pattern: string
  path?: string
  maxResults?: number
}
```

行为：

- 在 workspace 内做文件发现。
- 返回 workspace-relative paths，稳定排序。
- 默认排除 `.git`、`node_modules`、`references/repos`、`WebRepo`。
- 不跟随 symlink directories。

### 8.4 `edit`

Input:

```ts
{
  path: string
  oldText: string
  newText: string
}
```

行为：

- `oldText` 必须恰好出现一次。
- 0 次或多次都失败且不写。
- 成功只替换一次。
- 返回 bounded unified diff。
- `newText` 可为空。

### 8.5 `write`

Input:

```ts
{
  path: string
  content: string
  overwrite?: boolean
}
```

行为：

- 创建新文件或覆盖整个文件。
- 如果目标存在且 `overwrite !== true`，失败且不写。
- 覆盖时返回 diff。
- 创建 parent directories 也必须在 workspace 内。

### 8.6 `apply_patch`

Input:

```ts
{
  patch: string
}
```

行为：

- 使用专门 patch 工具，不通过 shell。
- Phase 1 只需支持一个小而明确的 patch DSL。
- 必须支持 add/update/delete。
- 所有路径 workspace-relative。
- parse 全部 patch，validate 全部 hunks，计算全部新内容，再写。
- malformed patch / conflict / outside workspace 都失败且不写。

实现时可借 Codex apply_patch 的 DSL 思路，但不能复制源码。

## 9. Transcript / Events

Phase 1 尽量复用 Phase 0 events。

新增事件可少量加入：

```ts
type ToolRuntimeEvent =
  | { type: "tool.dispatch"; call: ToolCall; readOnly: boolean; status: "queued" | "running" }
```

但 model-visible history 仍只来自：

- `user.message`;
- `assistant.message`;
- `tool.result`。

规则：

- `tool.call` 在执行前按 provider order 发出。
- `tool.result` 按 provider order 持久化。
- 文件写入结果必须能通过 transcript 解释：哪个 tool、哪个 path、成功/失败、
  diff summary。

## 10. Testing Strategy

Phase 1 必须把测试作为设计的一部分。不要一次性堆完再测。

### 10.1 Phase 0 Regression Gate

现有 Phase 0 测试必须继续通过：

- loop kernel；
- session wrapper；
- transcript replay；
- abort；
- maxSteps；
- active turn guard。

当前基线：

```text
bun run test      # 89 pass
bun run typecheck # pass
```

### 10.2 Workspace Boundary Unit Tests

必须覆盖：

- relative path inside workspace allowed；
- `../outside` denied；
- absolute outside denied；
- absolute inside allowed and displayed relative；
- symlink to outside denied for read and write；
- new file path through symlink ancestor denied；
- `.env` / private key / credentials hard denied；
- `glob` does not follow symlink dirs。

### 10.3 Tool Unit Tests

每个工具用 temp workspace 测。

`read`:

- line numbers；
- offset/limit；
- missing file；
- binary/too large；
- output cap marker。

`grep`:

- finds matches；
- invalid regex；
- max result cap；
- path boundary。

`glob`:

- stable sorted output；
- default ignored dirs；
- max result cap；
- symlink dir not followed。

`edit`:

- unique replace writes and returns diff；
- missing oldText fails without writing；
- duplicate oldText fails without writing；
- outside/sensitive path fails without writing。

`write`:

- creates new file；
- existing file without overwrite fails；
- overwrite true writes and returns diff；
- parent creation stays inside workspace。

`apply_patch`:

- valid add/update/delete；
- malformed patch fails no write；
- conflict fails no write；
- multi-file validation failure writes nothing；
- path outside workspace writes nothing。

### 10.4 ToolRuntime Tests

必须覆盖：

- unknown tool -> exactly one error result；
- invalid input -> exactly one error result；
- tool exception -> exactly one error result；
- results returned in provider order；
- all read-only batch can run concurrently but returns ordered results；
- any writer forces serial execution；
- abort during runtime produces paired abort results；
- output truncation preserves valid UTF-8 and includes marker。

### 10.5 Integration Tests

用 `FakeProvider + real ToolRuntime + temp workspace`：

- `read -> assistant final answer`；
- `read -> edit -> next model step`；
- `grep/glob -> read -> edit`；
- `apply_patch malformed -> error result -> model can continue`；
- transcript replay reconstructs valid provider messages；
- tool.result transcript write failure does not leave unpaired assistant call。

### 10.6 Support Surface Tests

- provider mock SSE: text delta、tool call delta、multiple interleaved tool calls、
  malformed JSON sentinel。
- root `AGENTS.md` missing/oversized cases。
- context builder injects prefix before projected history。
- `-p` smoke with fake/mock provider，不依赖真实网络。

## 11. 建议实现顺序

不要一次性实现所有东西。

1. `ToolRegistry` + schema export。
2. `ToolRuntime` skeleton：unknown tool、invalid input、exception-to-result、
   result ordering。
3. `WorkspacePathBoundary` + tests。
4. `WorkspaceFs` + read/write safety primitives。
5. `read`、`glob`、`grep`。
6. `edit` exact replace + diff。
7. `write` with overwrite semantics。
8. `apply_patch` parser/apply/atomic validation。
9. read-only batch concurrency / writer serial tests。
10. `FakeProvider + real ToolRuntime` integration tests。
11. OpenAI-compatible provider adapter。
12. root `AGENTS.md` minimal context prefix。
13. `-p` CLI smoke。
14. End-to-end transcript replay checks。

每一步都应保持 `bun run test` 和 `bun run typecheck` 通过。

## 12. Done Criteria

Phase 1 完成时必须满足：

- `bun run test` pass，包括 Phase 0 regression 和 Phase 1 tests。
- `bun run typecheck` pass。
- 真正的 `ToolRuntime` 替代 fake runtime 用于 Phase 1 路径。
- `read`、`grep`、`glob`、`edit`、`write`、`apply_patch` 注册并导出 schema。
- 文件工具全部受 workspace boundary 和 sensitive path deny 保护。
- writer 工具失败场景不写入。
- read-only batch / writer serial 语义有测试锁定。
- 用 `FakeProvider + real ToolRuntime + temp workspace` 可完成：搜索文件 -> 读取文件 ->
  修改一处代码 -> transcript 展示 tool call/result/diff。
- OpenAI-compatible provider、root `AGENTS.md` minimal context prefix、`-p` smoke
  已有测试覆盖。

Phase 1 不要求 deep context engineering、REPL、bash 或测试命令执行。

## 13. Phase 2 Handoff

Phase 1 结束后，Phase 2 第一批工作应接：

- 真正的 `ContextAssembler` 模块；
- `SessionEngine` owns context assembly，`AgentSession` 不再手搓 `AGENTS.md` prefix；
- stable system prompt / runtime facts / project context / tool schema source 分层；
- prompt/cache stability；
- context snapshot / provider request replay/debug；
- Phase 4 memory/git/compact 和 Phase 5 skills/MCP 的 context source 插槽。

Phase 2 不需要重新实现 Phase 1 已有的 minimal provider/context/CLI；它负责把
Context Engineering 变成清晰、可扩展、可 replay/debug 的独立模块。
