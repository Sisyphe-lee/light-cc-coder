import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { readJsonlTranscript } from "../../src/engine/transcript"
import { createTempWorkspace } from "../helpers"

describe("Phase 3 CLI approval prompt", () => {
  test("workspace-write prompts for bash approval and allows y", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const server = await createToolThenFinalServer("touch approved.txt")
    try {
      const result = await runCliWithProvider(server.baseUrl, root, transcript, "y\n")

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("approval.requested bash")
      expect(result.stderr).toContain("Allow this tool call? [y/N]")
      expect(result.stdout).toContain("done")
      expect(existsSync(join(root, "approved.txt"))).toBe(true)
      const events = await readJsonlTranscript(transcript)
      expect(events.some((event) => event.type === "approval.responded" && event.decision === "allow")).toBe(true)
      expect(events.some((event) => event.type === "bash.observation")).toBe(true)
    } finally {
      await server.close()
    }
  })

  test("workspace-write prompt denies n and does not execute bash", async () => {
    const root = await createTempWorkspace()
    const transcript = join(root, "session.jsonl")
    const server = await createToolThenFinalServer("touch denied.txt")
    try {
      const result = await runCliWithProvider(server.baseUrl, root, transcript, "n\n")

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("approval.requested bash")
      expect(result.stderr).toContain("tool.result bash error")
      expect(existsSync(join(root, "denied.txt"))).toBe(false)
      const events = await readJsonlTranscript(transcript)
      expect(events.some((event) => event.type === "approval.responded" && event.decision === "deny")).toBe(true)
      expect(events.some((event) => event.type === "bash.observation")).toBe(false)
    } finally {
      await server.close()
    }
  })
})

async function createToolThenFinalServer(command: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let requestCount = 0
  const server = createServer((_req, res) => {
    requestCount += 1
    const events =
      requestCount === 1
        ? [
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_bash",
                        function: { name: "bash", arguments: JSON.stringify({ command }) },
                      },
                    ],
                  },
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]
        : [chunk({ choices: [{ delta: { content: "done" } }] }), "data: [DONE]\n\n"]
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of events) res.write(event)
    res.end()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

async function runCliWithProvider(
  baseUrl: string,
  cwd: string,
  transcript: string,
  stdin: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      "src/cli/main.ts",
      "-p",
      "run the requested command",
      "--cwd",
      cwd,
      "--base-url",
      baseUrl,
      "--model",
      "mock-model",
      "--api-key-env",
      "LIGHT_CC_TEST_API_KEY",
      "--transcript",
      transcript,
      "--max-steps",
      "3",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LIGHT_CC_TEST_API_KEY: "test-key", NO_PROXY: "127.0.0.1,localhost" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  child.stdin.end(stdin)
  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(child.stdout),
    streamToText(child.stderr),
    new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
  ])
  return { exitCode, stdout, stderr }
}

function streamToText(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      text += chunk
    })
    stream.on("error", reject)
    stream.on("end", () => resolve(text))
  })
}
