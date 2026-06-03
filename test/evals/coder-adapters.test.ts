import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildCoderCommand, loadCoderAdapter, validateCoderAdapter } from "../../evals/adapters/coders/loader"
import { listBuiltInCoderAdapters } from "../../evals/adapters/coders/registry"
import { CODER_ADAPTER_PLACEHOLDERS, CODER_ADAPTER_SCHEMA_VERSION } from "../../evals/adapters/coders/types"
import { createTempWorkspace } from "../helpers"

describe("coder adapter registry", () => {
  test("loads built-in lightcc adapter and renders a headless command", async () => {
    const adapter = await loadCoderAdapter("lightcc")
    expect(adapter.schemaVersion).toBe(CODER_ADAPTER_SCHEMA_VERSION)
    expect(adapter.id).toBe("lightcc")
    expect(adapter.status).toBe("ready")
    expect(adapter.targets).toContain("swebench")
    expect(adapter.targets).toContain("terminal-bench")

    const command = buildCoderCommand(adapter, {
      instruction: "Fix the benchmark task.",
      promptFile: "/logs/agent/prompt.md",
      workspace: "/workspace/repo",
      artifactDir: "/logs/agent",
      transcriptPath: "/logs/agent/transcript.jsonl",
      patchPath: "/logs/agent/patch.diff",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      maxSteps: "80",
      permissionMode: "danger-full-access",
      osSandbox: "off",
      sandboxSettings: "",
    })

    expect(command.executable).toBe("lightcc")
    expect(command.args).toContain("--prompt-file")
    expect(command.args).toContain("/logs/agent/prompt.md")
    expect(command.args).toContain("--artifact-dir")
    expect(command.cwd).toBe("/workspace/repo")
    expect(command.env.LIGHT_CC_MODEL).toBe("deepseek-v4-flash")
    expect(command.env.LIGHT_CC_BASE_URL).toBe("https://api.deepseek.com")
    expect(command.env.LIGHT_CC_API_KEY_ENV).toBe("DEEPSEEK_API_KEY")
    expect(command.requiredEnv).toEqual(["DEEPSEEK_API_KEY"])
    expect(command.artifacts.usage).toBe("lightcc-transcript")
  })

  test("lists first-batch built-in adapter ids as ready while reasonix remains draft", () => {
    const adapters = listBuiltInCoderAdapters()
    const ids = adapters.map((adapter) => adapter.id)
    const firstBatchIds = ids.filter((id) => ["lightcc", "openhands", "aider", "opencode"].includes(id))
    const readyIds = adapters.filter((adapter) => adapter.status === "ready").map((adapter) => adapter.id)
    expect(adapters.length).toBeGreaterThanOrEqual(1)
    expect(firstBatchIds).toEqual(["lightcc", "openhands", "aider", "opencode"])
    expect(ids).toContain("deepseek-reasonix")
    expect(readyIds).toEqual(["lightcc", "openhands", "aider", "opencode"])
    for (const adapter of adapters) {
      expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(["ready", "draft"]).toContain(adapter.status)
    }
  })

  test("renders built-in openhands as a ready JSONL file-based command", async () => {
    expect(CODER_ADAPTER_PLACEHOLDERS).toContain("promptFile")
    const adapter = await loadCoderAdapter("openhands")
    expect(adapter.status).toBe("ready")

    const command = buildCoderCommand(adapter, {
      promptFile: "/logs/agent/prompt.txt",
      workspace: "/workspace/repo",
      artifactDir: "/logs/agent",
      transcriptPath: "/logs/agent/transcript.jsonl",
      patchPath: "/logs/agent/patch.diff",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
    })

    expect(command.executable).toBe("openhands")
    expect(command.args).toEqual([
      "--headless",
      "--json",
      "--file",
      "/logs/agent/prompt.txt",
      "--override-with-envs",
    ])
    expect(command.cwd).toBe("/workspace/repo")
    expect(command.env.LLM_MODEL).toBe("openai/deepseek-v4-flash")
    expect(command.env.LLM_BASE_URL).toBe("https://api.deepseek.com")
    expect(command.requiredEnv).toEqual(["LLM_API_KEY"])
    expect(command.artifacts.transcript).toBe("/logs/agent/transcript.jsonl")
    expect(command.artifacts.patch).toBe("/logs/agent/patch.diff")
  })

  test("renders built-in aider as a ready prompt-file command for DeepSeek", async () => {
    const adapter = await loadCoderAdapter("aider")
    expect(adapter.status).toBe("ready")

    const command = buildCoderCommand(adapter, {
      promptFile: "/logs/agent/prompt.md",
      workspace: "/workspace/repo",
      artifactDir: "/logs/agent",
      transcriptPath: "/logs/agent/aider.llm.history.md",
      patchPath: "/logs/agent/patch.diff",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    })

    expect(command.executable).toBe("aider")
    expect(command.args).toEqual([
      "--yes-always",
      "--no-pretty",
      "--no-stream",
      "--no-auto-commits",
      "--no-check-update",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--openai-api-base",
      "https://api.deepseek.com",
      "--message-file",
      "/logs/agent/prompt.md",
    ])
    expect(command.cwd).toBe("/workspace/repo")
    expect(command.env.AIDER_ANALYTICS_DISABLE).toBe("true")
    expect(command.env.AIDER_LLM_HISTORY_FILE).toBe("/logs/agent/aider.llm.history.md")
    expect(command.requiredEnv).toEqual(["DEEPSEEK_API_KEY"])
    expect(command.artifacts.transcript).toBe("/logs/agent/aider.llm.history.md")
    expect(command.artifacts.patch).toBe("/logs/agent/patch.diff")
  })

  test("renders built-in opencode as a ready JSON prompt-file command for DeepSeek", async () => {
    const adapter = await loadCoderAdapter("opencode")
    expect(adapter.status).toBe("ready")

    const command = buildCoderCommand(adapter, {
      promptFile: "/logs/agent/prompt.md",
      workspace: "/workspace/repo",
      artifactDir: "/logs/agent",
      transcriptPath: "/logs/agent/transcript.jsonl",
      patchPath: "/logs/agent/patch.diff",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    })
    const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT)

    expect(command.executable).toBe("opencode")
    expect(command.args).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--dir",
      "/workspace/repo",
      "--file",
      "/logs/agent/prompt.md",
      "--dangerously-skip-permissions",
      "Execute the benchmark instructions from the attached prompt file.",
    ])
    expect(command.cwd).toBe("/workspace/repo")
    expect(command.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true")
    expect(config.model).toBe("deepseek/deepseek-v4-flash")
    expect(config.small_model).toBe("deepseek/deepseek-v4-flash")
    expect(config.provider.deepseek.options.apiKey).toBe("{env:DEEPSEEK_API_KEY}")
    expect(config.provider.deepseek.options.baseURL).toBe("https://api.deepseek.com")
    expect(config.enabled_providers).toEqual(["deepseek"])
    expect(command.requiredEnv).toEqual(["DEEPSEEK_API_KEY"])
    expect(command.artifacts.transcript).toBe("/logs/agent/transcript.jsonl")
    expect(command.artifacts.patch).toBe("/logs/agent/patch.diff")
  })

  test("marks deepseek reasonix as blocked until headless contract verification", async () => {
    const adapter = await loadCoderAdapter("deepseek-reasonix")
    expect(adapter.status).toBe("draft")
    expect(adapter.metadata?.blocked).toBe(true)
    expect(adapter.metadata?.blockers?.join(" ")).toContain("Headless benchmark contract is not verified")

    const command = buildCoderCommand(adapter, {
      instruction: "Fix the benchmark task.",
      workspace: "/workspace/repo",
      patchPath: "/logs/agent/patch.diff",
    })
    expect(command.executable).toBe("reasonix")
    expect(command.args).toEqual(["run", "Fix the benchmark task."])
    expect(command.requiredEnv).toEqual(["DEEPSEEK_API_KEY"])
  })

  test("loads an external JSON adapter without executing it", async () => {
    const root = await createTempWorkspace()
    const adapterPath = join(root, "custom-coder.json")
    await writeFile(
      adapterPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "custom-coder",
          displayName: "Custom Coder",
          status: "draft",
          targets: ["terminal-bench"],
          install: { kind: "custom" },
          command: {
            executable: "custom-coder",
            args: ["run", "--prompt", "{instruction}", "--workspace", "{workspace}"],
            env: { CUSTOM_MODEL: "{model}" },
            requiredEnv: ["{apiKeyEnv}"],
          },
          artifacts: { patch: "{patchPath}", usage: "none" },
        },
        null,
        2,
      ),
      "utf8",
    )

    const adapter = await loadCoderAdapter(adapterPath)
    const command = buildCoderCommand(adapter, {
      instruction: "Do it",
      workspace: "/work",
      model: "model-x",
      apiKeyEnv: "CUSTOM_API_KEY",
      patchPath: "/logs/patch.diff",
    })

    expect(command.executable).toBe("custom-coder")
    expect(command.args).toEqual(["run", "--prompt", "Do it", "--workspace", "/work"])
    expect(command.env.CUSTOM_MODEL).toBe("model-x")
    expect(command.requiredEnv).toEqual(["CUSTOM_API_KEY"])
    expect(command.artifacts.patch).toBe("/logs/patch.diff")
  })

  test("rejects unsafe ids, unknown targets, and literal secrets", () => {
    const validBase = {
      schemaVersion: 1,
      id: "bad",
      displayName: "Bad",
      status: "draft",
      targets: ["swebench"],
      install: { kind: "none" },
      command: { executable: "bad", args: [] },
    }

    expect(() => validateCoderAdapter({ ...validBase, id: "../bad" })).toThrow("id is invalid")
    expect(() => validateCoderAdapter({ ...validBase, targets: ["unknown"] })).toThrow("invalid target")
    expect(() =>
      validateCoderAdapter({
        ...validBase,
        command: {
          executable: "bad",
          args: [],
          env: { OPENAI_API_KEY: "sk-do-not-store-this" },
        },
      }),
    ).toThrow("must reference an env var or template placeholder")
  })

  test("fails fast on missing template variables", async () => {
    const adapter = await loadCoderAdapter("lightcc")
    expect(() =>
      buildCoderCommand(adapter, {
        instruction: "Fix it",
        workspace: "/work",
      }),
    ).toThrow("Missing template variable")
  })
})
