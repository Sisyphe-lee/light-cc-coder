import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import type { SessionEvent } from "../../src/core/events"
import { replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry, TodoState } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 5 MCP stdio", () => {
  test("stdio server registers a namespaced read-only tool and produces one paired result", async () => {
    const root = await createTempWorkspace()
    const script = await writeMcpServer(root, {
      tools: [
        {
          name: "echo",
          description: "Echo input text",
          inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
      ],
      callBody: "send({ id: message.id, result: { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local_server__echo", { text: "hi" })]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      server: { name: "local-server", command: process.execPath, args: [script] },
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "use mcp" })
    await session.close()

    const toolResults = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(transcript.events.some((event) => event.type === "mcp.server.ready")).toBe(true)
    expect(provider.requests[0]?.tools?.some((tool) => JSON.stringify(tool).includes("mcp__local_server__echo"))).toBe(
      true,
    )
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local_server__echo", isError: false })
    expect(toolResults[0].result.content).toBe("echo:hi")
    expect(JSON.stringify(replayProviderMessages(transcript.events))).not.toContain("mcp.server")
  })

  test("startup failure records diagnostics and leaves the session usable", async () => {
    const root = await createTempWorkspace()
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({ steps: [{ message: assistant("a1", "done") }] })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      server: { name: "bad", command: "/path/that/does/not/exist" },
    })

    await session.submit({ type: "user_message", content: "hello" })
    await session.close()

    expect(transcript.events.some((event) => event.type === "mcp.server.failed")).toBe(true)
    expect(transcript.events.some((event) => event.type === "assistant.message")).toBe(true)
  })

  test("readOnlyHint false does not bypass read-only permission", async () => {
    const root = await createTempWorkspace()
    const marker = join(root, "called.txt")
    const script = await writeMcpServer(root, {
      marker,
      tools: [{ name: "mutate", inputSchema: { type: "object" } }],
      callBody:
        "require('node:fs').writeFileSync(marker, 'called'); send({ id: message.id, result: { content: [{ type: 'text', text: 'mutated' }] } })",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__mutate", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      server: { name: "local", command: process.execPath, args: [script] },
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "mutate" })
    await session.close()

    const result = transcript.events.find(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(result?.result.isError).toBe(true)
    expect(result?.result.content).toContain("permission_denied")
    expect(existsSync(marker)).toBe(false)
  })

  test("MCP call timeout becomes a paired error result", async () => {
    const root = await createTempWorkspace()
    const script = await writeMcpServer(root, {
      tools: [{ name: "hang", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callBody: "setTimeout(() => {}, 1000)",
    })
    const transcript = new RecordingTranscript()
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "call", [call("c1", "mcp__local__hang", {})]) },
        { message: assistant("a2", "done") },
      ],
    })
    const session = await createMcpSession({
      root,
      provider,
      transcript,
      server: { name: "local", command: process.execPath, args: [script], callTimeoutMs: 20 },
      permissionMode: "read-only",
    })

    await session.submit({ type: "user_message", content: "hang" })
    await session.close()

    const results = transcript.events.filter(
      (event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result",
    )
    expect(results).toHaveLength(1)
    expect(results[0].result).toMatchObject({ toolCallId: "c1", toolName: "mcp__local__hang", isError: true })
    expect(results[0].result.content).toContain("runtime_error")
  })
})

async function createMcpSession(input: {
  root: string
  provider: FakeProvider
  transcript: TranscriptSink
  server: { name: string; command: string; args?: string[]; callTimeoutMs?: number }
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
    mcpServers: [input.server],
  })
}

async function writeMcpServer(
  root: string,
  input: {
    tools: unknown[]
    callBody: string
    marker?: string
  },
): Promise<string> {
  const script = join(root, `mcp-${Math.random().toString(36).slice(2)}.cjs`)
  const source = `
const marker = ${JSON.stringify(input.marker ?? "")};
const tools = ${JSON.stringify(input.tools)};
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
    else if (message.method === "tools/list") send({ id: message.id, result: { tools } });
    else if (message.method === "tools/call") { ${input.callBody} }
  }
});
`
  await writeFile(script, source, "utf8")
  return script
}

class RecordingTranscript implements TranscriptSink {
  readonly events: SessionEvent[] = []

  async write(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
}
