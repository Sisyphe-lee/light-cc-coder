import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { SessionEventDraft } from "../core/events"
import type { ToolCall } from "../core/messages"

export type ToolArtifactStoreOptions = {
  sessionId: string
  cwd: string
  transcriptPath?: string
  artifactDir?: string
  thresholdBytes?: number
  previewBytes?: number
}

export type ToolArtifactPreview = {
  content: string
  originalBytes: number
  previewBytes: number
  artifactId: string
  path: string
  sha256: string
}

export class ToolArtifactStore {
  readonly dir: string
  readonly thresholdBytes: number
  readonly previewBytes: number
  private nextArtifact = 0

  constructor(options: ToolArtifactStoreOptions) {
    this.dir = chooseArtifactDir(options)
    assertOutsideWorkspace(this.dir, options.cwd)
    this.thresholdBytes = options.thresholdBytes ?? 64 * 1024
    this.previewBytes = options.previewBytes ?? 16 * 1024
  }

  shouldPersist(content: string): boolean {
    return byteLength(content) > this.thresholdBytes
  }

  async persist(input: {
    call: ToolCall
    content: string
    turnId: string
    stepId: string
    emit?: (event: SessionEventDraft) => Promise<void>
  }): Promise<ToolArtifactPreview> {
    const originalBytes = byteLength(input.content)
    const artifactId = this.nextId(input.call)
    const sha256 = createHash("sha256").update(input.content).digest("hex")
    const path = join(this.dir, `${artifactId}.txt`)
    await mkdir(this.dir, { recursive: true })
    await writeFile(path, input.content, "utf8")
    const preview = buildPreview({
      toolName: input.call.name,
      artifactId,
      path,
      originalBytes,
      sha256,
      content: input.content,
      previewBytes: this.previewBytes,
    })
    await input.emit?.({
      type: "tool.artifact",
      turnId: input.turnId,
      stepId: input.stepId,
      toolCallId: input.call.id,
      toolName: input.call.name,
      artifactId,
      path,
      originalBytes,
      previewBytes: byteLength(preview),
      sha256,
    })
    return {
      content: preview,
      originalBytes,
      previewBytes: byteLength(preview),
      artifactId,
      path,
      sha256,
    }
  }

  private nextId(call: ToolCall): string {
    this.nextArtifact += 1
    const safeName = call.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "tool"
    return `${this.nextArtifact.toString().padStart(4, "0")}-${safeName}-${call.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}`
  }
}

export function defaultArtifactDir(input: { sessionId: string; cwd: string; transcriptPath?: string }): string {
  const candidates: string[] = []
  if (input.transcriptPath) {
    candidates.push(resolve(dirname(input.transcriptPath), `${basename(input.transcriptPath)}.artifacts`))
  }
  candidates.push(
    join(tmpdir(), "light-cc-coder-artifacts", input.sessionId),
    join(homedir(), ".cache", "light-cc-coder", "artifacts", input.sessionId),
    join(dirname(resolve(input.cwd)), ".light-cc-coder-artifacts", input.sessionId),
  )
  const outside = candidates.find((candidate) => !isInside(candidate, input.cwd))
  if (!outside) {
    throw new Error(`Could not choose an artifact directory outside the workspace: ${input.cwd}`)
  }
  return outside
}

function chooseArtifactDir(options: ToolArtifactStoreOptions): string {
  return resolve(options.artifactDir ?? defaultArtifactDir(options))
}

function assertOutsideWorkspace(path: string, cwd: string): void {
  if (isInside(path, cwd)) {
    throw new Error(`Artifact directory must not be inside the workspace: ${path}`)
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..")
}

function buildPreview(input: {
  toolName: string
  artifactId: string
  path: string
  originalBytes: number
  sha256: string
  content: string
  previewBytes: number
}): string {
  const head = truncateUtf8(input.content, Math.max(0, input.previewBytes))
  return [
    `[large tool result persisted outside provider context]`,
    `Tool: ${input.toolName}`,
    `Original bytes: ${input.originalBytes}`,
    `Artifact id: ${input.artifactId}`,
    `Artifact ref: ${input.artifactId}.txt`,
    `SHA-256: ${input.sha256}`,
    "",
    "Preview:",
    head,
    "",
    `[preview capped at ${byteLength(head)} bytes; full output is stored as a session artifact outside the workspace]`,
  ].join("\n")
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  const encoder = new TextEncoder()
  for (const char of text) {
    const size = encoder.encode(char).byteLength
    if (bytes + size > maxBytes) break
    output += char
    bytes += size
  }
  return output
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
