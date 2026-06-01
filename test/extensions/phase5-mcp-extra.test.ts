import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent, SessionEventDraft } from "../../src/core/events"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { connectMcpServers, type McpStdioClient } from "../../src/extensions/mcp"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 5 MCP stdio extra coverage", () => {
  test("sanitized tool names are deterministic and collisions fail only the colliding server", async () => {
    const root = await createTempWorkspace()
    const first = await writeMcpServer(root, {
      tools: [
        {
          name: "Do Thing!",
          description: "first",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      callBody:
        "send({ id: message.id, result: { content: [{ type: 'text', text: 'first:' + message.params.name }] } })",
    })
    const second = await writeMcpServer(root, {
      tools: [
        {
          name: "do thing",
          description: "second",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      callBody:
        "send({ id: message.id, result: { content: [{ type: 'text', text: 'second:' + message.params.name }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local_server__do_thing", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [
        { name: "Local Server", command: process.execPath, args: [first] },
        { name: "local_server", command: process.execPath, args: [second] },
      ],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "use mcp" })
    await session.close()

    const ready = transcript.events.filter((event) => event.type === "mcp.server.ready")
    const failed = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "mcp.server.failed" }> => event.type === "mcp.server.failed",
    )
    const toolNames = toolSchemaNames(provider)
    const result = onlyToolResult(transcript.events)

    expect(ready.map((event) => event.serverName)).toEqual(["Local Server"])
    expect(failed.map((event) => event.serverName)).toEqual(["local_server"])
    expect(failed[0]?.error).toContain("MCP tool name collision after sanitization: mcp__local_server__do_thing")
    expect(toolNames.filter((name) => name === "mcp__local_server__do_thing")).toHaveLength(1)
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local_server__do_thing", isError: false })
    expect(result.result.content).toBe("first:Do Thing!")
  })

  test("invalid MCP tool args produce one paired error result and do not call the server", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "invalid-args-called.txt")
    const script = await writeMcpServer(root, {
      marker,
      tools: [
        {
          name: "needs_text",
          inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
      ],
      callBody:
        "require('node:fs').writeFileSync(marker, 'called'); send({ id: message.id, result: { content: [{ type: 'text', text: 'unexpected' }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__needs_text", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "local", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "bad args" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__needs_text", isError: true })
    expect(result.result.content).toContain("invalid_input")
    expect(result.result.content).toContain("text is required")
    expect(existsSync(marker)).toBe(false)
    expect(replayProviderMessages(transcript.events).filter((message) => message.role === "tool")).toHaveLength(1)
  })

  test("MCP schema type mismatch produces one paired error result and does not call the server", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "type-mismatch-called.txt")
    const script = await writeMcpServer(root, {
      marker,
      tools: [
        {
          name: "needs_text",
          inputSchema: {
            type: "object",
            required: ["text"],
            additionalProperties: false,
            properties: { text: { type: "string" } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
      callBody:
        "require('node:fs').writeFileSync(marker, 'called'); send({ id: message.id, result: { content: [{ type: 'text', text: 'unexpected' }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__needs_text", { text: 123 })]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "local", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "bad arg type" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__needs_text", isError: true })
    expect(result.result.content).toContain("invalid_input")
    expect(result.result.content).toContain("mcp__local__needs_text.text must be string")
    expect(existsSync(marker)).toBe(false)
  })

  test("aborting an in-flight MCP call terminates the stdio child", async () => {
    const root = await createTempWorkspace()
    const pidFile = join(root, "mcp.pid")
    const startedFile = join(root, "mcp.started")
    const script = await writeMcpServer(root, {
      tools: [{ name: "hang", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callBody: `require('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'started'); setInterval(() => {}, 1000)`,
      prelude: `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [{ message: assistant("a1", "call", [call("c1", "mcp__local__hang", {})]) }],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "local", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    const running = session.submit({ type: "user_message", content: "abort mcp" })
    await waitForFile(startedFile)
    const pid = Number(await readFile(pidFile, "utf8"))
    session.abort("stop mcp")
    await running
    await waitUntil(() => !isProcessAlive(pid))
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__hang", isError: true })
    expect(result.result.content).toContain("Tool call aborted")
  })

  test("MCP tools/call JSON-RPC errors are returned as paired runtime errors", async () => {
    const root = await createTempWorkspace()
    const script = await writeMcpServer(root, {
      tools: [{ name: "explode", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callBody: "send({ id: message.id, error: { code: -32000, message: 'server refused call' } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__explode", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "local", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "explode" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__explode", isError: true })
    expect(result.result.content).toContain("runtime_error")
    expect(result.result.content).toContain("MCP tool call failed: server refused call")
    expect(replayProviderMessages(transcript.events).filter((message) => message.role === "tool")).toHaveLength(1)
  })

  test("server crash during tools/call is returned as a paired runtime error", async () => {
    const root = await createTempWorkspace()
    const script = await writeMcpServer(root, {
      tools: [{ name: "crash", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callBody: "process.stderr.write('crashing during call\\n'); process.exit(23)",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__crash", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "local", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "crash" })
    await session.close()

    const result = onlyToolResult(transcript.events)
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__crash", isError: true })
    expect(result.result.content).toContain("runtime_error")
    expect(result.result.content).toContain("MCP server exited")
    expect(replayProviderMessages(transcript.events).filter((message) => message.role === "tool")).toHaveLength(1)
  })

  test("readOnlyHint false in workspace-write asks and fails closed without an approval responder", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "should-not-be-called.txt")
    const script = await writeMcpServer(root, {
      marker,
      tools: [{ name: "mutate", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }],
      callBody:
        "require('node:fs').writeFileSync(marker, 'called'); send({ id: message.id, result: { content: [{ type: 'text', text: 'mutated' }] } })",
    })
    const diagnostics: SessionEventDraft[] = []
    const workspace = await WorkspaceFs.create(root)
    const runtime = new RealToolRuntime({
      registry: createBuiltinToolRegistry(),
      workspace,
      permissionMode: "workspace-write",
    })
    const connected = await connectMcpServers([{ name: "local", command: process.execPath, args: [script] }], {
      signal: new AbortController().signal,
      emit: async (event) => {
        diagnostics.push(event)
      },
    })

    try {
      for (const tool of connected.tools) runtime.registerTool(tool)
      const results = await runtime.runBatch([call("c1", "mcp__local__mutate", {})], ctx())

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__mutate", isError: true })
      expect(results[0]?.content).toContain("Approval required but no approval responder is available")
      expect(diagnostics.some((event) => event.type === "mcp.server.ready")).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      closeMcpClients(connected.clients)
    }
  })

  test("MCP diagnostics do not enter replay, including stopped events after close", async () => {
    const root = await createTempWorkspace()
    const script = await writeMcpServer(root, {
      tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callBody: "send({ id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__echo", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "local", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "echo" })
    await session.close()

    const withoutMcpDiagnostics = transcript.events.filter((event) => !event.type.startsWith("mcp.server."))
    expect(transcript.events.some((event) => event.type === "mcp.server.started")).toBe(true)
    expect(transcript.events.some((event) => event.type === "mcp.server.ready")).toBe(true)
    expect(transcript.events.some((event) => event.type === "mcp.server.stopped")).toBe(true)
    expect(replayProviderMessages(transcript.events)).toEqual(replayProviderMessages(withoutMcpDiagnostics))
    expect(JSON.stringify(replayProviderMessages(transcript.events))).not.toContain("mcp.server")
  })

  test("startup failure records diagnostics, keeps replay clean, and leaves built-in tools usable", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "ok.txt"), "still usable\n", "utf8")
    const script = await writeMcpServer(root, {
      toolsListBody: "send({ id: message.id, result: { tools: 'not-an-array' } })",
      tools: [],
      callBody: "send({ id: message.id, result: { content: [{ type: 'text', text: 'unexpected' }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "read", [call("c1", "read", { path: "ok.txt" })]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      servers: [{ name: "bad", command: process.execPath, args: [script] }],
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "read after startup failure" })
    await session.close()

    const failed = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "mcp.server.failed" }> => event.type === "mcp.server.failed",
    )
    const result = onlyToolResult(transcript.events)
    const withoutMcpDiagnostics = transcript.events.filter((event) => !event.type.startsWith("mcp.server."))

    expect(failed?.error).toContain("MCP tools/list result must contain a tools array")
    expect(result.result).toMatchObject({ toolCallId: "c1", toolName: "read", isError: false })
    expect(result.result.content).toContain("still usable")
    expect(replayProviderMessages(transcript.events)).toEqual(replayProviderMessages(withoutMcpDiagnostics))
  })
})

async function createMcpSession(input: {
  root: string
  provider: FakeProvider
  transcript: TranscriptSink
  servers: Array<{ name: string; command: string; args?: string[]; callTimeoutMs?: number; startupTimeoutMs?: number }>
  permissionMode?: "read-only" | "workspace-write" | "danger-full-access"
}): Promise<AgentSession> {
  const todoState = new TodoState()
  const workspace = await WorkspaceFs.create(input.root)
  return AgentSession.create({
    cwd: input.root,
    provider: input.provider,
    toolRuntime: new RealToolRuntime({
      registry: createBuiltinToolRegistry({ todoState }),
      workspace,
      permissionMode: input.permissionMode ?? "workspace-write",
    }),
    transcript: input.transcript,
    todoState,
    mcpServers: input.servers,
  })
}

async function writeMcpServer(
  root: string,
  input: {
    tools: unknown[]
    callBody: string
    marker?: string
    toolsListBody?: string
    prelude?: string
  },
): Promise<string> {
  const script = join(root, `mcp-${Math.random().toString(36).slice(2)}.cjs`)
  const source = `
const marker = ${JSON.stringify(input.marker ?? "")};
const tools = ${JSON.stringify(input.tools)};
${input.prelude ?? ""}
let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\\n");
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { capabilities: { tools: {} } } });
    else if (message.method === "tools/list") { ${input.toolsListBody ?? "send({ id: message.id, result: { tools } })"} }
    else if (message.method === "tools/call") { ${input.callBody} }
  }
});
`
  await writeFile(script, source, "utf8")
  return script
}

async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  await waitUntil(() => existsSync(path), timeoutMs)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function onlyToolResult(events: SessionEvent[]): Extract<SessionEvent, { type: "tool.result" }> {
  const results = events.filter(
    (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
  )
  expect(results).toHaveLength(1)
  return results[0]
}

function toolSchemaNames(provider: FakeProvider): string[] {
  return (provider.requests[0]?.tools ?? [])
    .map((tool) => {
      const record = tool as { function?: { name?: unknown } }
      return typeof record.function?.name === "string" ? record.function.name : undefined
    })
    .filter((name): name is string => typeof name === "string")
}

function closeMcpClients(clients: McpStdioClient[]): void {
  for (const client of clients) client.close()
}

function ctx(): ToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepId: "step1",
    signal: new AbortController().signal,
  }
}

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}
