# wrapper.profile.json 草案

`wrapper.profile.json` 记录外部 coder wrapper 的可聚合元数据。它只允许有限长度的 metadata、路径、字节数、sha256 hash 和环境变量名，不能写入 raw args、prompt、stdout、stderr、patch、diff、环境变量值或其它正文内容。

## 目标

- 让 SWE-bench / Terminal-Bench wrapper 可以声明自己产出了哪些 bounded artifacts。
- 让统一 report 可以统计 wrapper / internal / provider 三层 profile coverage。
- 保持 artifact 对调试有用，但不会把 prompt、补丁、日志正文或凭据复制进 profile JSON。

## 文件

```text
evals/wrapper-profile/
  schema/wrapper-profile.schema.json
  types.ts
  validate.ts
```

## 最小结构

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-02T00:00:00.000Z",
  "wrapper": { "id": "opencode", "runtime": "terminal-bench-installed-agent" },
  "run": { "benchmark": "terminal-bench", "runId": "run-1", "itemId": "task-id" },
  "command": {
    "executablePath": "/usr/local/bin/opencode",
    "cwd": "/workspace",
    "argCount": 8,
    "argsSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "artifacts": [
    {
      "kind": "patch",
      "path": "/logs/agent/patch.diff",
      "bytes": 1200,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ],
  "environment": {
    "requiredNames": ["OPENAI_API_KEY"],
    "forwardedNames": ["OPENAI_API_KEY"],
    "presentNames": ["OPENAI_API_KEY"],
    "missingNames": []
  },
  "process": { "exitCode": 0, "durationMs": 1234 },
  "warnings": []
}
```
