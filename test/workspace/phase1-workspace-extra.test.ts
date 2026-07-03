import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { WorkspacePathBoundary } from "../../src/workspace/pathBoundary"
import { createTempWorkspace } from "../helpers"

describe("WorkspacePathBoundary extra boundaries", () => {
  test("denies sibling paths that only share the workspace string prefix", async () => {
    const root = await createTempWorkspace()
    const outside = `${root}-sibling`
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "secret.txt"), "no", "utf8")
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead(join(outside, "secret.txt"))).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForWrite(join(outside, "new.txt"))).rejects.toMatchObject({ code: "path_denied" })
  })

  test("returns workspace-relative display paths for absolute paths inside the workspace", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "nested"), { recursive: true })
    await writeFile(join(root, "nested", "file.txt"), "ok", "utf8")
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead(join(root, "nested", "file.txt"))).resolves.toMatchObject({
      relativePath: "nested/file.txt",
    })
    expect(boundary.displayPath(join(root, "nested", "file.txt"))).toBe("nested/file.txt")
  })

  test("rejects URL-like, tilde, and NUL-containing paths before filesystem lookup", async () => {
    const root = await createTempWorkspace()
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead("https://example.test/file.txt")).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForRead("file:///tmp/file.txt")).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForWrite("~/file.txt")).rejects.toMatchObject({ code: "path_denied" })
    await expect(boundary.resolveForRead("nested/\0file.txt")).rejects.toMatchObject({ code: "path_denied" })
  })

  test("allows new write paths under an existing contained ancestor", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "src"), { recursive: true })
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForWrite("src/generated/new.txt")).resolves.toMatchObject({
      relativePath: "src/generated/new.txt",
    })
  })

  test("allows existing symlinks to contained workspace targets", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "targets"), { recursive: true })
    await writeFile(join(root, "targets", "inside.txt"), "ok", "utf8")
    await symlink(join(root, "targets", "inside.txt"), join(root, "inside-link.txt"))
    const boundary = await WorkspacePathBoundary.create(root)

    await expect(boundary.resolveForRead("inside-link.txt")).resolves.toMatchObject({
      relativePath: "targets/inside.txt",
    })
    await expect(boundary.resolveForWrite("inside-link.txt")).resolves.toMatchObject({
      relativePath: "targets/inside.txt",
    })
  })
})

describe("WorkspaceFs extra boundaries", () => {
  test("rejects directory reads as not_text and points at glob/grep", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "dir"), { recursive: true })
    const workspace = await WorkspaceFs.create(root)

    await expect(workspace.readTextFile("dir")).rejects.toMatchObject({ code: "not_text" })
    await expect(workspace.readTextFile("dir")).rejects.toThrow(/directory/i)
    await expect(workspace.readTextFile("dir")).rejects.toThrow(/glob/i)
  })

  test("rejects invalid UTF-8 files as not_text", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "invalid.txt"), new Uint8Array([0xc3, 0x28]))
    const workspace = await WorkspaceFs.create(root)

    await expect(workspace.readTextFile("invalid.txt")).rejects.toMatchObject({ code: "not_text" })
  })
})
