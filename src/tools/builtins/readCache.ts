import { createHash } from "node:crypto"
import type { ToolExecutionContext } from "../registry"

type ReadCacheEntry = {
  hash: string
  end: number
  totalLines: number
}

type ReadCacheCandidate = {
  relativePath: string
  start: number
  limit: number
  end: number
  totalLines: number
  content: string
}

const readCache = new Map<string, ReadCacheEntry>()
const pathIndex = new Map<string, Set<string>>()

export function repeatedReadStub(ctx: ToolExecutionContext, candidate: ReadCacheCandidate): string | undefined {
  const key = cacheKey(ctx, candidate.relativePath, candidate.start, candidate.limit)
  const hash = hashText(candidate.content)
  const previous = readCache.get(key)
  rememberRead(key, pathKey(ctx, candidate.relativePath), {
    hash,
    end: candidate.end,
    totalLines: candidate.totalLines,
  })
  if (!previous || previous.hash !== hash) return undefined

  const range =
    candidate.start === previous.end ? `line ${candidate.start}` : `lines ${candidate.start}-${previous.end}`
  const marker =
    previous.end < previous.totalLines
      ? "\n[more: use grep to find a symbol or read with line+context; offset paging is disabled]"
      : ""
  return `File: ${candidate.relativePath}\n[repeat read: ${range} unchanged; duplicate content omitted]${marker}`
}

export function invalidateReadCacheForPath(ctx: ToolExecutionContext, relativePath: string): void {
  const normalized = normalizePath(relativePath)
  const indexed = pathIndex.get(pathKey(ctx, normalized))
  if (!indexed) return
  for (const key of indexed) readCache.delete(key)
  pathIndex.delete(pathKey(ctx, normalized))
}

function rememberRead(key: string, indexedPath: string, entry: ReadCacheEntry): void {
  readCache.set(key, entry)
  const keys = pathIndex.get(indexedPath) ?? new Set<string>()
  keys.add(key)
  pathIndex.set(indexedPath, keys)
}

function cacheKey(ctx: ToolExecutionContext, relativePath: string, start: number, limit: number): string {
  return `${ctx.sessionId}\0${ctx.workspace.root}\0${normalizePath(relativePath)}\0${start}\0${limit}`
}

function pathKey(ctx: ToolExecutionContext, relativePath: string): string {
  return `${ctx.sessionId}\0${ctx.workspace.root}\0${normalizePath(relativePath)}`
}

function normalizePath(path: string): string {
  const normalized = path.split("\\").join("/")
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}
