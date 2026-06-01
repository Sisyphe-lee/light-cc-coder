import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readJsonlTranscript } from "../../src/engine/transcript"
import { SessionStore } from "../../src/cli/sessionStore"
import { createTempWorkspace } from "../helpers"

describe("Phase 7 product shell", () => {
  test("no --transcript creates a default transcript, metadata, and index", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok")
    const sessions = await readdir(join(dataRoot, "sessions"))
    expect(sessions).toHaveLength(1)
    const sessionDir = join(dataRoot, "sessions", sessions[0])
    expect(existsSync(join(sessionDir, "transcript.jsonl"))).toBe(true)
    expect(existsSync(join(sessionDir, "metadata.json"))).toBe(true)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(true)
    const metadata = JSON.parse(await readFile(join(sessionDir, "metadata.json"), "utf8")) as { cwd: string; lastUserPromptPreview: string }
    expect(metadata.cwd).toBe(root)
    expect(metadata.lastUserPromptPreview).toBe("hello")
  })

  test("package exposes installable Node bin aliases", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      private?: boolean
      files?: string[]
      scripts?: Record<string, string>
      bin: Record<string, string>
    }
    expect(pkg.private).toBeUndefined()
    expect(pkg.files).toContain("dist")
    expect(pkg.bin.lightcc).toBe("dist/main.js")
    expect(pkg.bin["light-cc"]).toBe("dist/main.js")
    expect(pkg.bin["light-cc-coder"]).toBe("dist/main.js")
    expect(pkg.scripts?.build).toBe("node scripts/build-dist.mjs")
    expect(await readFile("scripts/build-dist.mjs", "utf8")).toContain("--target=node")
  })

  test("--help renders usage without creating a session", async () => {
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["--help"], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: lightcc [-p "prompt"] [options]')
    expect(result.stdout).toContain("lightcc doctor [options]")
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
  })

  test("dry-run writes no default session transcript", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["--dry-run", "-p", "hello", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Dry run only")
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
  })

  test("doctor reports blocked missing provider config and writes no transcript", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["doctor", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("blocked")
    expect(result.stdout).toContain("provider.apiKey")
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
  })

  test("REPL accepts multiple prompts in one session", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["--repl", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }), "one\ntwo\n/exit\n")

    expect(result.exitCode).toBe(0)
    expect(result.stdout.match(/ok/g)?.length).toBe(2)
    const sessions = await readdir(join(dataRoot, "sessions"))
    expect(sessions).toHaveLength(1)
    const events = await readJsonlTranscript(join(dataRoot, "sessions", sessions[0], "transcript.jsonl"))
    const userMessages = events.filter((event) => event.type === "user.message")
    expect(userMessages.map((event) => event.message.content)).toEqual(["one", "two"])
    expect(new Set(userMessages.map((event) => event.sessionId)).size).toBe(1)
  })

  test("slash diagnostics do not append user.message in the REPL", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["--repl", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }), "/status\n/exit\n")

    expect(result.exitCode).toBe(0)
    const sessions = await readdir(join(dataRoot, "sessions"))
    const events = await readJsonlTranscript(join(dataRoot, "sessions", sessions[0], "transcript.jsonl"))
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(0)
    expect(events.some((event) => event.type === "command.output" && event.command === "status")).toBe(true)
  })

  test("resume rejects malformed transcripts", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const sessionDir = join(dataRoot, "sessions", "bad")
    await mkdir(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, "transcript.jsonl")
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        seq: 0,
        timestamp: "2026-06-01T00:00:00.000Z",
        sessionId: "bad",
        type: "tool.result",
        turnId: "turn_1",
        stepId: "step_1",
        result: { id: "r1", role: "tool", toolCallId: "missing", toolName: "bash", content: "orphan", isError: false },
      })}\n`,
      "utf8",
    )
    const metadata = {
      id: "bad",
      cwd: root,
      model: "fake",
      provider: "fake",
      permissionMode: "workspace-write",
      transcriptPath,
      startedAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }
    await writeFile(join(sessionDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8")
    await writeFile(join(dataRoot, "session_index.jsonl"), `${JSON.stringify(metadata)}\n`, "utf8")

    const result = await runCli(["resume", "bad", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Orphan tool result")
  })

  test("resume rejects a session from a different cwd", async () => {
    const root = await createTempWorkspace()
    const other = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const first = await runCli(["-p", "hello", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))
    expect(first.exitCode).toBe(0)
    const [id] = await readdir(join(dataRoot, "sessions"))

    const result = await runCli(["resume", id, "--fake", "--cwd", other], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("belongs to")
  })

  test("resume from a compacted transcript restores the pairing-safe active history", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const sessionDir = join(dataRoot, "sessions", "compacted")
    await mkdir(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, "transcript.jsonl")
    const events = [
      event(0, "compacted", { type: "session.started", cwd: root }),
      event(1, "compacted", { type: "turn.started", turnId: "turn_1" }),
      event(2, "compacted", { type: "user.message", turnId: "turn_1", message: { id: "u1", role: "user", content: "old" } }),
      event(3, "compacted", {
        type: "assistant.message",
        turnId: "turn_1",
        stepId: "step_1",
        message: { id: "a1", role: "assistant", content: "old answer", toolCalls: [] },
      }),
      event(4, "compacted", { type: "turn.ended", turnId: "turn_1", reason: "completed" }),
      event(5, "compacted", {
        type: "compact.started",
        compactId: "compact_1",
        trigger: "manual",
        preCompactMessageCount: 2,
        estimatedTokens: 20,
      }),
      event(6, "compacted", {
        type: "compact.ended",
        compactId: "compact_1",
        trigger: "manual",
        status: "succeeded",
        summaryMessage: { id: "compact_1_summary", role: "user", content: "Summary of old work." },
        summaryHash: "hash",
        summarizedMessageCount: 2,
        keptMessageCount: 0,
        preCompactEstimatedTokens: 20,
        postCompactEstimatedTokens: 5,
        omittedOldestGroups: 0,
      }),
      event(7, "compacted", { type: "turn.started", turnId: "turn_2" }),
      event(8, "compacted", { type: "user.message", turnId: "turn_2", message: { id: "u2", role: "user", content: "new" } }),
      event(9, "compacted", {
        type: "assistant.message",
        turnId: "turn_2",
        stepId: "step_2",
        message: { id: "a2", role: "assistant", content: "new answer", toolCalls: [] },
      }),
      event(10, "compacted", { type: "turn.ended", turnId: "turn_2", reason: "completed" }),
    ]
    await writeFile(transcriptPath, events.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8")
    const metadata = {
      id: "compacted",
      cwd: root,
      model: "fake",
      provider: "fake",
      permissionMode: "workspace-write",
      transcriptPath,
      startedAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }
    await writeFile(join(sessionDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, "utf8")
    await writeFile(join(dataRoot, "session_index.jsonl"), `${JSON.stringify(metadata)}\n`, "utf8")

    const resume = await new SessionStore(dataRoot).resolveResume({ id: "compacted" }, root)

    expect(resume.messages.map((message) => message.id)).toEqual(["compact_1_summary", "u2", "a2"])
  })
})

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== undefined) {
    proc.stdin?.write(stdin)
    proc.stdin?.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function cleanEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: `/home/cyli/.bun/bin:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    NO_PROXY: "127.0.0.1,localhost",
    ...extra,
  }
  for (const key of [
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_API_KEY",
    "LIGHT_CC_BASE_URL",
    "LIGHT_CC_MODEL",
    "LIGHT_CC_API_KEY_ENV",
    "LIGHT_CC_TRANSCRIPT",
    "LIGHT_CC_MAX_STEPS",
    "LIGHT_CC_MAX_CONTEXT_TOKENS",
    "LIGHT_CC_COMPACT_THRESHOLD",
    "LIGHT_CC_MCP_CONFIG",
    "LIGHT_CC_SKILLS",
  ]) {
    env[key] = undefined
  }
  return env
}

function event(seq: number, sessionId: string, draft: Record<string, unknown>) {
  return {
    seq,
    timestamp: "2026-06-01T00:00:00.000Z",
    sessionId,
    ...draft,
  }
}
