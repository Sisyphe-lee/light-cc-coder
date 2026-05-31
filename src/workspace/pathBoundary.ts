import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { ToolExecutionError } from "../tools/result"

export type ResolvedWorkspacePath = {
  inputPath: string
  absolutePath: string
  relativePath: string
  realPath?: string
}

export class WorkspacePathBoundary {
  readonly root: string

  private constructor(root: string) {
    this.root = root
  }

  static async create(root: string): Promise<WorkspacePathBoundary> {
    const resolved = await realpath(resolve(root))
    return new WorkspacePathBoundary(resolved)
  }

  async resolveForRead(inputPath: string): Promise<ResolvedWorkspacePath> {
    this.validateRawPath(inputPath)
    const absolutePath = this.toAbsolute(inputPath)
    this.assertContained(absolutePath, inputPath)
    let realTarget: string
    try {
      realTarget = await realpath(absolutePath)
    } catch (error) {
      throw new ToolExecutionError("not_found", "Path does not exist", safeSubject(inputPath), error)
    }
    this.assertContained(realTarget, inputPath)
    const relativePath = this.relativeFor(realTarget)
    this.assertNotSensitive(relativePath)
    return { inputPath, absolutePath, realPath: realTarget, relativePath }
  }

  async resolveForWrite(inputPath: string): Promise<ResolvedWorkspacePath> {
    this.validateRawPath(inputPath)
    const absolutePath = this.toAbsolute(inputPath)
    const existing = await maybeRealpath(absolutePath)
    if (existing) {
      this.assertContained(existing, inputPath)
      const relativePath = this.relativeFor(existing)
      this.assertNotSensitive(relativePath)
      return { inputPath, absolutePath, realPath: existing, relativePath }
    }

    const ancestor = await deepestExistingAncestor(absolutePath)
    if (!ancestor) {
      throw new ToolExecutionError("path_denied", "No existing ancestor for path", safeSubject(inputPath))
    }
    const ancestorReal = await realpath(ancestor)
    this.assertContained(ancestorReal, inputPath)

    const relativePath = this.relativeFor(absolutePath)
    this.assertContained(absolutePath, inputPath)
    this.assertNotSensitive(relativePath)
    return { inputPath, absolutePath, relativePath }
  }

  async resolveSearchRoot(inputPath?: string): Promise<ResolvedWorkspacePath> {
    if (inputPath === undefined || inputPath === "") {
      return {
        inputPath: ".",
        absolutePath: this.root,
        realPath: this.root,
        relativePath: ".",
      }
    }
    return this.resolveForRead(inputPath)
  }

  displayPath(absolutePath: string): string {
    return this.relativeFor(absolutePath)
  }

  private toAbsolute(inputPath: string): string {
    return isAbsolute(inputPath) ? resolve(inputPath) : resolve(this.root, inputPath)
  }

  private validateRawPath(inputPath: string): void {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new ToolExecutionError("invalid_input", "Path must be a non-empty string")
    }
    if (inputPath.includes("\0")) {
      throw new ToolExecutionError("path_denied", "Path contains a NUL byte")
    }
    if (inputPath === "~" || inputPath.startsWith("~/")) {
      throw new ToolExecutionError("path_denied", "Tilde paths are not allowed", safeSubject(inputPath))
    }
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(inputPath) || inputPath.startsWith("file:")) {
      throw new ToolExecutionError("path_denied", "URL-like paths are not allowed", safeSubject(inputPath))
    }
  }

  private assertContained(pathToCheck: string, inputPath: string): void {
    const rel = relative(this.root, pathToCheck)
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return
    throw new ToolExecutionError("path_denied", "Path is outside the workspace", safeSubject(inputPath))
  }

  private relativeFor(pathToDisplay: string): string {
    const rel = relative(this.root, pathToDisplay)
    return rel === "" ? "." : rel.split(sep).join("/")
  }

  private assertNotSensitive(relativePath: string): void {
    if (isSensitiveRelativePath(relativePath)) {
      throw new ToolExecutionError("sensitive_path", "Sensitive path is denied", relativePath)
    }
  }
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = relativePath.split("\\").join("/")
  const parts = normalized.split("/").filter(Boolean)
  const base = basename(normalized)

  if (base === ".env" || base.startsWith(".env.")) return true
  if (["id_rsa", "id_ed25519", "id_dsa", "id_ecdsa"].includes(base)) return true
  if (base.endsWith(".pem") || base.endsWith(".key")) return true
  if (parts.includes(".ssh")) return true

  if (normalized === ".aws/credentials" || normalized === ".aws/config") return true
  if (normalized === ".kube/config") return true
  if (normalized === ".docker/config.json") return true
  if (normalized.startsWith(".config/gcloud/")) return true

  return false
}

function safeSubject(inputPath: string): string {
  return inputPath.replaceAll("\0", "")
}

async function maybeRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function deepestExistingAncestor(path: string): Promise<string | undefined> {
  let current = path
  while (true) {
    try {
      await lstat(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}
