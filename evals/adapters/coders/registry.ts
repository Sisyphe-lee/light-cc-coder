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
      "-p",
      "{instruction}",
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

export const BUILT_IN_CODER_ADAPTERS = [LIGHTCC_ADAPTER] as const satisfies readonly CoderAdapter[]

export function listBuiltInCoderAdapters(): CoderAdapter[] {
  return BUILT_IN_CODER_ADAPTERS.map((adapter) => structuredClone(adapter))
}
