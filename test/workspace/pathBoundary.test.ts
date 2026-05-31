import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ToolExecutionError } from "../../src/tools/result"
import { WorkspacePathBoundary } from "../../src/workspace/pathBoundary"
import { createTempWorkspace } from "../helpers"

describe("WorkspacePathBoundary", () => {
  test("allows relative and absolute paths inside the workspace", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "src.ts"), "ok", "utf8")
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead("src.ts")).resolves.toMatchObject({ relativePath: "src.ts" })
    await expect(boundary.resolveForRead(join(root, "src.ts"))).resolves.toMatchObject({ relativePath: "src.ts" })
  })

  test("denies traversal and absolute paths outside the workspace", async () => {
    const root = await createTempWorkspace()
    const outside = await createTempWorkspace("light-cc-outside-")
    await writeFile(join(outside, "secret.txt"), "no", "utf8")
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead("../secret.txt")).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForRead(join(outside, "secret.txt"))).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForWrite(join(outside, "new.txt"))).rejects.toMatchObject({ code: "path_denied" })
  })

  test("denies symlinks that escape the workspace for reads and new writes", async () => {
    const root = await createTempWorkspace()
    const outside = await createTempWorkspace("light-cc-outside-")
    await writeFile(join(outside, "secret.txt"), "no", "utf8")
    await symlink(join(outside, "secret.txt"), join(root, "link-file"))
    await symlink(outside, join(root, "link-dir"))
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead("link-file")).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForWrite("link-dir/new.txt")).rejects.toMatchObject({ code: "path_denied" })
  })

  test("hard denies sensitive paths", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, ".ssh"), { recursive: true })
    await writeFile(join(root, ".env"), "TOKEN=x", "utf8")
    await writeFile(join(root, ".ssh", "config"), "Host *", "utf8")
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead(".env")).rejects.toBeInstanceOf(ToolExecutionError)
    await expect(boundary.resolveForRead(".env")).rejects.toMatchObject({ code: "sensitive_path" })
    await expect(boundary.resolveForWrite("id_ed25519")).rejects.toMatchObject({ code: "sensitive_path" })
    await expect(boundary.resolveForRead(".ssh/config")).rejects.toMatchObject({ code: "sensitive_path" })
  })
})
