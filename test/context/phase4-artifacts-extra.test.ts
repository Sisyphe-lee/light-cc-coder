import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { AgentSession } from "../../src/core/AgentSession"
import { TranscriptWriteError } from "../../src/core/errors"
import type { SessionEvent } from "../../src/core/events"
import type { ToolResultMessage } from "../../src/core/messages"
import { readJsonlTranscript, replayProviderMessages, type TranscriptSink } from "../../src/engine/transcript"
import { FakeProvider } from "../../src/providers/FakeProvider"
import { FakeToolRuntime } from "../../src/tools/FakeToolRuntime"
import { RealToolRuntime } from "../../src/tools/ToolRuntime"
import { ToolRegistry } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { assistant, call, createTempWorkspace } from "../helpers"

describe("Phase 4 large tool result artifacts extra coverage", () => {
  test("default artifact directory stays outside workspace and explicit workspace artifactDir is rejected", async () => {
    const workspaceRoot = await createTempWorkspace("light-cc-phase4-artifacts-workspace-")
    const transcriptPath = join(workspaceRoot, ".light-cc-coder", "session.jsonl")
    const payload = "outside-workspace-artifact\n".repeat(20)
    const session = await AgentSession.create({
      id: "s-default-artifact-dir",
      cwd: workspaceRoot,
      provider: new FakeProvider({
        steps: [
          { message: assistant("a1", "collect output", [call("c1", "huge")]) },
          { message: assistant("a2", "done") },
        ],
      }),
      toolRuntime: new RealToolRuntime({
        registry: registryWithPayload(payload),
        workspace: await WorkspaceFs.create(workspaceRoot),
        maxResultBytes: 4096,
      }),
      transcript: transcriptPath,
      toolResultArtifactBytes: 64,
      toolResultPreviewBytes: 24,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "run huge" })
    await session.close()

    const artifact = onlyArtifact(await readJsonlTranscript(transcriptPath))
    expect(isInside(artifact.path, workspaceRoot)).toBe(false)
    expect(await readFile(artifact.path, "utf8")).toBe(payload)

    await expect(
      AgentSession.create({
        id: "s-reject-workspace-artifact-dir",
        cwd: workspaceRoot,
        provider: new FakeProvider({ steps: [] }),
        toolRuntime: new FakeToolRuntime(),
        artifactDir: join(workspaceRoot, ".light-cc-coder", "artifacts"),
      }),
    ).rejects.toThrow("Artifact directory must not be inside the workspace")
  })

  test("persisted preview is one paired tool result and artifact diagnostics are replay-invisible", async () => {
    const workspaceRoot = await createTempWorkspace("light-cc-phase4-preview-workspace-")
    const transcriptRoot = await createTempWorkspace("light-cc-phase4-preview-transcript-")
    const transcriptPath = join(transcriptRoot, "session.jsonl")
    const payload = `HEAD-${"0123456789".repeat(80)}-TAIL_MARKER`
    const session = await AgentSession.create({
      id: "s-preview-pairing",
      cwd: workspaceRoot,
      provider: new FakeProvider({
        steps: [
          { message: assistant("a1", "need output", [call("c1", "huge")]) },
          { message: assistant("a2", "done") },
        ],
      }),
      toolRuntime: new RealToolRuntime({
        registry: registryWithPayload(payload),
        workspace: await WorkspaceFs.create(workspaceRoot),
        maxResultBytes: 4096,
      }),
      transcript: transcriptPath,
      toolResultArtifactBytes: 64,
      toolResultPreviewBytes: 20,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "run huge" })
    await session.close()

    const events = await readJsonlTranscript(transcriptPath)
    expect(artifactEvents(events)).toHaveLength(1)
    const results = resultEvents(events).filter((event) => event.result.toolCallId === "c1")
    expect(results).toHaveLength(1)
    expect(results[0].result.isError).toBe(false)

    const resultContent = results[0].result.content
    expect(resultContent).toContain("large tool result persisted outside provider context")
    expect(resultContent).toContain("Original bytes:")
    expect(resultContent).not.toContain(transcriptRoot)
    expect(resultContent).not.toContain(payload)
    expect(resultContent).not.toContain("TAIL_MARKER")
    const preview = extractPreview(resultContent)
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(20)
    expect(preview).toBe(payload.slice(0, 20))

    const replayWithDiagnostics = replayProviderMessages(events)
    const replayWithoutDiagnostics = replayProviderMessages(events.filter((event) => event.type !== "tool.artifact"))
    expect(replayWithDiagnostics).toEqual(replayWithoutDiagnostics)
    expect(replayWithDiagnostics.filter((message) => message.role === "tool")).toHaveLength(1)
  })

  test("artifact persistence failure is returned as a paired model-visible error result", async () => {
    const workspaceRoot = await createTempWorkspace("light-cc-phase4-artifact-fail-workspace-")
    const transcriptRoot = await createTempWorkspace("light-cc-phase4-artifact-fail-transcript-")
    const transcriptPath = join(transcriptRoot, "session.jsonl")
    const artifactDirFile = join(transcriptRoot, "artifact-dir-is-a-file")
    await writeFile(artifactDirFile, "not a directory", "utf8")

    const payload = "cannot-be-persisted\n".repeat(20)
    const provider = new FakeProvider({
      steps: [
        { message: assistant("a1", "need output", [call("c1", "huge")]) },
        { message: assistant("a2", "saw the error") },
      ],
    })
    const session = await AgentSession.create({
      id: "s-artifact-persist-fail",
      cwd: workspaceRoot,
      provider,
      toolRuntime: new RealToolRuntime({
        registry: registryWithPayload(payload),
        workspace: await WorkspaceFs.create(workspaceRoot),
        maxResultBytes: 4096,
      }),
      transcript: transcriptPath,
      artifactDir: artifactDirFile,
      toolResultArtifactBytes: 64,
      toolResultPreviewBytes: 20,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await session.submit({ type: "user_message", content: "run huge" })
    await session.close()

    const events = await readJsonlTranscript(transcriptPath)
    expect(artifactEvents(events)).toHaveLength(0)
    const results = resultEvents(events).filter((event) => event.result.toolCallId === "c1")
    expect(results).toHaveLength(1)
    expect(results[0].result).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      toolName: "huge",
      isError: true,
    } satisfies Partial<ToolResultMessage>)
    expect(results[0].result.content).toContain("Error (internal_error): Tool artifact persistence failed:")
    expect(results[0].result.content).not.toContain(payload)

    expect(() => replayProviderMessages(events)).not.toThrow()
    expect(replayProviderMessages(events).filter((message) => message.role === "tool")).toHaveLength(1)
    const secondRequestToolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool")
    expect(secondRequestToolMessage?.content).toContain("Tool artifact persistence failed")
  })

  test("tool.artifact transcript write failure is fatal and does not leave unpaired active history", async () => {
    const workspaceRoot = await createTempWorkspace("light-cc-phase4-artifact-transcript-fail-")
    const transcript = new FailingTranscriptSink("tool.artifact")
    const payload = "artifact-diagnostic-must-be-fatal\n".repeat(20)
    const session = await AgentSession.create({
      id: "s-artifact-transcript-fail",
      cwd: workspaceRoot,
      provider: new FakeProvider({
        steps: [{ message: assistant("a1", "need output", [call("c1", "huge")]) }],
      }),
      toolRuntime: new RealToolRuntime({
        registry: registryWithPayload(payload),
        workspace: await WorkspaceFs.create(workspaceRoot),
        maxResultBytes: 4096,
      }),
      transcript,
      toolResultArtifactBytes: 64,
      toolResultPreviewBytes: 20,
      now: () => "2026-05-31T00:00:00.000Z",
    })

    await expect(session.submit({ type: "user_message", content: "run huge" })).rejects.toThrow(TranscriptWriteError)
    await session.close()

    expect(session.getMessages().map((message) => message.role)).toEqual(["user"])
    expect(transcript.events.some((event) => event.type === "tool.result")).toBe(false)
  })
})

function registryWithPayload(content: string): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: "huge",
    description: "Return a huge payload",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
    parse: () => ({}),
    execute: async () => ({ content }),
  })
  return registry
}

function artifactEvents(events: SessionEvent[]): Extract<SessionEvent, { type: "tool.artifact" }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "tool.artifact" }> => event.type === "tool.artifact",
  )
}

function resultEvents(events: SessionEvent[]): Extract<SessionEvent, { type: "tool.result" }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: "tool.result" }> => event.type === "tool.result")
}

function onlyArtifact(events: SessionEvent[]): Extract<SessionEvent, { type: "tool.artifact" }> {
  const artifacts = artifactEvents(events)
  expect(artifacts).toHaveLength(1)
  return artifacts[0]
}

function extractPreview(content: string): string {
  const match = content.match(/\nPreview:\n([\s\S]*?)\n\n\[preview capped at/)
  expect(match).not.toBeNull()
  return match?.[1] ?? ""
}

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..")
}

class FailingTranscriptSink implements TranscriptSink {
  readonly events: SessionEvent[] = []

  constructor(private readonly failOn: string) {}

  async write(event: SessionEvent): Promise<void> {
    if (event.type === this.failOn) {
      throw new Error(`fail ${this.failOn}`)
    }
    this.events.push(event)
  }
}
