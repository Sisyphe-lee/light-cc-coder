import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildCoderCommand, loadCoderAdapter, validateCoderAdapter } from "../../evals/adapters/coders/loader"
import { listBuiltInCoderAdapters } from "../../evals/adapters/coders/registry"
import { CODER_ADAPTER_SCHEMA_VERSION } from "../../evals/adapters/coders/types"
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
      workspace: "/workspace/repo",
      artifactDir: "/logs/agent",
      transcriptPath: "/logs/agent/transcript.jsonl",
      patchPath: "/logs/agent/patch.diff",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      maxSteps: "80",
      permissionMode: "danger-full-access",
      osSandbox: "off",
      sandboxSettings: "",
    })

    expect(command.executable).toBe("lightcc")
    expect(command.args).toContain("-p")
    expect(command.args).toContain("Fix the benchmark task.")
    expect(command.args).toContain("--artifact-dir")
    expect(command.cwd).toBe("/workspace/repo")
    expect(command.env.LIGHT_CC_MODEL).toBe("deepseek-v4-pro")
    expect(command.env.LIGHT_CC_BASE_URL).toBe("https://api.deepseek.com")
    expect(command.env.LIGHT_CC_API_KEY_ENV).toBe("DEEPSEEK_API_KEY")
    expect(command.requiredEnv).toEqual(["DEEPSEEK_API_KEY"])
    expect(command.artifacts.usage).toBe("lightcc-transcript")
  })

  test("lists only safe built-in adapter ids", () => {
    const adapters = listBuiltInCoderAdapters()
    expect(adapters.length).toBeGreaterThanOrEqual(1)
    expect(adapters.map((adapter) => adapter.id)).toContain("lightcc")
    for (const adapter of adapters) {
      expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(["ready", "draft"]).toContain(adapter.status)
    }
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
