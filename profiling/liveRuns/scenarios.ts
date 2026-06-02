// Minimal named live scenarios for Stage 2 (Regime B: real provider/network).
//
// These are real prompts intended to be sent to a real provider — distinct from
// the deterministic FakeProvider scenarios in test/profiling/scenarios.ts (Regime
// A). They are intentionally tiny and dependency-free: a `--scenario <name>` is
// just a convenient, repeatable prompt. Use `--prompt-file <path>` for anything
// project-specific.

export type LiveScenario = {
  prompt: string
  description: string
  // Sensible default permission mode for the prompt; overridable on the CLI.
  permissionMode?: "read-only" | "workspace-write" | "danger-full-access"
}

export const LIVE_SCENARIOS: Record<string, LiveScenario> = {
  pong: {
    prompt: "Reply with exactly: pong",
    description: "One-turn, no-tool latency probe. Isolates startup + context + provider TTFT/stream.",
    permissionMode: "read-only",
  },
  repo_overview: {
    prompt: "Using your tools, list the top-level files in this repository and give a one-sentence summary of what it is. Do not edit anything.",
    description: "Read-only tool batch + a short answer. Exercises read-only scheduling, context reassembly, and provider streaming.",
    permissionMode: "read-only",
  },
  search_term: {
    prompt: "Search this repository for the word \"profiling\" using your tools and report which files mention it. Do not edit anything.",
    description: "grep/glob/read read-only batch + summary. Exercises runtime/bash or read tools next to provider latency.",
    permissionMode: "read-only",
  },
}

export function resolveScenario(name: string): LiveScenario | undefined {
  return LIVE_SCENARIOS[name]
}

export function scenarioNames(): string[] {
  return Object.keys(LIVE_SCENARIOS)
}
