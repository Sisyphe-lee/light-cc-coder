# Fake Coder Conformance

`fake-coder.ts` 是 adapter 协议的测试夹具，不是真实 coder，也不会进入正式横评矩阵。

它只做三件事：

- 写一份 JSONL transcript。
- 写一份 fake patch。
- 写一份符合 `UnifiedEvalResult` 的 result JSON。

用途：

- 验证 adapter 命令模板能渲染并启动。
- 验证 transcript、patch、result artifact 路径约定。
- 让未来修改 adapter schema 时有一个低成本回归测试。

它不做这些事：

- 不启动 Harbor。
- 不启动 SWE-bench。
- 不调用模型 API。
- 不修改真实 benchmark workspace。
