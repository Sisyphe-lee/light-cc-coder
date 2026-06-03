import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { parseArgs, startProviderProxy } from "../../evals/provider-proxy/run"
import { createTempWorkspace } from "../helpers"

describe("metadata-only provider proxy", () => {
  test("forwards OpenAI-compatible streaming requests and records only bounded metadata", async () => {
    const out = await createTempWorkspace("light-cc-provider-proxy-")
    const upstreamPort = await getFreePort()
    const proxyPort = await getFreePort()
    const upstreamRequests: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: upstreamPort,
      async fetch(request) {
        const body = JSON.parse(await request.text()) as Record<string, unknown>
        upstreamRequests.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          body,
        })

        return new Response(sseStream([
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "SECRET_RESPONSE_TOKEN" } }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          },
        ]), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })

    const proxy = await startProviderProxy({
      listenHost: "127.0.0.1",
      port: proxyPort,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKeyEnv: "PROVIDER_PROXY_TEST_KEY",
      out,
      model: "override-model",
      env: { PROVIDER_PROXY_TEST_KEY: "SECRET_UPSTREAM_KEY" },
    })

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer SECRET_CLIENT_KEY",
        },
        body: JSON.stringify({
          model: "client-model",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "SECRET_PROMPT_TEXT" }],
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain("SECRET_RESPONSE_TOKEN")
      expect(upstreamRequests).toHaveLength(1)
      expect(upstreamRequests[0]).toMatchObject({
        path: "/v1/chat/completions",
        auth: "Bearer SECRET_UPSTREAM_KEY",
      })
      expect(upstreamRequests[0]?.body.model).toBe("override-model")
      expect(JSON.stringify(upstreamRequests[0]?.body)).toContain("SECRET_PROMPT_TEXT")

      const profileText = await readFile(join(out, "provider.profile.json"), "utf8")
      expect(profileText).not.toContain("SECRET_PROMPT_TEXT")
      expect(profileText).not.toContain("SECRET_RESPONSE_TOKEN")
      expect(profileText).not.toContain("SECRET_CLIENT_KEY")
      expect(profileText).not.toContain("SECRET_UPSTREAM_KEY")

      const profile = JSON.parse(profileText) as Record<string, any>
      expect(profile.privacy).toEqual({
        prompt: "not_recorded",
        response: "not_recorded",
        apiKey: "not_recorded",
      })
      expect(profile.totals).toMatchObject({
        requestCount: 1,
        successCount: 1,
        errorCount: 0,
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          cacheReadInputTokens: 3,
          reasoningTokens: 2,
        },
        cost: {
          estimatedUsd: null,
          currency: "USD",
          source: "not_configured",
        },
      })

      const request = profile.requests[0]
      expect(request).toMatchObject({
        method: "POST",
        path: "/v1/chat/completions",
        status: 200,
        streaming: true,
        model: "override-model",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          cacheReadInputTokens: 3,
          reasoningTokens: 2,
        },
        error: null,
        retry: { attempts: 0, retryable: false },
        cost: { estimatedUsd: null, currency: "USD", source: "not_configured" },
      })
      expect(request.latencyMs).toBeGreaterThanOrEqual(0)
      expect(request.firstTokenMs).toBeGreaterThanOrEqual(0)
    } finally {
      await proxy.stop()
      upstream.stop(true)
    }
  })

  test("records upstream error and retry metadata without storing error response bodies", async () => {
    const out = await createTempWorkspace("light-cc-provider-proxy-error-")
    const upstreamPort = await getFreePort()
    const proxyPort = await getFreePort()
    const upstreamPaths: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: upstreamPort,
      async fetch(request) {
        upstreamPaths.push(new URL(request.url).pathname)
        return Response.json(
          { error: { message: "SECRET_ERROR_RESPONSE_BODY" } },
          { status: 429, headers: { "retry-after": "2" } },
        )
      },
    })
    const proxy = await startProviderProxy({
      listenHost: "127.0.0.1",
      port: proxyPort,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKeyEnv: "PROVIDER_PROXY_TEST_KEY",
      out,
      env: { PROVIDER_PROXY_TEST_KEY: "SECRET_UPSTREAM_KEY" },
    })

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer SECRET_CLIENT_KEY",
        },
        body: JSON.stringify({
          model: "client-model",
          stream: false,
          messages: [{ role: "user", content: "SECRET_PROMPT_TEXT" }],
        }),
      })

      expect(response.status).toBe(429)
      expect(await response.text()).toContain("SECRET_ERROR_RESPONSE_BODY")
      expect(upstreamPaths).toEqual(["/v1/chat/completions"])

      const profileText = await readFile(join(out, "provider.profile.json"), "utf8")
      expect(profileText).not.toContain("SECRET_PROMPT_TEXT")
      expect(profileText).not.toContain("SECRET_ERROR_RESPONSE_BODY")
      expect(profileText).not.toContain("SECRET_CLIENT_KEY")
      expect(profileText).not.toContain("SECRET_UPSTREAM_KEY")

      const profile = JSON.parse(profileText) as Record<string, any>
      expect(profile.totals).toMatchObject({
        requestCount: 1,
        successCount: 0,
        errorCount: 1,
        retryableErrorCount: 1,
      })
      expect(profile.requests[0]).toMatchObject({
        status: 429,
        streaming: false,
        model: "client-model",
        usage: null,
        error: {
          kind: "upstream_http_error",
          status: 429,
          retryable: true,
        },
        retry: {
          attempts: 0,
          retryable: true,
          retryAfterMs: 2000,
        },
      })
    } finally {
      await proxy.stop()
      upstream.stop(true)
    }
  })

  test("parses required CLI arguments", () => {
    const options = parseArgs(
      [
        "--listen-host",
        "0.0.0.0",
        "--port",
        "9000",
        "--upstream-base-url",
        "https://api.example.test/v1",
        "--api-key-env",
        "EXAMPLE_KEY",
        "--out",
        "/tmp/provider-proxy-out",
        "--model",
        "example-model",
      ],
      {},
    )

    expect(options).toMatchObject({
      listenHost: "0.0.0.0",
      port: 9000,
      upstreamBaseUrl: "https://api.example.test/v1",
      apiKeyEnv: "EXAMPLE_KEY",
      out: "/tmp/provider-proxy-out",
      model: "example-model",
    })
  })
})

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}

async function getFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to allocate test port")
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}
