# 远程评测工作交接文档

生成时间：2026-06-02

远程机器：`4090_local`

远程项目路径：`/home/sjx/light-cc-coder`

当前主要分支：`codex/eval-harness-plan`

## 1. 项目背景

我们正在为 `light-cc-coder` 搭建一套可复现的 coder 评测环境。目标不是只跑一次分数，而是建立一个能持续比较、定位问题、复盘失败原因的评测工作流。

当前评测路线是由简单到复杂：

1. E1：给 coder 增加无头运行和 artifact 输出能力。
2. E2：用内部 deterministic self-eval 验证核心 harness 不变量。
3. E3：接入 SWE-bench Lite，用真实代码修复任务评测 coder。
4. E4：接入 Terminal-Bench 2.1，用真实终端/容器任务评测 coder。
5. E5：汇总 E2/E3/E4 artifacts，生成统一报告。
6. 下一阶段：接入其他 coder，例如 DeepSeek Reasonix、OpenHands，用相同任务、相同 API/模型设置做对照实验。

这套评测的核心原则：

- 尽量调用公开、可信、已有官方 harness 的 benchmark。
- 对外部 benchmark 只做薄适配，不重写官方评测逻辑。
- 每次运行都落 artifacts，包括 prompt、patch、summary、transcript、usage、verifier 输出。
- 失败要区分是模型解法失败、harness/adapter 问题，还是环境/网络/依赖 flake。
- API key 不能出现在命令行、Docker Compose 进程参数、日志或 artifacts 中。

## 2. 当前仓库和分支状态

远程项目是当前事实来源，路径：

```bash
cd /home/sjx/light-cc-coder
```

当前分支：

```bash
codex/eval-harness-plan
```

近期提交：

```text
62e4cbc Add eval harness for coder benchmarks
fdc07e5 Simplify sandbox runtime installation
1bfcc2a Phase 10 dogfood smoothness
68f83a7 Polish README and session UX
af92424 Implement optional sandbox packaging and doctor
```

该分支之前已经推送到 GitHub：

```text
codex/eval-harness-plan
```

当前远程工作树里有文档类未跟踪文件：

- `evals/six-task-smoke-summary.zh-CN.md`
- `evals/handoff.zh-CN.md`

如需将这些文档纳入版本控制，接班 agent 应先确认用户是否希望提交和推送。

## 3. 远程环境

常用代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export ALL_PROXY=http://127.0.0.1:7897
```

不要在文档或日志中记录 API key。DeepSeek key 已通过环境文件方式使用，位置为：

```text
/home/sjx/.lightcc/deepseek.env
```

这个文件用于 Terminal-Bench 容器只读挂载，避免通过 Docker Compose `-e KEY=value` 将 key 暴露到进程参数。

已确认的工具链：

- Node：`v22.22.3`
- npm：`10.9.8`
- Bun：`/home/sjx/.bun/bin/bun`，版本 `1.3.14`
- Harbor：`/home/sjx/.venvs/light-cc-harbor/bin/harbor`，版本 `0.13.0`
- Docker：`29.1.3`
- Docker Compose：`2.40.3+ds1-0ubuntu1`
- Codex CLI：`/home/sjx/.local/bin/codex`，版本 `codex-cli 0.136.0`

非交互 SSH 的默认 PATH 不一定包含 Bun 和项目 CLI。建议运行命令前显式设置：

```bash
export PATH=/home/sjx/.bun/bin:/home/sjx/.local/bin:/home/sjx/.local/opt/node-v22/bin:$PATH
```

Codex CLI 已安装并通过 `codex doctor` 验证，结果为 `0 fail`。doctor 有两个 warning：

- WebSocket 连接失败，但 HTTPS fallback 可能可用。
- update probe 返回 403。

这两个 warning 暂时不影响 CLI 启动。

## 4. 代码结构和关键文件

评测相关目录：

```text
evals/
  docs.md
  docs.zh-CN.md
  status.md
  six-task-smoke-summary.zh-CN.md
  handoff.zh-CN.md
  self/
    run.ts
    README.zh-CN.md
  swebench/
    run.ts
    types.ts
    prompt.ts
    load_instances.py
    README.zh-CN.md
    fixtures/sample-instance.json
  terminal-bench/
    run.ts
    types.ts
    README.zh-CN.md
    docker-compose.host-network.yml
  terminal_bench/
    agent.py
    __init__.py
  adapters/
    coders/
    planner/
    preflight/
    results/
```

package scripts：

```json
{
  "build": "node scripts/build-dist.mjs",
  "prepare": "node scripts/build-dist.mjs",
  "test": "bun test --path-ignore-patterns='references/**' --path-ignore-patterns='sandbox-runtime/**' --path-ignore-patterns='WebRepo/**'",
  "typecheck": "tsc --noEmit",
  "eval:self": "bun evals/self/run.ts",
  "eval:swebench": "bun evals/swebench/run.ts",
  "eval:tbench": "bun evals/terminal-bench/run.ts"
}
```

已有 adapter scaffolding：

- `evals/adapters/coders/`
- `evals/adapters/planner/`
- `evals/adapters/preflight/`
- `evals/adapters/results/`

这部分是后续接入 DeepSeek Reasonix、OpenHands 等对照 coder 的自然入口。

## 5. 工作流程

### 5.1 基础验证

进入远程项目：

```bash
ssh 4090_local
cd /home/sjx/light-cc-coder
export PATH=/home/sjx/.bun/bin:/home/sjx/.local/bin:/home/sjx/.local/opt/node-v22/bin:$PATH
```

常用验证命令：

```bash
bun run typecheck
bun test test/evals/swebench-adapter.test.ts
bun test test/evals/terminal-bench-adapter.test.ts
bun run eval:self
```

### 5.2 E2 self-eval

命令：

```bash
bun run eval:self
bun run eval:self -- --fixture file-crud
bun run eval:self -- --list
```

用途：

- 用 FakeProvider + real tool runtime 验证 harness 基础行为。
- 检查 tool call/result pairing、permission denial、bash observation、compact event、transcript replay 等不变量。

当前状态：

- 10 个 deterministic fixtures 已全部通过。

### 5.3 E3 SWE-bench Lite

常用命令：

```bash
bun run eval:swebench -- --instances-file evals/swebench/fixtures/sample-instance.json --dry-run
bun run eval:swebench -- --instance sympy__sympy-20590 --dry-run
bun run eval:swebench -- --instance sympy__sympy-20590 --run-agent --max-steps 80
bun run eval:swebench -- --gold --evaluate --instance sympy__sympy-20590 --max-workers 1
bun run eval:swebench -- --preflight
```

DeepSeek agent 运行需要设置：

```bash
export LIGHT_CC_BASE_URL=https://api.deepseek.com
export LIGHT_CC_MODEL=deepseek-v4-pro
export LIGHT_CC_API_KEY_ENV=DEEPSEEK_API_KEY
```

不要把 key 写进命令。key 应来自安全环境或 env 文件。

当前 SWE-bench 关键 artifacts：

```text
.light-cc/evals/agent-smoke-sympy-20590-deepseek-v4-pro-explicit/swebench/
.light-cc/evals/batch3-swebench-lite-deepseek-v4-pro-usage/swebench/
.light-cc/evals/eval-verify-astropy-12907-bg/swebench/
.light-cc/evals/eval-verify-astropy-14182-bg/swebench/
.light-cc/evals/eval-verify-astropy-14365-bg/swebench/
logs/run_evaluation/eval-verify-astropy-12907-bg/
logs/run_evaluation/eval-verify-astropy-14182-bg/
logs/run_evaluation/eval-verify-astropy-14365-bg/
```

### 5.4 E4 Terminal-Bench 2.1

常用命令：

```bash
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --dry-run
bun run eval:tbench -- --tasks-file tasks.txt --dry-run
bun run eval:tbench -- --preflight --harbor /home/sjx/.venvs/light-cc-harbor/bin/harbor
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --run --attempts 1
```

真实运行时建议：

- 使用 `--agent-env-file /run/lightcc/deepseek.env`
- 只读挂载 `/home/sjx/.lightcc/deepseek.env` 到容器
- 如 verifier 需要 GitHub 下载依赖，使用 `--verifier-proxy http://127.0.0.1:7897`
- 如容器访问 host 代理不稳定，配合 `--extra-docker-compose evals/terminal-bench/docker-compose.host-network.yml`
- 对可能超过默认 agent timeout 的题，使用 `--agent-timeout-multiplier 2`

当前 Terminal-Bench 关键 artifacts：

```text
.light-cc/evals/tbench-smoke-break-filter-js-deepseek-current-v5/
.light-cc/evals/tbench-smoke-break-filter-js-deepseek-current-v7-proxy-timeout/
.light-cc/evals/tbench-smoke-batch3-representative-v1/terminal-bench/
```

## 6. 当前进度

### E0：骨架与文档

已完成。

已有 `evals/` 结构、英文/中文计划文档，以及阶段状态文档。

### E1：无头评测接口

已完成并通过目标验证。

新增 CLI 能力：

- `--prompt-file`
- `--artifact-dir`
- `--output-json`
- `--quiet`
- `--json-events`

artifact 输出包括：

- `run.json`
- `summary.json`
- `transcript.jsonl`
- `stdout.log`
- `stderr.log`

### E2：内部 self-eval

已完成并通过目标验证。

10 个 fixtures 全部通过：

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

### E3：SWE-bench Lite adapter

adapter 已实现。

已通过：

- adapter tests
- dry-run
- preflight 检查
- gold single-instance evaluator smoke
- DeepSeek one-shot smoke
- 单题 SWE-bench agent smoke：`sympy__sympy-20590`，官方 resolved `1/1`
- 3 题 Astropy batch patch generation
- 3 题 Astropy evaluator follow-up

当前 3 题结果：

| 题目 | agent | evaluator | 结论 |
|---|---|---|---|
| `astropy__astropy-12907` | completed，非空 patch | resolved | 通过 |
| `astropy__astropy-14182` | completed，非空 patch | unresolved | patch 应用成功，但目标测试仍失败 |
| `astropy__astropy-14365` | completed，非空 patch | unresolved | patch 应用成功，但目标测试仍失败 |

3 题 usage：

- requests：118
- input tokens：3,006,426
- output tokens：34,997
- cache-hit input tokens：2,814,976
- cache-miss input tokens：191,450
- reasoning tokens：15,885
- estimated DeepSeek cost：`$0.12393243`

### E4：Terminal-Bench 2.1 adapter

adapter 已实现。

已通过：

- adapter tests
- dry-run
- preflight
- Harbor agent import 检查
- 单题 `break-filter-js-from-html` smoke，v5/v7 曾 reward `1.0`
- 安全 env-file 方式的 3 题代表性 batch

3 题 batch 结果：

| 题目 | Harbor | verifier | 判断 |
|---|---|---|---|
| `terminal-bench/build-cython-ext` | completed | reward 0.0，10 passed / 1 failed | 部分成功，但官方验证失败 |
| `terminal-bench/break-filter-js-from-html` | completed | reward 0.0 | 本轮主要是 verifier 下载 `uv` 的网络/依赖 flake |
| `terminal-bench/bn-fit-modify` | completed | reward 0.0，6 passed / 3 failed | 明确的模型/解法失败 |

3 题 usage：

- requests：117
- input tokens：4,513,850
- output tokens：71,653
- cache-hit input tokens：4,142,848
- cache-miss input tokens：371,002
- reasoning tokens：36,763
- estimated DeepSeek cost：`$0.238742`
- wall time：约 37.2 分钟

更详细的六题复盘见：

```text
evals/six-task-smoke-summary.zh-CN.md
```

### E5：统一报告

尚未开始。

E5 应读取 E2/E3/E4 artifacts，统一输出：

- 运行配置
- 任务列表
- pass/resolved/reward
- usage/cost
- 失败类型分类
- artifact 链接
- 对照 coder 结果

## 7. 已知问题和风险

### 7.1 Terminal-Bench verifier 网络依赖不稳定

`break-filter-js-from-html` 在 batch 中失败，是因为 verifier 下载 `uv` 时出现：

```text
curl: (18) HTTP/2 stream 1 was not closed cleanly before end of the underlying stream
uvx: command not found
```

这不是干净的模型失败。应单独用稳定 proxy/host-network/依赖预热重跑。

### 7.2 `build-cython-ext` 需要复查 verifier/上游仓库状态

该题 verifier 中 10 个检查通过，1 个失败：

```text
ERROR: file or directory not found: /tmp/.../tests
```

需要确认这是 coder 没满足任务要求，还是 verifier 对上游仓库结构有不稳定假设。

### 7.3 `bn-fit-modify` 是明确能力缺口

失败包括：

- DAG edge direction 错误
- intervention DAG 缺边/边方向错误
- sampled distribution 不符合 KS 检验

这题代表当前 coder 在统计/因果建模终端任务上的明显弱点。

### 7.4 SWE-bench 局部修补倾向

`astropy__astropy-14182` 和 `astropy__astropy-14365` 都是 patch 能应用、PASS_TO_PASS 保持通过，但 FAIL_TO_PASS 没过。说明 coder 会做局部补丁，但容易漏掉目标测试真正覆盖的边界条件。

### 7.5 Linux OS sandbox 强隔离路径仍有 host 兼容问题

在 Ubuntu 26.04 host 上，默认 strong Linux seccomp 路径仍可能失败：

```text
apply-seccomp: write /proc/self/setgroups ... Permission denied
```

显式 settings 加 `network.allowAllUnixSockets=true` 的 filesystem isolation E2E 是通过的。Terminal-Bench 容器内默认使用 `--os-sandbox off`，因为 Harbor 已经提供容器隔离。

## 8. 下一步计划

### P0：把当前文档和状态收束

1. 确认是否提交 `evals/six-task-smoke-summary.zh-CN.md` 和 `evals/handoff.zh-CN.md`。
2. 如要提交，先跑：

```bash
bun run typecheck
bun test test/evals/swebench-adapter.test.ts
bun test test/evals/terminal-bench-adapter.test.ts
```

### P1：稳定 Terminal-Bench 小批量

1. 单独重跑 `terminal-bench/break-filter-js-from-html`，必须启用 verifier proxy/host-network/timeout multiplier。
2. 单独复查 `terminal-bench/build-cython-ext` 的 repository tests 路径问题。
3. 将 verifier flake 与模型失败分开记录到统一 report。

### P2：接入对照 coder

用户当前希望优先接入：

- DeepSeek Reasonix
- OpenHands

建议基于 `evals/adapters/coders/` 实现 coder adapter registry，而不是把每个 coder 的启动逻辑散落到 SWE-bench/Terminal-Bench runner 中。

每个 coder adapter 至少应定义：

- id/name/version
- install/preflight
- SWE-bench 调用方式
- Terminal-Bench 调用方式
- artifact 目录规范
- usage/cost 抽取能力
- 是否支持同一 DeepSeek API/model

第一批对照实验建议继续使用相同六题：

- SWE-bench：`astropy__astropy-12907`、`astropy__astropy-14182`、`astropy__astropy-14365`
- Terminal-Bench：`build-cython-ext`、`break-filter-js-from-html`、`bn-fit-modify`

原因：这六题已经暴露了不同类型的问题，适合快速判断其他 coder 是否也会卡在同样位置。

### P3：实现 E5 unified report

统一读取：

- E2 self-eval summary
- E3 SWE-bench summary/report/test_output
- E4 Terminal-Bench summary/result/ctrf/test-stdout
- adapter/coder metadata

输出建议：

```text
.light-cc/evals/<run_id>/report/
  report.md
  report.json
  failures.jsonl
  cost.json
```

报告中要明确区分：

- resolved/pass
- unresolved/model failure
- verifier infra flake
- harness failure
- timeout
- empty patch
- API/network failure

### P4：扩大样本

在对照 coder 跑通后，再扩大到：

- SWE-bench Lite 10-20 题
- Terminal-Bench 5-10 题

不要直接全量跑。先确认：

- Docker 空间足够
- verifier 下载稳定
- API 费用可接受
- usage/cost 记录完整
- key 不泄漏

## 9. 接班 agent 的建议启动步骤

建议接班 agent 从这里开始：

```bash
ssh 4090_local
cd /home/sjx/light-cc-coder
export PATH=/home/sjx/.bun/bin:/home/sjx/.local/bin:/home/sjx/.local/opt/node-v22/bin:$PATH
git status --short --branch
sed -n '1,260p' evals/handoff.zh-CN.md
sed -n '1,260p' evals/six-task-smoke-summary.zh-CN.md
```

然后做一次轻量验证：

```bash
bun run typecheck
bun run eval:self
bun test test/evals/swebench-adapter.test.ts
bun test test/evals/terminal-bench-adapter.test.ts
```

如果用户要求继续开发，优先顺序是：

1. 稳定/复查 Terminal-Bench 两个不干净失败。
2. 实现 DeepSeek Reasonix adapter。
3. 实现 OpenHands adapter。
4. 用同样六题跑对照实验。
5. 实现 E5 unified report。

## 10. 安全注意事项

- 不要打印、复制、提交 `/home/sjx/.lightcc/deepseek.env` 的内容。
- 不要把 API key 放进 command line、Docker Compose `env=` 参数、日志或 markdown。
- 若需要 sudo，向用户询问，不要把 sudo 密码写入文档。
- 运行 SWE-bench 或 Terminal-Bench 真题会产生 API 费用；大于 5 题前应再次确认。
- Terminal-Bench 会拉取/构建 Docker images，注意磁盘空间。
- 如果要清理 Docker 或 artifacts，先征求用户确认。
