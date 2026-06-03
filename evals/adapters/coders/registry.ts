import { CODER_ADAPTER_SCHEMA_VERSION, type CoderAdapter } from "./types"

export const LIGHTCC_ADAPTER: CoderAdapter = {
  schemaVersion: CODER_ADAPTER_SCHEMA_VERSION,
  id: "lightcc",
  displayName: "Light CC Coder",
  status: "ready",
  targets: ["swebench", "terminal-bench"],
  install: {
    kind: "source",
    package: "source:{workspace}",
    notes: [
      "For unpublished-branch smoke runs, mount the repository and point package to source:<container-path>.",
      "For reproducible leaderboard runs, prefer a pinned npm tarball or image digest.",
    ],
  },
  command: {
    executable: "lightcc",
    args: [
      "--prompt-file",
      "{promptFile}",
      "--permission-mode",
      "{permissionMode}",
      "--max-steps",
      "{maxSteps}",
      "--artifact-dir",
      "{artifactDir}",
      "--transcript",
      "{transcriptPath}",
      "--quiet",
    ],
    cwd: "{workspace}",
    env: {
      LIGHT_CC_MODEL: "{model}",
      LIGHT_CC_BASE_URL: "{baseUrl}",
      LIGHT_CC_API_KEY_ENV: "{apiKeyEnv}",
      LIGHT_CC_TBENCH_OS_SANDBOX: "{osSandbox}",
      LIGHT_CC_TBENCH_SANDBOX_SETTINGS: "{sandboxSettings}",
    },
    requiredEnv: ["{apiKeyEnv}"],
  },
  artifacts: {
    transcript: "{transcriptPath}",
    patch: "{patchPath}",
    usage: "lightcc-transcript",
  },
  metadata: {
    notes: ["Current default adapter used by the E3/E4 smoke work."],
  },
}

export const OPENHANDS_ADAPTER: CoderAdapter = {
  schemaVersion: CODER_ADAPTER_SCHEMA_VERSION,
  id: "openhands",
  displayName: "OpenHands",
  status: "ready",
  targets: ["swebench", "terminal-bench"],
  install: {
    kind: "custom",
    package: "openhands",
    commands: ["uv tool install openhands --python 3.12"],
    notes: [
      "Ready for local headless SWE-bench agent runs after the 2026-06-02 DeepSeek V4 Flash conformance smoke.",
      "Terminal-Bench real Harbor runs still require a verified installed-agent wrapper before comparative scoring.",
      "OpenHands CLI also supports binary and Docker installs; pin an install source before comparative runs.",
    ],
  },
  command: {
    executable: "openhands",
    args: ["--headless", "--json", "--file", "{promptFile}", "--override-with-envs"],
    cwd: "{workspace}",
    env: {
      LLM_MODEL: "openai/{model}",
      LLM_BASE_URL: "{baseUrl}",
    },
    requiredEnv: ["LLM_API_KEY"],
  },
  artifacts: {
    transcript: "{transcriptPath}",
    patch: "{patchPath}",
    usage: "none",
  },
  metadata: {
    homepage: "https://www.openhands.dev/",
    docs: "https://docs.openhands.dev/openhands/usage/cli/headless",
    notes: [
      "Official headless CLI requires --task or --file; this adapter uses --file so runners can write benchmark prompts without shell quoting.",
      "Official --json mode streams JSONL to stdout; runners should capture stdout into transcriptPath.",
      "OpenHands reads LLM_API_KEY, LLM_MODEL, and LLM_BASE_URL with --override-with-envs.",
      "The adapter renders LLM_MODEL as openai/{model} so LiteLLM uses the DeepSeek OpenAI-compatible base URL.",
    ],
  },
}

export const AIDER_ADAPTER: CoderAdapter = {
  schemaVersion: CODER_ADAPTER_SCHEMA_VERSION,
  id: "aider",
  displayName: "Aider CLI",
  status: "ready",
  targets: ["swebench", "terminal-bench"],
  install: {
    kind: "pipx",
    package: "aider-chat",
    notes: [
      "Ready for local headless SWE-bench agent runs after the 2026-06-02 DeepSeek V4 Flash conformance smoke.",
      "Terminal-Bench real Harbor runs still require a verified installed-agent wrapper before comparative scoring.",
      "Pin aider-chat to an exact version before comparative runs.",
    ],
  },
  command: {
    executable: "aider",
    args: [
      "--yes-always",
      "--no-pretty",
      "--no-stream",
      "--no-auto-commits",
      "--no-check-update",
      "--model",
      "deepseek/{model}",
      "--openai-api-base",
      "{baseUrl}",
      "--message-file",
      "{promptFile}",
    ],
    cwd: "{workspace}",
    env: {
      AIDER_ANALYTICS_DISABLE: "true",
      AIDER_LLM_HISTORY_FILE: "{transcriptPath}",
      AIDER_OPENAI_API_BASE: "{baseUrl}",
      DEEPSEEK_API_BASE: "{baseUrl}",
    },
    requiredEnv: ["{apiKeyEnv}"],
  },
  artifacts: {
    transcript: "{transcriptPath}",
    patch: "{patchPath}",
    usage: "none",
  },
  metadata: {
    homepage: "https://aider.chat/",
    docs: "https://aider.chat/docs/scripting.html",
    notes: [
      "Official scripting mode supports --message-file, which sends one prompt, applies edits, and exits.",
      "This DeepSeek-first draft expects model to be the bare DeepSeek model id, rendered as deepseek/{model}.",
      "Use apiKeyEnv=DEEPSEEK_API_KEY for DeepSeek V4 Flash; the adapter never stores key material.",
      "Aider writes LLM history to transcriptPath; runners should still capture stdout/stderr during smoke verification.",
    ],
  },
}

export const OPENCODE_ADAPTER: CoderAdapter = {
  schemaVersion: CODER_ADAPTER_SCHEMA_VERSION,
  id: "opencode",
  displayName: "OpenCode",
  status: "ready",
  targets: ["swebench", "terminal-bench"],
  install: {
    kind: "npm",
    package: "opencode-ai",
    notes: [
      "Ready for local headless SWE-bench agent runs after the 2026-06-02 DeepSeek V4 Flash conformance smoke.",
      "Terminal-Bench real Harbor runs still require a verified installed-agent wrapper before comparative scoring.",
      "Pin opencode-ai to an exact version or image digest before comparative runs.",
    ],
  },
  command: {
    executable: "opencode",
    args: [
      "run",
      "--format",
      "json",
      "--model",
      "deepseek/{model}",
      "--dir",
      "{workspace}",
      "--file",
      "{promptFile}",
      "--dangerously-skip-permissions",
      "Execute the benchmark instructions from the attached prompt file.",
    ],
    cwd: "{workspace}",
    env: {
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CONFIG_CONTENT:
        "{\"$schema\":\"https://opencode.ai/config.json\",\"model\":\"deepseek/{model}\",\"small_model\":\"deepseek/{model}\",\"provider\":{\"deepseek\":{\"options\":{\"apiKey\":\"{env:{apiKeyEnv}}\",\"baseURL\":\"{baseUrl}\"}}},\"enabled_providers\":[\"deepseek\"]}",
    },
    requiredEnv: ["{apiKeyEnv}"],
  },
  artifacts: {
    transcript: "{transcriptPath}",
    patch: "{patchPath}",
    usage: "none",
  },
  metadata: {
    homepage: "https://opencode.ai/",
    docs: "https://opencode.ai/docs/cli",
    notes: [
      "Official run mode is non-interactive and accepts a message directly; this draft attaches promptFile with --file to avoid shell interpolation.",
      "Official --format json should stream raw JSON events to stdout; runners should capture stdout into transcriptPath.",
      "OPENCODE_CONFIG_CONTENT safely supplies DeepSeek model/baseURL/apiKey env references without writing secrets to disk.",
      "The permission skip flag is only acceptable inside benchmark isolation and remains draft until smoke verified.",
    ],
  },
}

export const DEEPSEEK_REASONIX_ADAPTER: CoderAdapter = {
  schemaVersion: CODER_ADAPTER_SCHEMA_VERSION,
  id: "deepseek-reasonix",
  displayName: "DeepSeek Reasonix",
  status: "draft",
  targets: ["swebench", "terminal-bench"],
  install: {
    kind: "npm",
    package: "reasonix",
    notes: [
      "Draft only. DeepSeek documents Reasonix as a terminal coding agent; do not include in benchmark runs until the headless path is verified.",
    ],
  },
  command: {
    executable: "reasonix",
    args: ["run", "{instruction}"],
    cwd: "{workspace}",
    requiredEnv: ["DEEPSEEK_API_KEY"],
  },
  artifacts: {
    patch: "{patchPath}",
    usage: "none",
  },
  metadata: {
    homepage: "https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix",
    docs: "https://github.com/esengine/DeepSeek-Reasonix/blob/v1/docs/CLI-REFERENCE.md",
    blocked: true,
    blockers: [
      "Headless benchmark contract is not verified locally.",
      "Confirm noninteractive auth/config, prompt ingestion, patch capture, transcript format, exit-code semantics, and model override behavior before promotion.",
    ],
    notes: [
      "Reasonix documentation lists `reasonix run <task>` as the CI-friendly headless path.",
      "DeepSeek documentation says Reasonix defaults to DeepSeek-V4-Flash; keep model-control verification in the readiness smoke.",
      "Keep this adapter out of the first-batch ready set until the headless contract is proven inside benchmark containers.",
    ],
  },
}

export const BUILT_IN_CODER_ADAPTERS = [
  LIGHTCC_ADAPTER,
  OPENHANDS_ADAPTER,
  AIDER_ADAPTER,
  OPENCODE_ADAPTER,
  DEEPSEEK_REASONIX_ADAPTER,
] as const satisfies readonly CoderAdapter[]

export function listBuiltInCoderAdapters(): CoderAdapter[] {
  return BUILT_IN_CODER_ADAPTERS.map((adapter) => structuredClone(adapter))
}
