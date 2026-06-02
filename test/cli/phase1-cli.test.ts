import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readJsonlTranscript } from "../../src/engine/transcript"
import { createTempWorkspace } from "../helpers"

describe("Phase 1 -p CLI smoke", () => {
  test("-p submits one prompt and writes transcript with fake provider", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--transcript", transcript])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok")
    expect(existsSync(transcript)).toBe(true)
    const events = await readJsonlTranscript(transcript)
    expect(events.map((event) => event.type)).toContain("user.message")
    expect(events.map((event) => event.type)).toContain("context.session")
    expect(events.map((event) => event.type)).toContain("context.step")
  })

  test("--prompt-file reads a prompt file", async () => {
    const root = await createTempWorkspace()
    const promptFile = join(root, "prompt.md")
    await writeFile(promptFile, "hello from file", "utf8")
    const transcript = join(root, "session.jsonl")
    const result = await runCli(["--prompt-file", promptFile, "--fake", "--cwd", root, "--transcript", transcript])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok")
    const events = await readJsonlTranscript(transcript)
    const user = events.find((event) => event.type === "user.message")
    expect(user?.type).toBe("user.message")
    if (user?.type !== "user.message") throw new Error("missing user.message")
    expect(user.message.content).toBe("hello from file")
  })

  test("-p and --prompt-file are mutually exclusive", async () => {
    const root = await createTempWorkspace()
    const promptFile = join(root, "prompt.md")
    const artifactDir = join(root, "artifacts")
    await writeFile(promptFile, "hello from file", "utf8")
    const result = await runCli([
      "-p",
      "inline",
      "--prompt-file",
      promptFile,
      "--fake",
      "--cwd",
      root,
      "--artifact-dir",
      artifactDir,
    ])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Use either -p or --prompt-file")
    const summary = JSON.parse(await readFile(join(artifactDir, "summary.json"), "utf8")) as { status: string; error: string }
    expect(summary.status).toBe("failed")
    expect(summary.error).toContain("Use either -p or --prompt-file")
  })

  test("--artifact-dir writes run artifacts with a default transcript", async () => {
    const root = await createTempWorkspace()
    const artifactDir = join(root, "run-artifacts")
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--artifact-dir", artifactDir])

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(artifactDir, "run.json"))).toBe(true)
    expect(existsSync(join(artifactDir, "summary.json"))).toBe(true)
    expect(existsSync(join(artifactDir, "transcript.jsonl"))).toBe(true)
    expect(existsSync(join(artifactDir, "stdout.log"))).toBe(true)
    expect(existsSync(join(artifactDir, "stderr.log"))).toBe(true)
    const summary = JSON.parse(await readFile(join(artifactDir, "summary.json"), "utf8")) as {
      status: string
      transcript: string
      events: { total: number; byType: Record<string, number> }
    }
    expect(summary.status).toBe("completed")
    expect(summary.transcript).toBe(join(artifactDir, "transcript.jsonl"))
    expect(summary.events.total).toBeGreaterThan(0)
    expect(summary.events.byType["user.message"]).toBe(1)
  })

  test("--output-json prints only a machine-readable run summary", async () => {
    const root = await createTempWorkspace()
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--output-json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const summary = JSON.parse(result.stdout) as { status: string; events: { byType: Record<string, number> } }
    expect(summary.status).toBe("completed")
    expect(summary.events.byType["assistant.message"]).toBe(1)
  })

  test("--quiet suppresses process output but artifact logs still capture it", async () => {
    const root = await createTempWorkspace()
    const artifactDir = join(root, "quiet-artifacts")
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--quiet", "--artifact-dir", artifactDir])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(await readFile(join(artifactDir, "stdout.log"), "utf8")).toContain("ok")
  })

  test("--json-events emits JSONL events without plain assistant text", async () => {
    const root = await createTempWorkspace()
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--json-events"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines.length).toBeGreaterThan(0)
    const events = lines.map((line) => JSON.parse(line) as { type: string })
    expect(events.map((event) => event.type)).toContain("assistant.message")
    expect(lines).not.toContain("ok")
  })

  test("numeric CLI options reject invalid values", async () => {
    const root = await createTempWorkspace()
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--max-steps", "nope"])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("--max-steps must be a positive integer")
  })

  test("missing provider config fails before writing a transcript", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "missing.jsonl")
    const result = await runCli(["-p", "hello", "--cwd", root, "--transcript", transcript], {
      PATH: process.env.PATH ?? "",
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Missing provider config")
    expect(existsSync(transcript)).toBe(false)
  })

  test("missing provider config writes artifact summary when requested", async () => {
    const root = await createTempWorkspace()
    const artifactDir = join(root, "provider-error")
    const result = await runCli(["-p", "hello", "--cwd", root, "--artifact-dir", artifactDir, "--output-json"], {
      PATH: process.env.PATH ?? "",
    })

    expect(result.exitCode).toBe(2)
    const printed = JSON.parse(result.stdout) as { status: string; error: string }
    expect(printed.status).toBe("failed")
    expect(printed.error).toContain("Missing provider config")
    const summary = JSON.parse(await readFile(join(artifactDir, "summary.json"), "utf8")) as { status: string; error: string }
    expect(summary.status).toBe("failed")
    expect(summary.error).toContain("Missing provider config")
  })
})

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = { ...process.env, LIGHT_CC_OS_SANDBOX: "off" },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cwdIndex = args.indexOf("--cwd")
  const lightccHome = cwdIndex >= 0 ? join(args[cwdIndex + 1], ".lightcc-test") : process.env.LIGHTCC_HOME
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env: { ...env, LIGHTCC_HOME: env.LIGHTCC_HOME ?? lightccHome },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}
