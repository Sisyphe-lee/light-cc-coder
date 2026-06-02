# External Coder Draft Adapters

这里放外部 coder 的 draft adapter JSON。

重要边界：

- 这些配置默认 `status: "draft"`。
- draft adapter 不应该进入正式横评。
- 命令参数未经过真实 smoke 验证前，只能用于 planner / preflight / 人工审查。
- 配置里不能保存 API key、token、password。

某个外部 coder 经过真实 smoke 后，可以复制到内置 registry 或保留 JSON 并把 `status` 升级为 `ready`，同时补充固定安装来源和版本。
