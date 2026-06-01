import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { createTempWorkspace } from "../helpers"

describe("Phase 7 CLI config and session trigger behavior", () => {
  test("dry-run config report shows defaults < global < project < env < CLI precedence", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    await writeJson(join(dataRoot, "config.json"), {
      baseUrl: "http://global.example/v1",
      model: "global-model",
      apiKeyEnv: "GLOBAL_KEY",
      maxSteps: 11,
      maxContextTokens: 1234,
      compactThreshold: 101,
      permissionMode: "read-only",
    })
    await mkdir(join(root, ".lightcc"), { recursive: true })
    await writeJson(join(root, ".lightcc", "config.json"), {
      baseUrl: "http://project.example/v1",
      model: "project-model",
      maxSteps: 22,
      compactThreshold: 202,
      permissionMode: "read-only",
    })

    const result = await runCli(
      [
        "--dry-run",
        "-p",
        "hello",
        "--cwd",
        root,
        "--base-url",
        "http://cli.example/v1",
        "--max-steps",
        "44",
        "--permission-mode",
        "workspace-write",
      ],
      cleanEnv({
        LIGHTCC_HOME: dataRoot,
        LIGHT_CC_BASE_URL: "http://env.example/v1",
        LIGHT_CC_MODEL: "env-model",
        LIGHT_CC_API_KEY_ENV: "ENV_KEY",
        LIGHT_CC_MAX_STEPS: "33",
        LIGHT_CC_PERMISSION_MODE: "danger-full-access",
        ENV_KEY: "secret",
      }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`dataRoot: ${dataRoot} (env:LIGHTCC_HOME)`)
    expect(result.stdout).toContain("baseUrl: http://cli.example/v1 (cli:--base-url)")
    expect(result.stdout).toContain("model: env-model (env:LIGHT_CC_MODEL)")
    expect(result.stdout).toContain("apiKeyEnv: ENV_KEY (env:LIGHT_CC_API_KEY_ENV)")
    expect(result.stdout).toContain("apiKeyPresent: yes (env:ENV_KEY)")
    expect(result.stdout).toContain("permissionMode: workspace-write (cli:--permission-mode)")
    expect(result.stdout).toContain("maxSteps: 44 (cli:--max-steps)")
    expect(result.stdout).toContain("maxContextTokens: 1234 (global config)")
    expect(result.stdout).toContain("compactThreshold: 202 (project config)")
    expect(result.stdout).toContain("transcript: unset (default)")
    expect(result.stdout).toContain(`Planned transcript: ${join(dataRoot, "sessions")}`)
    expect(result.stdout).toContain(`${join(dataRoot, "config.json")}: loaded`)
    expect(result.stdout).toContain(`${join(root, ".lightcc", "config.json")}: loaded`)
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
  })

  test("project config refuses apiKeyEnv before session creation", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    await mkdir(join(root, ".lightcc"), { recursive: true })
    await writeJson(join(root, ".lightcc", "config.json"), {
      baseUrl: "http://project.example/v1",
      model: "project-model",
      apiKeyEnv: "PROJECT_KEY",
    })

    const result = await runCli(["--dry-run", "-p", "hello", "--cwd", root], cleanEnv({ LIGHTCC_HOME: dataRoot }))

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Project config must not set apiKeyEnv")
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
  })

  test("--transcript override writes only the requested transcript and disables metadata/index", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const transcript = join(root, "custom-session.jsonl")

    const dryRun = await runCli(
      ["--dry-run", "-p", "hello", "--fake", "--cwd", root, "--transcript", transcript],
      cleanEnv({ LIGHTCC_HOME: dataRoot }),
    )
    expect(dryRun.exitCode).toBe(0)
    expect(dryRun.stdout).toContain(`Planned transcript: ${transcript}`)
    expect(dryRun.stdout).toContain("Planned metadata: disabled (--transcript override)")
    expect(existsSync(transcript)).toBe(false)

    const result = await runCli(
      ["-p", "hello", "--fake", "--cwd", root, "--transcript", transcript],
      cleanEnv({ LIGHTCC_HOME: dataRoot }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok")
    expect(existsSync(transcript)).toBe(true)
    expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
    expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
  })

  test("doctor and dry-run make no provider request and write no normal transcript", async () => {
    const root = await createTempWorkspace()
    const dataRoot = await createTempWorkspace("light-cc-home-")
    const server = await createCountingProvider()
    const env = cleanEnv({ LIGHTCC_HOME: dataRoot, LIGHT_CC_TEST_API_KEY: "test-key" })
    const providerArgs = [
      "--cwd",
      root,
      "--base-url",
      server.baseUrl,
      "--model",
      "mock-model",
      "--api-key-env",
      "LIGHT_CC_TEST_API_KEY",
    ]

    try {
      const doctor = await runCli(["doctor", ...providerArgs], env)
      expect(doctor.exitCode).toBe(0)
      expect(doctor.stdout).toContain("ready\tprovider.baseUrl\tcli:--base-url")
      expect(doctor.stdout).toContain("ready\tprovider.apiKey\tLIGHT_CC_TEST_API_KEY is set")
      expect(server.requestCount()).toBe(0)

      const dryRun = await runCli(["--dry-run", "-p", "hello", ...providerArgs], env)
      expect(dryRun.exitCode).toBe(0)
      expect(dryRun.stdout).toContain("No provider request, agent tool execution, or normal transcript write will occur")
      expect(server.requestCount()).toBe(0)
      expect(existsSync(join(dataRoot, "sessions"))).toBe(false)
      expect(existsSync(join(dataRoot, "session_index.jsonl"))).toBe(false)
    } finally {
      await server.close()
    }
  })
})

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdin: "ignore",
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

function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: `/home/cyli/.bun/bin:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    NO_PROXY: "127.0.0.1,localhost",
    LIGHT_CC_OS_SANDBOX: "off",
    ...extra,
  }
  for (const key of [
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_API_KEY",
    "LIGHT_CC_BASE_URL",
    "LIGHT_CC_MODEL",
    "LIGHT_CC_API_KEY_ENV",
    "LIGHT_CC_PERMISSION_MODE",
    "LIGHT_CC_SANDBOX_SETTINGS",
    "LIGHT_CC_SANDBOX_ALLOW_DOMAINS",
    "LIGHT_CC_SANDBOX_ALLOW_WRITES",
    "LIGHT_CC_TRANSCRIPT",
    "LIGHT_CC_MAX_STEPS",
    "LIGHT_CC_MAX_CONTEXT_TOKENS",
    "LIGHT_CC_COMPACT_THRESHOLD",
    "LIGHT_CC_MCP_CONFIG",
    "LIGHT_CC_SKILLS",
  ]) {
    if (!(key in extra)) env[key] = undefined
  }
  return env
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function createCountingProvider(): Promise<{ baseUrl: string; requestCount: () => number; close: () => Promise<void> }> {
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.writeHead(500, { "content-type": "text/plain" })
    res.end("provider should not be called")
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
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
