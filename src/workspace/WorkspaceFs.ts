import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ToolExecutionError } from "../tools/result"
import { WorkspacePathBoundary, type ResolvedWorkspacePath } from "./pathBoundary"

export type WorkspaceRead = ResolvedWorkspacePath & {
  content: string
  size: number
}

export class WorkspaceFs {
  constructor(
    readonly boundary: WorkspacePathBoundary,
    readonly maxReadBytes = 1024 * 1024,
  ) {}

  static async create(root: string, maxReadBytes?: number): Promise<WorkspaceFs> {
    return new WorkspaceFs(await WorkspacePathBoundary.create(root), maxReadBytes)
  }

  get root(): string {
    return this.boundary.root
  }

  async resolveForRead(path: string): Promise<ResolvedWorkspacePath> {
    return this.boundary.resolveForRead(path)
  }

  async resolveForWrite(path: string): Promise<ResolvedWorkspacePath> {
    return this.boundary.resolveForWrite(path)
  }

  async resolveSearchRoot(path?: string): Promise<ResolvedWorkspacePath> {
    return this.boundary.resolveSearchRoot(path)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveForRead(path)
      return true
    } catch (error) {
      if (error instanceof ToolExecutionError && error.code === "not_found") return false
      throw error
    }
  }

  async readTextFile(path: string, maxBytes = this.maxReadBytes): Promise<WorkspaceRead> {
    const resolved = await this.resolveForRead(path)
    let fileStat
    try {
      fileStat = await stat(resolved.realPath ?? resolved.absolutePath)
    } catch (error) {
      throw new ToolExecutionError("not_found", "Path does not exist", resolved.relativePath, error)
    }
    if (!fileStat.isFile()) {
      throw new ToolExecutionError("not_text", "Path is not a regular file", resolved.relativePath)
    }
    if (fileStat.size > maxBytes) {
      throw new ToolExecutionError("too_large", `File is larger than ${maxBytes} bytes`, resolved.relativePath)
    }

    const bytes = await readFile(resolved.realPath ?? resolved.absolutePath)
    if (bytes.includes(0)) {
      throw new ToolExecutionError("not_text", "File appears to be binary", resolved.relativePath)
    }
    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (error) {
      throw new ToolExecutionError("not_text", "File is not valid UTF-8 text", resolved.relativePath, error)
    }
    return { ...resolved, content, size: bytes.byteLength }
  }

  async writeTextFile(path: string, content: string): Promise<ResolvedWorkspacePath> {
    const resolved = await this.resolveForWrite(path)
    try {
      await mkdir(dirname(resolved.absolutePath), { recursive: true })
      await writeFile(resolved.absolutePath, content, "utf8")
      return resolved
    } catch (error) {
      throw new ToolExecutionError("io_error", "Failed to write file; partial write risk is unknown", resolved.relativePath, error)
    }
  }
}
