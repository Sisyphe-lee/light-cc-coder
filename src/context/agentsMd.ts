import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { join } from "node:path"

export type AgentsMdContext = {
  path: string
  absolutePath: string
  content: string
  bytes: number
  originalBytes: number
  truncated: boolean
  maxBytes: number
  hash: string
}

export async function loadRootAgentsMd(root: string, maxBytes = 32 * 1024): Promise<AgentsMdContext | undefined> {
  const absolutePath = join(root, "AGENTS.md")
  let handle
  try {
    handle = await open(absolutePath, "r")
  } catch {
    return undefined
  }

  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) return undefined

    const cappedBytes = Math.max(0, Math.floor(maxBytes))
    const bytesToRead = Math.min(fileStat.size, cappedBytes)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = bytesToRead > 0 ? await handle.read(buffer, 0, bytesToRead, 0) : { bytesRead: 0 }
    const content = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, bytesRead))
    return {
      path: "AGENTS.md",
      absolutePath,
      content,
      bytes: bytesRead,
      originalBytes: fileStat.size,
      truncated: fileStat.size > cappedBytes,
      maxBytes: cappedBytes,
      hash: createHash("sha256").update(content).digest("hex"),
    }
  } finally {
    await handle.close()
  }
}
