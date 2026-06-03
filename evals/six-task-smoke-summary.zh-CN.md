# 六题 Smoke 结果总结

生成日期：2026-06-02

本文件总结最近一轮 6 道代表题的完成情况：3 道 SWE-bench Lite 题和 3 道 Terminal-Bench 2.1 题。这里的重点不是给出最终 benchmark 成绩，而是判断 harness 是否能稳定跑通、coder 是否能产出有效 artifacts，以及失败到底发生在模型解题、官方验证器，还是基础设施。

## 总体结论

6 道题都完成了 agent 执行，没有出现 agent 长时间卡死、空 patch、API 调用失败或 Harbor/SWE-bench 运行时错误。

SWE-bench Lite 三题中，agent 都生成了非空 patch，官方 evaluator 也都能完成验证；最终 resolved 为 1/3。其中 `astropy__astropy-12907` 通过，`astropy__astropy-14182` 和 `astropy__astropy-14365` patch 能应用但未修复目标失败测试。

Terminal-Bench 三题中，Harbor 完成 3/3 trials，运行时错误为 0，但 mean reward 为 0.0。其中 `bn-fit-modify` 是明确的模型/解法失败；`break-filter-js-from-html` 在本轮 batch 中主要是 verifier 下载 `uv` 时的网络/依赖问题，不能算干净的模型失败；`build-cython-ext` 的核心功能测试大多通过，但官方 verifier 的 repository test-suite 检查失败，结果仍计为 reward 0。

## 汇总表

| 编号 | Benchmark | 题目 | 执行结果 | 官方/验证器结果 | 判断 |
|---|---|---|---|---|---|
| 1 | SWE-bench Lite | `astropy__astropy-12907` | agent 完成，非空 patch | resolved | 通过 |
| 2 | SWE-bench Lite | `astropy__astropy-14182` | agent 完成，非空 patch | unresolved | 解法未修复目标测试 |
| 3 | SWE-bench Lite | `astropy__astropy-14365` | agent 完成，非空 patch | unresolved | 解法未修复目标测试 |
| 4 | Terminal-Bench 2.1 | `terminal-bench/build-cython-ext` | agent 完成 | reward 0.0，10 passed / 1 failed | 部分成功，但官方验证失败 |
| 5 | Terminal-Bench 2.1 | `terminal-bench/break-filter-js-from-html` | agent 完成 | reward 0.0 | 本轮主要是网络/依赖 flake |
| 6 | Terminal-Bench 2.1 | `terminal-bench/bn-fit-modify` | agent 完成 | reward 0.0，6 passed / 3 failed | 明确解法失败 |

## SWE-bench Lite 三题

运行批次：

- run id：`batch3-swebench-lite-deepseek-v4-pro-usage`
- artifacts：`.light-cc/evals/batch3-swebench-lite-deepseek-v4-pro-usage/swebench/`
- dataset：`SWE-bench/SWE-bench_Lite`
- split：`test`
- revision：`69611d31007e1c6731db8bd5b5c3f2d33f5bab6e`
- agent 统计：3/3 completed，0 failed，0 empty patch
- usage：118 requests，3,006,426 input tokens，34,997 output tokens，2,814,976 cache-hit input tokens，191,450 cache-miss input tokens，15,885 reasoning tokens
- 估算成本：`$0.12393243`

### 1. `astropy__astropy-12907`

状态：通过。

agent 生成了非空 patch，修改文件为：

- `astropy/modeling/separable.py`

官方 evaluator 结果：

- `patch_successfully_applied: true`
- `resolved: true`
- FAIL_TO_PASS：2 个目标失败测试全部转为成功
- PASS_TO_PASS：13 个既有通过测试保持成功
- errors：0

结论：这是一次干净通过。coder 找到了目标位置，并且没有破坏相关回归测试。

### 2. `astropy__astropy-14182`

状态：未通过。

agent 生成了非空 patch，修改文件为：

- `astropy/io/ascii/rst.py`

官方 evaluator 结果：

- `patch_successfully_applied: true`
- `resolved: false`
- FAIL_TO_PASS 失败测试：`astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows`
- PASS_TO_PASS：9 个既有通过测试保持成功
- errors：0

失败位置：

目标测试仍然失败，错误核心是：

```text
ValueError: Column wave failed to convert: could not convert string to float: 'float64'
```

解释：patch 能应用，也没有破坏已有的 9 个 PASS_TO_PASS 测试，但没有正确处理 `RST` writer/reader 在 `header_rows` 场景下的表头/类型行位置，导致 `float64` 被当作数据内容进入 `wave` 列转换。

### 3. `astropy__astropy-14365`

状态：未通过。

agent 生成了非空 patch，修改文件为：

- `astropy/io/ascii/qdp.py`

官方 evaluator 结果：

- `patch_successfully_applied: true`
- `resolved: false`
- FAIL_TO_PASS 失败测试：`astropy/io/ascii/tests/test_qdp.py::test_roundtrip[True]`
- PASS_TO_PASS：8 个既有通过测试保持成功
- errors：0

失败位置：

目标测试仍然失败，错误核心是：

```text
ValueError: Unrecognized QDP line: 53000.123456 2.37847222222222e-05    -2.37847222222222e-05   no       0.212439
```

解释：patch 只把 `READ [TS]ERR` command regex 改成大小写不敏感，这保住了现有通过测试，但没有覆盖 roundtrip 中出现的小写 `no` 数据值解析问题。因此目标 FAIL_TO_PASS 没有转为通过。

## Terminal-Bench 三题

运行批次：

- run id：`tbench-smoke-batch3-representative-v1`
- artifacts：`.light-cc/evals/tbench-smoke-batch3-representative-v1/terminal-bench/`
- dataset：`terminal-bench/terminal-bench-2-1`
- runner：`harbor==0.13.0`
- attempts：1
- Harbor 结果：3/3 completed，0 runtime errors，mean reward 0.0
- 总耗时：约 37.2 分钟
- usage：117 requests，4,513,850 input tokens，71,653 output tokens，4,142,848 cache-hit input tokens，371,002 cache-miss input tokens，36,763 reasoning tokens
- 估算成本：`$0.238742`

### 4. `terminal-bench/build-cython-ext`

状态：失败，但不是完全失败。

Harbor/verifier 结果：

- reward：0.0
- pytest：10 passed，1 failed
- agent 执行完成
- Harbor runtime errors：0

通过的关键检查包括：

- Numpy 版本检查
- repo clone 检查
- `pyknotid` core import
- `chelpers`、`ccomplexity`、`cinvariants` Cython extension 检查
- README 示例用法检查

失败位置：

```text
FAILED test_outputs.py::test_pyknotid_repository_tests
AssertionError: Repository tests failed with return code 4
ERROR: file or directory not found: /tmp/.../tests
```

解释：coder 解决了大部分核心 Cython/Numpy 兼容问题，至少从官方 verifier 看，扩展导入和示例运行都通过了。但最终的 repository test-suite 检查在 fresh clone 的 `tests/` 路径上失败，导致 reward 仍为 0。这个失败需要进一步判断是 agent 没有满足任务里“原仓库测试仍应通过”的要求，还是该题的 verifier/上游仓库状态本身存在路径假设问题。

建议：后续可以单独重跑这题，并保留 verifier 的 clone 目录或复现 `/tmp/.../tests` 缺失问题，确认它是否是稳定的模型失败。

### 5. `terminal-bench/break-filter-js-from-html`

状态：本轮 batch 失败，但更像基础设施/网络 flake，不建议计为干净模型失败。

Harbor/verifier 结果：

- reward：0.0
- agent 执行完成
- Harbor runtime errors：0

失败位置：

verifier 在下载 `uv` 时失败：

```text
curl: (18) HTTP/2 stream 1 was not closed cleanly before end of the underlying stream
failed to download https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz
/tests/test.sh: line 10: /root/.local/bin/env: No such file or directory
/tests/test.sh: line 19: uvx: command not found
```

解释：这一题之前单题 smoke 曾经通过，Harbor 报告 reward 1.0；本轮 batch 中 verifier 甚至没有走到有效的浏览器/XSS 行为判断，而是卡在依赖下载失败后缺少 `uvx`。因此这次 batch 的 reward 0 不应直接归因于 coder 解题能力。

建议：这题应使用 verifier proxy / host-network overlay / 依赖预热后单独重跑；如果重跑通过，应从六题统计中标注为“infra flake，不计入模型失败”。

### 6. `terminal-bench/bn-fit-modify`

状态：失败，属于明确的模型/解法失败。

Harbor/verifier 结果：

- reward：0.0
- pytest：6 passed，3 failed
- agent 执行完成
- Harbor runtime errors：0

失败测试：

- `test_outputs.py::test_learned_dag_structure`
- `test_outputs.py::test_intervened__data_structure`
- `test_outputs.py::test_sampled_data`

失败位置：

learned DAG 结构不匹配：

```text
Extra items in the left set:
('M', 'R')
('D', 'Y')
Extra items in the right set:
('R', 'M')
('Y', 'D')
```

intervened DAG 结构不匹配：

```text
Extra items in the left set:
('M', 'R')
Extra items in the right set:
('R', 'M')
('Y', 'D')
```

采样分布不匹配：

```text
AssertionError: Sampled data for D does not match the expected at 99.9% confidence level
assert np.float64(0.0) >= 0.001
```

解释：输出文件存在、CSV 列名和部分结构检查通过，但 DAG 边方向存在关键错误，并且 intervention 后采样分布不符合预期。这说明 coder 在统计/因果建模任务上的推理和验证不足，是这 6 题里最明确的能力缺口。

## 对当前 coder/harness 的判断

从 harness 角度看，当前评测链路已经能证明几个重要事实：

- SWE-bench adapter 可以完成 agent patch generation，并能接官方 evaluator 得到 resolved/unresolved。
- Terminal-Bench adapter 可以通过 Harbor 跑真实 task container，并能收集 reward、verifier stdout、CTRF 测试结果和 agent artifacts。
- API key 通过 env-file 挂载后，没有再暴露在 Docker Compose 进程参数中。
- 这轮没有暴露“agent 完全卡死导致无法产出 artifacts”的问题。

从 coder 能力角度看，样本还太小，不能得出总体分数。但已有信号是：

- 对较局部的 Python bugfix，coder 能成功完成，例如 `astropy__astropy-12907`。
- 对需要理解格式细节的修复，coder 容易做出局部修补但漏掉目标测试核心路径，例如 `astropy__astropy-14182` 和 `astropy__astropy-14365`。
- 对 Terminal-Bench 的多步骤终端任务，coder 可以执行到结束并产出文件，但复杂建模/统计类任务仍有明显失败。
- 部分 Terminal-Bench 分数会被 verifier 网络依赖影响，必须先稳定基础设施再把 reward 当成模型能力信号。

## 下一步建议

1. 单独重跑 `terminal-bench/break-filter-js-from-html`，使用稳定的 verifier proxy/host-network/依赖预热，把基础设施 flake 排除掉。
2. 单独复查 `terminal-bench/build-cython-ext` 的 `tests/` 路径缺失问题，确认这是 verifier/上游仓库问题，还是 coder 没有满足 repository test-suite 要求。
3. 对 `astropy__astropy-14182` 和 `astropy__astropy-14365` 做 patch-level 复盘，把目标失败测试加入 coder 的自检样例中，观察 coder 是否能在本地运行目标测试后修正。
4. 接入 DeepSeek Reasonix 和 OpenHands 后，用同样 6 题跑一轮对照；尤其关注它们是否也在 Terminal-Bench 上遇到相同 verifier flake，以及是否能解决 `bn-fit-modify`。
