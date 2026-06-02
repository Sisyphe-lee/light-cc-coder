import { describe, expect, test } from "bun:test"
import { OpenAICompatibleProvider } from "../../src/providers/openaiCompatible"
import { isInvalidToolInput } from "../../src/tools/ToolRuntime"
import { collectAsync } from "../helpers"

describe("OpenAICompatibleProvider", () => {
  test("streams text deltas and final assistant message", async () => {
    const provider = providerWithSse([
      chunk({ choices: [{ delta: { content: "hel" } }] }),
      chunk({ choices: [{ delta: { content: "lo" } }] }),
      "data: [DONE]\n\n",
    ])

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))

    expect(events.filter((event) => event.type === "text_delta").map((event) => (event.type === "text_delta" ? event.text : ""))).toEqual(["hel", "lo"])
    expect(events.at(-1)).toMatchObject({ type: "assistant_message" })
    const final = events.at(-1)
    expect(final?.type === "assistant_message" ? final.message.content : "").toBe("hello")
  })

  test("aggregates fragmented interleaved tool arguments by index", async () => {
    const provider = providerWithSse([
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: "c2", function: { name: "write", arguments: "{\"path\"" } },
                { index: 0, id: "c1", function: { name: "read", arguments: "{\"path\":\"a" } },
              ],
            },
          },
        ],
      }),
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: ".txt\"}" } },
                { index: 1, function: { arguments: ":\"b.txt\",\"content\":\"x\"}" } },
              ],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ])

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))
    const final = events.at(-1)
    expect(final?.type).toBe("assistant_message")
    if (final?.type !== "assistant_message") throw new Error("expected final assistant")

    expect(final.message.toolCalls.map((call) => call.id)).toEqual(["c1", "c2"])
    expect(final.message.toolCalls.map((call) => call.name)).toEqual(["read", "write"])
    expect(final.message.toolCalls[0]?.input).toEqual({ path: "a.txt" })
    expect(final.message.toolCalls[1]?.input).toEqual({ path: "b.txt", content: "x" })
  })

  test("malformed JSON arguments become invalid input sentinel", async () => {
    const provider = providerWithSse([
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{" } }] } }] }),
      "data: [DONE]\n\n",
    ])

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))
    const final = events.at(-1)
    expect(final?.type).toBe("assistant_message")
    if (final?.type !== "assistant_message") throw new Error("expected final assistant")
    expect(isInvalidToolInput(final.message.toolCalls[0]?.input)).toBe(true)
  })

  test("skips non-JSON data lines instead of crashing the stream", async () => {
    const provider = providerWithSse([
      chunk({ choices: [{ delta: { content: "hel" } }] }),
      "data: keepalive-not-json\n\n",
      chunk({ choices: [{ delta: { content: "lo" } }] }),
      "data: [DONE]\n\n",
    ])

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))

    const final = events.at(-1)
    expect(final?.type).toBe("assistant_message")
    if (final?.type !== "assistant_message") throw new Error("expected final assistant")
    expect(final.message.content).toBe("hello")
  })

  test("does not request stream_options or surface usage by default", async () => {
    const bodies: string[] = []
    const provider = providerWithSse(
      [chunk({ choices: [{ delta: { content: "ok" } }] }), chunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }), "data: [DONE]\n\n"],
      { captureBody: (body) => bodies.push(body) },
    )

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))

    expect(bodies[0]).not.toContain("stream_options")
    expect(events.some((event) => event.type === "usage")).toBe(false)
  })

  test("opt-in includeUsage adds stream_options and surfaces bounded usage counters", async () => {
    const bodies: string[] = []
    const provider = providerWithSse(
      [
        chunk({ choices: [{ delta: { content: "ok" } }] }),
        chunk({
          choices: [],
          usage: { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234, prompt_tokens_details: { cached_tokens: 1000 } },
        }),
        "data: [DONE]\n\n",
      ],
      { includeUsage: true, captureBody: (body) => bodies.push(body) },
    )

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))

    expect(JSON.parse(bodies[0]).stream_options).toEqual({ include_usage: true })
    const usageEvent = events.find((event) => event.type === "usage")
    expect(usageEvent?.type === "usage" ? usageEvent.usage : undefined).toEqual({
      inputTokens: 1200,
      outputTokens: 34,
      totalTokens: 1234,
      cacheReadInputTokens: 1000,
    })
    // Usage is surfaced before the final assistant message.
    expect(events.at(-1)?.type).toBe("assistant_message")
  })

  test("HTTP error before final assistant rejects", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.invalid",
      apiKey: "key",
      model: "model",
      fetch: async () => new Response("bad", { status: 500 }),
    })

    await expect(collectAsync(provider.stream({ messages: [] }, new AbortController().signal))).rejects.toThrow("500")
  })
})

function providerWithSse(
  events: string[],
  options: { includeUsage?: boolean; captureBody?: (body: string) => void } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid",
    apiKey: "key",
    model: "model",
    includeUsage: options.includeUsage,
    fetch: async (_input, init) => {
      if (options.captureBody && typeof init?.body === "string") options.captureBody(init.body)
      return new Response(new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event))
          controller.close()
        },
      }))
    },
  })
}

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}
