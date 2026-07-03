// Make Node's global fetch honor HTTP(S)_PROXY / ALL_PROXY. Node's undici-based
// fetch ignores proxy environment variables by default, so on networks where the
// model endpoint is only reachable through a local proxy, provider requests fail
// with "fetch failed" even though curl works. Routing fetch through undici's
// EnvHttpProxyAgent fixes provider, MCP, and hook requests in one place.
//
// Bun's fetch already honors proxy env vars, so it is left untouched there.
// localhost is always added to the no-proxy list so local model servers are not
// tunnelled through the proxy.

export type ProxyResult = {
  enabled: boolean
  runtime: "node" | "bun"
  proxy?: string
  reason?: string
}

export async function configureFetchProxy(env: NodeJS.ProcessEnv = process.env): Promise<ProxyResult> {
  const proxy =
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy
  const runtime: "node" | "bun" = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node"
  if (!proxy) return { enabled: false, runtime }
  if (runtime === "bun") return { enabled: true, runtime, proxy } // Bun's fetch already routes through proxy env vars

  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici")
    const existing = env.NO_PROXY ?? env.no_proxy
    const noProxy =
      existing === "*" ? "*" : [existing, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",")
    // Silence undici's one-time "EnvHttpProxyAgent is experimental" notice; the
    // dependency is pinned, so the API is stable for us. Restore immediately after.
    const emitWarning = process.emitWarning
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning?.message
      const code = typeof rest[0] === "object" && rest[0] ? (rest[0] as { code?: string }).code : rest[1]
      if ((text && text.includes("EnvHttpProxyAgent")) || code === "UNDICI-EHPA") return
      return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
    }) as typeof process.emitWarning
    try {
      setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy }))
    } finally {
      process.emitWarning = emitWarning
    }
    return { enabled: true, runtime, proxy }
  } catch (error) {
    return { enabled: false, runtime, reason: error instanceof Error ? error.message : String(error) }
  }
}
