import { describe, expect, test } from "bun:test"
import { configureFetchProxy } from "../../src/cli/proxy"

describe("configureFetchProxy", () => {
  test("no proxy env leaves fetch untouched", async () => {
    const result = await configureFetchProxy({} as NodeJS.ProcessEnv)
    expect(result.enabled).toBe(false)
  })

  test("picks up a proxy from the environment", async () => {
    // The test runner is Bun, whose fetch honors proxy env vars natively, so this
    // exercises detection without mutating Node's global dispatcher.
    const result = await configureFetchProxy({ HTTPS_PROXY: "http://127.0.0.1:7897" } as unknown as NodeJS.ProcessEnv)
    expect(result.enabled).toBe(true)
    expect(result.proxy).toBe("http://127.0.0.1:7897")
    expect(result.runtime).toBe("bun")
  })

  test("falls back through HTTP_PROXY and ALL_PROXY", async () => {
    expect((await configureFetchProxy({ ALL_PROXY: "http://p:1" } as unknown as NodeJS.ProcessEnv)).proxy).toBe("http://p:1")
    expect((await configureFetchProxy({ http_proxy: "http://p:2" } as unknown as NodeJS.ProcessEnv)).proxy).toBe("http://p:2")
  })
})
