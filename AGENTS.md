# light-cc-coder 工作规则

## 最重要的上下文

这个仓库的最大参考对象是本地恢复版 Claude Code 源码树：

- `/data1/lcy/projects/ClaudeCode`

以后任何新 session 在本仓库工作时，都必须先理解这一点：我们不是从 CoreCoder、Aider、OpenHands 或其他开源项目重新发明一个普通 coding agent；我们是在 clean-room 前提下，实现一个**保留 Claude Code 核心工作方式的极轻量 TypeScript coder harness**。

主参考文档在：

- `/data1/lcy/projects/ClaudeCode/docs/harness-framework-map.md`
- `/data1/lcy/projects/ClaudeCode/docs/lightweight-cc-coder-plan.md`

本仓库当前权威计划在：

- `docs/plan.md`
- `docs/status.md` 记录当前实现状态、常用命令和下一个 phase 的 handoff。

如果后续实现中出现分歧，优先级是：

1. 本仓库 `docs/plan.md` 中已经确定的架构决策。
2. 本地 Claude Code 源码和阅读笔记中已经确认的行为模型。
3. 外部开源参考仓库中的可借鉴设计。

## 项目目标

本仓库用于 clean-room 实现一个极轻量、快速、真实可用的 TypeScript Claude Code 风格 coder harness。

目标不是教学 demo，也不是复刻完整 Claude Code 产品。第一版必须小，但不能 toy：

- 能在真实代码仓库里读文件、搜索、编辑、运行命令、验证结果。
- agent loop、tool/result pairing、session replay、权限和 context 管理必须可靠。
- 可以没有复杂 TUI、插件市场、多端同步、cron/background，但不能缺少安全边界和可观察性。

## Clean-room 边界

- `/data1/lcy/projects/ClaudeCode` 只作为参考源码和阅读笔记所在地，不在其中实现新 coder。
- 不复制恢复版 Claude Code 的源码、私有 prompt 大段文本、文件结构或实现细节。
- 可以复现公开可表达的行为模型和抽象：agent loop、tool runtime、context assembly、permission/sandbox 分层、event transcript。
- `references/repos/` 下的外部仓库只用于本地只读参考，已被 `.gitignore` 排除。Phase 9 的 `sandbox-runtime/` 是仓库根目录下明确纳入的 git submodule，不属于 `references/` 参考目录。不要从这些仓库复制代码进实现。
- 如果采用某个外部参考的设计，只在 `docs/plan.md` 中记录“我们的决策”，不要把实现计划写成“可以去看某某仓库”的开放探索。

## 已定架构

项目采用以下硬边界：

1. `AgentSession` 是核心入口，暴露 `submit(op)` 和事件流。CLI/REPL 只提交操作、消费事件，不直接改 loop 状态。
2. `runTurn` / `executeStep` 是核心 agent loop：build context -> stream model -> collect tool calls -> run tools -> append tool results -> continue。
3. `QueryEngine` / `SessionEngine` 管 session 状态、message projection、context assembly、turn lifecycle、transcript 和 resume。
4. `ToolRuntime` 做 schema validation、permission、execution、result normalization、truncation、error-to-result、并发调度。
5. `Runtime` / `Deployment` 抽象 shell/file execution。agent loop 不直接依赖本机 shell、Docker 或未来 remote runtime。
6. 权限和 sandbox 是 MVP，不是后续增强。拒绝、超时、sandbox denied 都必须作为 tool result 回灌模型。
7. JSONL event transcript 是第一版持久化基线，不只保存最终 messages。
8. MCP/skills 第一版只做薄扩展：加载、注入 prompt、注册 tool。所有扩展必须走同一套 ToolRuntime 和权限检查。

## 第一版必须做好

- tool/result pairing 永远正确。
- 文件编辑可审计、可失败、不会乱写。
- shell 有权限、超时和输出截断。
- context 不会无限膨胀。
- session 可恢复、可 replay、可 trace。
- prompt/cache 尽量稳定。
- MCP/skill 有最小扩展面，但不能绕过工具运行时和权限系统。

## 第一版不做

- 完整 TUI 或复杂 React/Ink 交互。
- 插件市场、OAuth、复杂 MCP auth。
- subagent、background job、cron、remote multi-tenant server。
- 完整 OpenHands/SWE-agent 式云执行平台。
- 自动 commit/push/PR。
- 大规模 benchmark harness。

这些可以在核心可用后再评估。

## 外部参考的定位

外部参考不是主架构来源，只用于补足设计边界：

- CoreCoder：只借极简 loop 心智模型和 exact edit，不借安全模型。
- DeepSeek-Reasonix：借 prefix-cache 友好、read-only 并发、permission/sandbox 分层。
- morlay/deepseek-harness：借中文工具 prompt 和 shell/filesystem hook 的轻量思路，不依赖 Pi runtime。
- Kimi Code：借 TypeScript loop 分层、event transcript、tool lifecycle、AbortSignal、resource-aware scheduler 方向。
- openai/codex：借 `submit(Op)+events()`、approval pending promise、tool orchestrator、apply_patch 专门路径。
- SWE-ReX：借 Runtime/Deployment 窄接口和持久 shell session；云后端后置。
- CodeWhale：借 product-grade loop/context/sandbox 的边界校验，不搬 Rust/TUI。
- OpenHarness：借 QueryEngine/context/permission 的模块切分，不搬产品层。
- Aider：后续借 repo map、SEARCH/REPLACE 编辑失败反馈、git feedback loop；不作为主架构。

## 工程方式

- 默认使用 TypeScript。运行时和包管理优先 Bun，除非后续明确切换。
- 新 session 先读 `docs/status.md`，再按需读 `docs/plan.md` 和当前 phase spec。
- 先写可测试的核心模块，再写 CLI。
- 搜索优先 `rg`。
- 测试默认使用 `bun run test`。不要裸跑会递归扫描外部参考仓库的 `bun test`；外部 repo 必须通过脚本或参数排除。
- 设计变更先更新 `docs/plan.md`，再改代码。
- 不把 `references/repos/` 的普通参考仓库内容纳入 git；仓库根目录下的 `sandbox-runtime/` 只以 submodule gitlink 形式纳入。
- 不在 `/data1/lcy/projects/ClaudeCode` 中实现新 coder。

## 验收标准

一个 phase 完成必须至少满足：

- 有针对核心不变量的单元测试或集成测试。
- 可以通过 JSONL transcript 解释一次 turn 发生了什么。
- 工具失败和权限拒绝能回灌给模型。
- 不破坏 workspace 写边界。
- 文档中的 phase 状态和实际代码一致。
