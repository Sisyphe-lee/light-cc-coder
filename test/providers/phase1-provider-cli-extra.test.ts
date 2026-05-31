import { describe, expect, test } from "bun:test"
import { AgentSession } from "../../src/core/AgentSession"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { OpenAICompatibleProvider } from "../../src/providers/openaiCompatible"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, collectAsync, createTempWorkspace } from "../helpers"

describe("Phase 1 provider, CLI, and AGENTS extra coverage", () => {
  test("OpenAI-compatible provider reads SSE split across byte boundaries", async () => {
    const payload = [
      chunk({ choices: [{ delta: { content: "he🙂" } }] }),
      chunk({ choices: [{ delta: { content: "llo" } }] }),
      "data: [DONE]\n\n",
    ].join("")
    const emojiOffset = byteLength(payload.slice(0, payload.indexOf("🙂")))
    const provider = providerWithByteChunks(payload, [
      1,
      emojiOffset + 1,
      emojiOffset + 3,
      byteLength(payload) - 2,
      byteLength(payload),
    ])

    const events = await collectAsync(provider.stream({ messages: [], stepId: "s1" }, new AbortController().signal))

    expect(events.filter((event) => event.type === "text_delta").map((event) => (event.type === "text_delta" ? event.text : ""))).toEqual([
      "he🙂",
      "llo",
    ])
    const final = events.at(-1)
    expect(final?.type).toBe("assistant_message")
    expect(final?.type === "assistant_message" ? final.message.content : "").toBe("he🙂llo")
  })

  test("OpenAI-compatible provider error SSE payload rejects before final assistant", async () => {
    const provider = providerWithSse([
      chunk({ choices: [{ delta: { content: "partial" } }] }),
      chunk({ error: { message: "provider exploded" } }),
      "data: [DONE]\n\n",
    ])
    const seen: unknown[] = []

    await expect((async () => {
      for await (const event of provider.stream({ messages: [], stepId: "s1" }, new AbortController().signal)) {
        seen.push(event)
      }
    })()).rejects.toThrow("provider exploded")

    expect(seen).toEqual([{ type: "text_delta", text: "partial" }])
  })

  test("malformed provider tool args reach RealToolRuntime as invalid_input", async () => {
    const root = await createTempWorkspace()
    const provider = providerWithSseResponses([
      [chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{" } }] } }] }), "data: [DONE]\n\n"],
      [chunk({ choices: [{ delta: { content: "continued" } }] }), "data: [DONE]\n\n"],
    ])
    const workspace = await WorkspaceFs.create(root)
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
      maxSteps: 2,
    })

    await session.submit({ type: "user_message", content: "read malformed args" })
    await session.close()

    const messages = session.getMessages()
    const toolResult = messages.find((message) => message.role === "tool")
    expect(toolResult).toMatchObject({ role: "tool", toolCallId: "c1", toolName: "read", isError: true })
    expect(toolResult?.role === "tool" ? toolResult.content : "").toContain("Error (invalid_input): Malformed JSON arguments:")
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "continued" })
  })

  test("CLI --max-steps with --fake exits successfully", async () => {
    const root = await createTempWorkspace()
    const result = await runCli(["-p", "hello", "--fake", "--cwd", root, "--max-steps", "1"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok")
    expect(result.stderr).toBe("")
  })

  test("CLI unknown argument exits 2", async () => {
    const result = await runCli(["-p", "hello", "--fake", "--definitely-unknown"])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Unknown argument: --definitely-unknown")
  })

  test("missing AGENTS.md does not add a project context section", async () => {
    const root = await createTempWorkspace()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const workspace = await WorkspaceFs.create(root)
    const session = await AgentSession.create({
      cwd: root,
      provider,
      toolRuntime: new RealToolRuntime({ registry: createBuiltinToolRegistry(), workspace }),
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    const firstMessage = provider.requests[0]?.messages[0]
    expect(firstMessage).toMatchObject({ role: "system" })
    expect(firstMessage?.content).toContain("Workspace root")
    expect(firstMessage?.content).not.toContain("Root AGENTS.md")
  })
})

function providerWithSse(events: string[]): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid",
    apiKey: "key",
    model: "model",
    fetch: async () => responseFromStrings(events),
  })
}

function providerWithSseResponses(responses: string[][]): OpenAICompatibleProvider {
  let next = 0
  return new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      const events = responses[next]
      next += 1
      if (!events) throw new Error("unexpected provider request")
      return responseFromStrings(events)
    },
  })
}

function providerWithByteChunks(payload: string, boundaries: number[]): OpenAICompatibleProvider {
  const bytes = new TextEncoder().encode(payload)
  const chunks: Uint8Array[] = []
  let start = 0
  for (const boundary of boundaries) {
    if (boundary > start) chunks.push(bytes.slice(start, boundary))
    start = boundary
  }
  if (start < bytes.byteLength) chunks.push(bytes.slice(start))

  return new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid",
    apiKey: "key",
    model: "model",
    fetch: async () =>
      new Response(new ReadableStream({
        start(controller) {
          for (const item of chunks) controller.enqueue(item)
          controller.close()
        },
      })),
  })
}

function responseFromStrings(events: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  }))
}

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env: process.env,
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
