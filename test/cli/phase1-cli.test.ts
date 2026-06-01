import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
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
})

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = { ...process.env, LIGHT_CC_OS_SANDBOX: "off" },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env,
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
