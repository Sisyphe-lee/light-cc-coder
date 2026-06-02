# Eval Matrix Planner

Planner 只生成 dry-run 计划，不执行评测。

它会展开：

```text
coder x benchmark x task x model x attempt
```

并输出稳定的 `plan.json`。这个计划用于正式跑之前人工审查横评范围，避免误跑 full split、误包含 draft adapter、误扩大 attempts。

不会做的事：

- 不启动 Harbor。
- 不启动 SWE-bench evaluator。
- 不启动 coder。
- 不调用模型 API。
- 不创建 Docker 容器。

示例：

```bash
bun evals/adapters/planner/inspect.ts \
  --coder lightcc \
  --benchmark terminal-bench \
  --task terminal-bench/break-filter-js-from-html \
  --model deepseek-v4-pro \
  --attempts 1
```

默认不允许 `draft` adapter 进入计划；如需调研草案配置，必须显式传 `--allow-draft`。
