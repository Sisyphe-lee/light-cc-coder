# Unified Eval Result

`results/` 定义跨 coder、跨 benchmark 的统一结果 schema。

目标是让 SWE-bench、Terminal-Bench、fake-coder conformance 这些不同来源的结果最终能汇总到同一个报表中。

当前字段覆盖：

- coder id / display name
- benchmark
- task id / attempt
- pass/fail/error/skipped 状态
- duration
- transcript / patch / raw result artifact
- token usage
- estimated cost
- failure stage / reason
- reproducibility 信息，包括 adapter、安装来源、model、attempts、max steps、sandbox 设置

这个 schema 不执行任何评测，只作为输出契约和测试校验。
