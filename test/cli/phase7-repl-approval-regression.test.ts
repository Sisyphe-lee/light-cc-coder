import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { Writable } from "node:stream"
import { readJsonlTranscript } from "../../src/engine/transcript"
import { ApprovalPrompt } from "../../src/cli/approvalPrompt"
import { createTempWorkspace } from "../helpers"

type ChatRequest = {
  messages?: Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: unknown[] }>
}

describe("Phase 7 REPL and approval regressions", () => {
  test("approval prompt cancellation returns aborted instead of consuming a stale answer", async () => {
    const prompt = new ApprovalPrompt(process.stdin, silentStream(), async () => undefined)

    const decision = await prompt.ask(
      {
        seq: 0,
        timestamp: "2026-06-01T00:00:00.000Z",
        sessionId: "s1",
        type: "approval.requested",
        turnId: "turn_1",
        stepId: "step_1",
        approvalId: "approval_1",
        toolCallId: "call_1",
        toolName: "bash",
        subject: "echo ok",
        reason: "approval required",
      },
      process.cwd(),
    )

    expect(decision).toBe("aborted")
  })

  test("REPL sends multiple prompts through one session history and keeps slash commands out of provider requests", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const server = await createSequentialTextServer(["first", "second"])
    try {
      const result = await runCli(
        providerArgs(server.baseUrl, ["--repl", "--cwd", root]),
        cleanEnv({ LIGHTCC_HOME: dataRoot, LIGHT_CC_TEST_API_KEY: "test-key" }),
        "one\n/status\ntwo\n/exit\n",
      )

      expect(result.exitCode).toBe(0)
      expect(server.requests).toHaveLength(2)
      expect(flatMessageText(server.requests[0])).toContain("one")
      expect(flatMessageText(server.requests[1])).toContain("one")
      expect(flatMessageText(server.requests[1])).toContain("first")
      expect(flatMessageText(server.requests[1])).toContain("two")
      expect(flatMessageText(server.requests[0])).not.toContain("/status")
      expect(flatMessageText(server.requests[1])).not.toContain("/status")

      const events = await readOnlySessionTranscript(dataRoot)
      expect(events.filter((event) => event.type === "user.message").map((event) => event.message.content)).toEqual([
        "one",
        "two",
      ])
      expect(events.some((event) => event.type === "command.output" && event.command === "status")).toBe(true)
    } finally {
      await server.close()
    }
  })

  test.each(["/quit", "/exit"])("%s exits as host control without a model-visible prompt", async (command) => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["--repl", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }), `${command}\n`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Exiting.")
    const events = await readOnlySessionTranscript(dataRoot)
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(0)
    expect(events.some((event) => event.type === "command.output" && event.hostAction === "quit")).toBe(true)
  })

  test("idle EOF exits the REPL cleanly without submitting a user turn", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const result = await runCli(["--repl", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }), "")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("lightcc session")
    const events = await readOnlySessionTranscript(dataRoot)
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(0)
    expect(events.some((event) => event.type === "turn.started")).toBe(false)
  })

  test("slash /resume refuses sessions recorded from a different cwd", async () => {
    const root = await createTempWorkspace()
    const other = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const first = await runCli(["-p", "seed", "--fake", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))
    expect(first.exitCode).toBe(0)
    const [sessionId] = await readdir(join(dataRoot, "sessions"))

    const result = await runCli(
      ["--repl", "--fake", "--cwd", other],
      cleanEnv({ LIGHTCC_HOME: dataRoot }),
      `/resume ${sessionId}\n`,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("belongs to")
  })

  test.each([
    { answer: "y", decision: "allow" as const, fileName: "approved.txt", shouldExist: true },
    { answer: "n", decision: "deny" as const, fileName: "denied.txt", shouldExist: false },
  ])("REPL approval $decision yields exactly one paired tool result", async ({ answer, decision, fileName, shouldExist }) => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const command = `touch ${fileName}`
    const server = await createToolThenFinalServer(command)
    try {
      const result = await runCli(
        providerArgs(server.baseUrl, ["--repl", "--cwd", root, "--max-steps", "3"]),
        cleanEnv({ LIGHTCC_HOME: dataRoot, LIGHT_CC_TEST_API_KEY: "test-key" }),
        `please run it\n${answer}\n/exit\n`,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("approval.requested bash")
      expect(result.stdout).toContain("done")
      expect(existsSync(join(root, fileName))).toBe(shouldExist)

      const events = await readOnlySessionTranscript(dataRoot)
      const toolCalls = events.filter((event) => event.type === "tool.call")
      const toolResults = events.filter((event) => event.type === "tool.result")
      expect(toolCalls).toHaveLength(1)
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].result.toolCallId).toBe(toolCalls[0].call.id)
      expect(toolResults[0].result.toolName).toBe(toolCalls[0].call.name)
      expect(events.filter((event) => event.type === "approval.responded" && event.decision === decision)).toHaveLength(1)
      expect(events.filter((event) => event.type === "bash.observation")).toHaveLength(shouldExist ? 1 : 0)

      expect(server.requests).toHaveLength(2)
      const secondRequestToolMessages = server.requests[1].messages?.filter((message) => message.role === "tool") ?? []
      expect(secondRequestToolMessages).toHaveLength(1)
      expect(secondRequestToolMessages[0].tool_call_id).toBe("call_bash")
    } finally {
      await server.close()
    }
  })
})

async function readOnlySessionTranscript(dataRoot: string) {
  const sessions = await readdir(join(dataRoot, "sessions"))
  expect(sessions).toHaveLength(1)
  return readJsonlTranscript(join(dataRoot, "sessions", sessions[0], "transcript.jsonl"))
}

async function createSequentialTextServer(
  responses: string[],
): Promise<{ baseUrl: string; requests: ChatRequest[]; close: () => Promise<void> }> {
  let requestCount = 0
  return createMockServer(async (body, res) => {
    requestCount += 1
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(chunk({ choices: [{ delta: { content: responses[requestCount - 1] ?? "ok" } }] }))
    res.write("data: [DONE]\n\n")
    res.end()
  })
}

async function createToolThenFinalServer(
  command: string,
): Promise<{ baseUrl: string; requests: ChatRequest[]; close: () => Promise<void> }> {
  let requestCount = 0
  return createMockServer(async (_body, res) => {
    requestCount += 1
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (requestCount === 1) {
      res.write(
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
      )
    } else {
      res.write(chunk({ choices: [{ delta: { content: "done" } }] }))
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
}

async function createMockServer(
  respond: (body: ChatRequest, res: ServerResponse) => Promise<void>,
): Promise<{ baseUrl: string; requests: ChatRequest[]; close: () => Promise<void> }> {
  const requests: ChatRequest[] = []
  const server = createServer(async (req, res) => {
    try {
      const body = (await readRequestJson(req)) as ChatRequest
      requests.push(body)
      await respond(body, res)
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

function readRequestJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => {
      text += String(chunk)
    })
    req.on("error", reject)
    req.on("end", () => resolve(text.length > 0 ? JSON.parse(text) : {}))
  })
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

function flatMessageText(request: ChatRequest): string {
  return (request.messages ?? []).map((message) => message.content ?? "").join("\n")
}

function providerArgs(baseUrl: string, args: string[]): string[] {
  return [
    ...args,
    "--base-url",
    baseUrl,
    "--model",
    "mock-model",
    "--api-key-env",
    "LIGHT_CC_TEST_API_KEY",
  ]
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
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

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, 8_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
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

function silentStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}
