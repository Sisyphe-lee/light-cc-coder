import { appendFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { messagesFromEvents, readJsonlTranscript } from "../engine/transcript"
import type { SessionEvent } from "../core/events"
import type { InternalMessage } from "../core/messages"
import type { PermissionMode } from "../permissions/types"

export type SessionMetadata = {
  id: string
  cwd: string
  model: string
  provider: string
  permissionMode: PermissionMode
  transcriptPath: string
  startedAt: string
  updatedAt: string
  lastUserPromptPreview?: string
  lastTurnEndReason?: string
  compactSummaryHash?: string
}

export type SessionPlan = {
  id: string
  transcriptPath: string
  metadataPath?: string
  defaultStore: boolean
  metadata: SessionMetadata
}

export type ResumePlan = SessionPlan & {
  events: SessionEvent[]
  messages: InternalMessage[]
  idSeed: number
}

export class SessionStore {
  readonly sessionsDir: string
  readonly indexPath: string

  constructor(readonly dataRoot: string) {
    this.sessionsDir = resolve(dataRoot, "sessions")
    this.indexPath = resolve(dataRoot, "session_index.jsonl")
  }

  planNew(input: {
    transcriptOverride?: string
    cwd: string
    model: string
    provider: string
    permissionMode: PermissionMode
    now?: string
  }): SessionPlan {
    const id = createSessionId(input.now ? new Date(input.now) : new Date())
    const transcriptPath = input.transcriptOverride ?? resolve(this.sessionsDir, id, "transcript.jsonl")
    const metadataPath = input.transcriptOverride ? undefined : resolve(this.sessionsDir, id, "metadata.json")
    const now = input.now ?? new Date().toISOString()
    return {
      id,
      transcriptPath,
      metadataPath,
      defaultStore: !input.transcriptOverride,
      metadata: {
        id,
        cwd: input.cwd,
        model: input.model,
        provider: input.provider,
        permissionMode: input.permissionMode,
        transcriptPath,
        startedAt: now,
        updatedAt: now,
      },
    }
  }

  async update(plan: SessionPlan, patch: Partial<SessionMetadata>): Promise<void> {
    if (!plan.metadataPath) return
    const metadata = {
      ...plan.metadata,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }
    plan.metadata = metadata
    await mkdir(resolve(plan.metadataPath, ".."), { recursive: true })
    await writeFileAtomic(plan.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    await mkdir(this.dataRoot, { recursive: true })
    await appendFile(this.indexPath, `${JSON.stringify(metadata)}\n`, "utf8")
  }

  async listForCwd(cwd: string): Promise<SessionMetadata[]> {
    const resolvedCwd = await realpathOrResolve(cwd)
    const all = await this.readIndex()
    const latest = new Map<string, SessionMetadata>()
    for (const item of all) {
      if ((await realpathOrResolve(item.cwd)) === resolvedCwd) latest.set(item.id, item)
    }
    return Array.from(latest.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async renderSessions(cwd: string): Promise<string> {
    const sessions = await this.listForCwd(cwd)
    if (sessions.length === 0) return "No sessions for this workspace."
    return sessions
      .slice(0, 20)
      .map((session) => {
        const prompt = session.lastUserPromptPreview ? ` - ${session.lastUserPromptPreview}` : ""
        return `${session.id}\t${session.updatedAt}\t${session.model}${prompt}`
      })
      .join("\n")
  }

  async resolveResume(ref: { last?: boolean; id?: string }, cwd: string): Promise<ResumePlan> {
    const metadata = ref.last ? (await this.listForCwd(cwd))[0] : await this.readMetadata(ref.id ?? "")
    if (!metadata) {
      throw new Error(ref.last ? "No previous session for this workspace" : `Session not found: ${ref.id}`)
    }
    if ((await realpathOrResolve(metadata.cwd)) !== (await realpathOrResolve(cwd))) {
      throw new Error(`Session ${metadata.id} belongs to ${metadata.cwd}; run resume from that workspace`)
    }
    const events = await readJsonlTranscript(metadata.transcriptPath)
    const messages = messagesFromEvents(events)
    return {
      id: metadata.id,
      transcriptPath: metadata.transcriptPath,
      metadataPath: resolve(this.sessionsDir, metadata.id, "metadata.json"),
      defaultStore: true,
      metadata,
      events,
      messages,
      idSeed: Math.max(events.length + 1, 1),
    }
  }

  async readMetadata(id: string): Promise<SessionMetadata | undefined> {
    if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) return undefined
    const path = resolve(this.sessionsDir, id, "metadata.json")
    try {
      return JSON.parse(await readFile(path, "utf8")) as SessionMetadata
    } catch {
      return undefined
    }
  }

  private async readIndex(): Promise<SessionMetadata[]> {
    let content: string
    try {
      content = await readFile(this.indexPath, "utf8")
    } catch {
      return []
    }
    const output: SessionMetadata[] = []
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as SessionMetadata
        if (item && typeof item.id === "string" && typeof item.cwd === "string") output.push(item)
      } catch {
        // A corrupt index line should not make transcript-based resume impossible.
      }
    }
    return output
  }
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

export class SessionMetadataUpdater {
  private warned = false

  constructor(
    private readonly store: SessionStore,
    private readonly plan: SessionPlan,
    private readonly stderr: NodeJS.WritableStream = process.stderr,
  ) {}

  async handle(event: SessionEvent): Promise<void> {
    try {
      if (event.type === "session.started") await this.store.update(this.plan, { updatedAt: event.timestamp })
      else if (event.type === "user.message") {
        await this.store.update(this.plan, {
          lastUserPromptPreview: preview(event.message.content),
          updatedAt: event.timestamp,
        })
      } else if (event.type === "turn.ended") {
        await this.store.update(this.plan, { lastTurnEndReason: event.reason, updatedAt: event.timestamp })
      } else if (event.type === "compact.ended" && event.status === "succeeded") {
        await this.store.update(this.plan, { compactSummaryHash: event.summaryHash, updatedAt: event.timestamp })
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true
        this.stderr.write(`warning: failed to update session metadata: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

export function renderSessionPlan(plan: SessionPlan): string {
  return [
    `Session: ${plan.id}`,
    `Transcript: ${plan.transcriptPath}`,
    `Metadata: ${plan.metadataPath ?? "disabled (--transcript override)"}`,
    `Store: ${plan.defaultStore ? basename(resolve(plan.transcriptPath, "..", "..")) : "custom transcript"}`,
  ].join("\n")
}

export function renderConversationPreview(messages: InternalMessage[], maxMessages = 8): string {
  if (messages.length === 0) return "No previous conversation messages were restored."
  const visible = messages.slice(-maxMessages)
  const omitted = messages.length - visible.length
  const lines: string[] = []
  if (omitted > 0) lines.push(`... ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted ...`)
  for (const message of visible) {
    if (message.role === "user") {
      lines.push(`user: ${preview(message.content)}`)
    } else if (message.role === "assistant") {
      const suffix = message.toolCalls.length > 0 ? ` [${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? "" : "s"}]` : ""
      lines.push(`assistant: ${preview(message.content || "(tool call)")}${suffix}`)
    } else {
      lines.push(`tool(${message.toolName}): ${message.isError ? "error: " : ""}${preview(message.content)}`)
    }
  }
  return lines.join("\n")
}

function createSessionId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `sess_${stamp}_${suffix}`
}

function preview(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, path)
}
