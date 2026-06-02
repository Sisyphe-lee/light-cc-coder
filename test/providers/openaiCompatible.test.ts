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

  test("requests and records streaming token usage", async () => {
    let requestBody: Record<string, unknown> | undefined
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.invalid",
      apiKey: "key",
      model: "model",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: "done" } }] })))
            controller.enqueue(
              new TextEncoder().encode(
                chunk({
                  choices: [],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                    prompt_cache_hit_tokens: 95,
                    prompt_cache_miss_tokens: 5,
                    completion_tokens_details: { reasoning_tokens: 12 },
                  },
                }),
              ),
            )
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          },
        }))
      },
    })

    const events = await collectAsync(provider.stream({ messages: [], stepId: "step1" }, new AbortController().signal))
    const final = events.at(-1)

    expect(requestBody?.stream_options).toEqual({ include_usage: true })
    expect(final?.type).toBe("assistant_message")
    if (final?.type !== "assistant_message") throw new Error("expected final assistant")
    expect(final.message.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      promptCacheHitTokens: 95,
      promptCacheMissTokens: 5,
      reasoningTokens: 12,
    })
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

function providerWithSse(events: string[]): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid",
    apiKey: "key",
    model: "model",
    fetch: async () =>
      new Response(new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event))
          controller.close()
        },
      })),
  })
}

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}
