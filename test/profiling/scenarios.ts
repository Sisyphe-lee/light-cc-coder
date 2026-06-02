import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import type { ContextBudgetInput } from "../../src/context/contextBudget"
import type { PermissionMode } from "../../src/permissions/types"
import { FakeProvider, type FakeProviderStep } from "../../src/providers/FakeProvider"
import { LocalRuntime } from "../../src/runtime/LocalRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { RealToolRuntime, type ToolRuntime } from "../../src/tools/ToolRuntime"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { summarizeProfile } from "../../profiling/report/summarize"
import type { ProfileReport } from "../../profiling/report/types"
import { assistant, call, createTempWorkspace, MemoryTranscriptSink } from "../helpers"

// Deterministic Stage 1 scenarios (Regime A: FakeProvider profiling). These are a
// developer-only regression guard, NOT a benchmark. Each scenario pins the model
// output with FakeProvider, runs against a fixed fixture with profiling enabled,
// and produces a ProfileReport through the existing Stage 0 reducer. These runners
// live in test/ — profiling/ never depends on them, and src/ runtime never imports
// any of this.
//
// Span timings use a deterministic counter clock (each now() call increments by 1),
// so the report SHAPE is reproducible. Real bash/runtime durations stay tiny (well
// below the comparator's minComparableMs floor), so they never gate. This matches
// spec/phase-8-stage-1.md §8: deterministic model output does not make fsync, shell
// startup, or profiler overhead deterministic, so the comparator uses coarse
// thresholds rather than ms-level assertions.

export function counterClock(): () => number {
  let value = 0
  return () => (value += 1)
}

// Diagnostic-only scenario metadata (spec §4). It is NOT part of the stable
// ProfileReport schema; it just helps a developer interpret a comparison.
export type ScenarioMeta = {
  scenario: string
  platform: string
  bunVersion: string | null
  nodeVersion: string | null
  osSandboxActive: boolean
}

export type ScenarioResult = {
  name: string
  events: SessionEvent[]
  report: ProfileReport
  meta: ScenarioMeta
  workspaceRoot?: string
}

function scenarioMeta(scenario: string): ScenarioMeta {
  const versions = process.versions as Record<string, string | undefined>
  return {
    scenario,
    platform: process.platform,
    bunVersion: versions.bun ?? null,
    nodeVersion: versions.node ?? null,
    osSandboxActive: false,
  }
}

type RunOptions = {
  name: string
  cwd: string
  steps: FakeProviderStep[]
  toolRuntime: ToolRuntime
  userMessages: string[]
  contextBudget?: ContextBudgetInput
  compactTailMessages?: number
  workspaceRoot?: string
}

async function runProfiledSession(options: RunOptions): Promise<ScenarioResult> {
  const transcript = new MemoryTranscriptSink()
  const provider = new FakeProvider({ steps: options.steps })
  const session = await AgentSession.create({
    id: `stage1_${options.name}`,
    cwd: options.cwd,
    provider,
    toolRuntime: options.toolRuntime,
    transcript,
    profile: true,
    profilerNow: counterClock(),
    compactTailMessages: options.compactTailMessages,
    contextBudget: options.contextBudget,
    now: () => "2026-06-02T00:00:00.000Z",
  })
  for (const content of options.userMessages) {
    await session.submit({ type: "user_message", content })
  }
  await session.close()
  const events = transcript.events as SessionEvent[]
  const report = summarizeProfile(events as unknown as Record<string, unknown>[], {
    sourceTranscript: `${options.name}.jsonl`,
    generatedAt: "",
  })
  return { name: options.name, events, report, meta: scenarioMeta(options.name), workspaceRoot: options.workspaceRoot }
}

// 3.1 startup_noop — one user turn, final answer with no tool calls. Covers session
// startup, context assembly, the provider adapter, and transcript writes.
export async function runStartupNoop(): Promise<ScenarioResult> {
  return runProfiledSession({
    name: "startup_noop",
    cwd: "/workspace",
    steps: [{ message: assistant("a1", "Nothing to do; here is a summary.") }],
    toolRuntime: new FakeToolRuntime(),
    userMessages: ["summarize the repository layout"],
  })
}

// 3.2 readonly_search_batch — one assistant step calls glob + grep + read in the
// same step (read-only batch), then a final answer. Covers read-only batch
// scheduling, per-tool execution, context reassembly, and transcript overhead.
export async function runReadonlySearchBatch(): Promise<ScenarioResult> {
  const root = await createTempWorkspace("light-cc-stage1-search-")
  await writeFile(join(root, "alpha.txt"), "hello alpha\nNEEDLE lives here\n")
  await writeFile(join(root, "beta.txt"), "beta content only\n")
  await mkdir(join(root, "sub"), { recursive: true })
  await writeFile(join(root, "sub", "gamma.txt"), "gamma also has a NEEDLE\n")
  const workspace = await WorkspaceFs.create(root)
  const toolRuntime = new RealToolRuntime({
    registry: createBuiltinToolRegistry(),
    workspace,
    permissionMode: "read-only",
  })
  return runProfiledSession({
    name: "readonly_search_batch",
    cwd: workspace.root,
    steps: [
      {
        message: assistant("a1", "searching the workspace", [
          call("c1", "glob", { pattern: "**/*.txt" }),
          call("c2", "grep", { pattern: "NEEDLE" }),
          call("c3", "read", { path: "alpha.txt" }),
        ]),
      },
      { message: assistant("a2", "found NEEDLE in alpha.txt and sub/gamma.txt") },
    ],
    toolRuntime,
    userMessages: ["find NEEDLE across the text files"],
    workspaceRoot: root,
  })
}

// 3.3 edit_verify — one writer tool (edit), then one verification bash command.
// Covers writer serialization, workspace file safety, the bash/runtime summary, and
// result normalization. Uses danger-full-access so the deterministic path needs no
// interactive approval (approval lifecycle is covered by the Stage 0 tests).
export async function runEditVerify(): Promise<ScenarioResult> {
  const root = await createTempWorkspace("light-cc-stage1-edit-")
  await writeFile(join(root, "config.txt"), "name = demo\nVERSION = 1\n")
  const workspace = await WorkspaceFs.create(root)
  const runtime = await LocalRuntime.create({ workspaceRoot: workspace.root, initialCwd: workspace.root })
  const toolRuntime = new RealToolRuntime({
    registry: createBuiltinToolRegistry(),
    workspace,
    runtime,
    permissionMode: "danger-full-access",
  })
  return runProfiledSession({
    name: "edit_verify",
    cwd: workspace.root,
    steps: [
      {
        message: assistant("a1", "applying the edit", [
          call("c1", "edit", { path: "config.txt", oldText: "VERSION = 1", newText: "VERSION = 2" }),
        ]),
      },
      {
        message: assistant("a2", "verifying the edit", [
          call("c2", "bash", { command: "grep -q 'VERSION = 2' config.txt", description: "verify edit applied" }),
        ]),
      },
      { message: assistant("a3", "edit applied and verified") },
    ],
    toolRuntime,
    userMessages: ["bump VERSION to 2 and verify"],
    workspaceRoot: root,
  })
}

// 3.4 auto_compact — a low context threshold plus a large prior answer forces auto
// compaction. FakeProvider returns the compact summary, then the final answer for
// the original turn. Covers compact.run, compact.provider_summary, pre/post token
// estimates, the compact checkpoint write, and context with an active compact slot.
export async function runAutoCompact(): Promise<ScenarioResult> {
  return runProfiledSession({
    name: "auto_compact",
    cwd: "/workspace",
    steps: [
      { message: assistant("a1", "large prior answer ".repeat(80)) },
      { message: assistant("compact_sum", "Summary: prior work and constraints captured.") },
      { message: assistant("a2", "final answer after compaction") },
    ],
    toolRuntime: new FakeToolRuntime(),
    userMessages: ["first question", "second question that crosses the threshold"],
    contextBudget: { maxContextTokens: 1_000, hardCompactTokens: 120, blockingTokens: 10_000 },
    compactTailMessages: 1,
  })
}

export const STAGE1_SCENARIOS: { name: string; run: () => Promise<ScenarioResult> }[] = [
  { name: "startup_noop", run: runStartupNoop },
  { name: "readonly_search_batch", run: runReadonlySearchBatch },
  { name: "edit_verify", run: runEditVerify },
  { name: "auto_compact", run: runAutoCompact },
]
