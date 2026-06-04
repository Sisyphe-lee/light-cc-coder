import { describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createTempWorkspace } from "../helpers"

describe("built-in file tools", () => {
  test("read returns line numbers, line context, missing, binary, and too_large errors", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n", "utf8")
    await writeFile(join(root, "bin.dat"), new Uint8Array([1, 0, 2]))
    await writeFile(join(root, "large.txt"), "abcdef", "utf8")
    const runtime = await runtimeFor(root)
    const smallRuntime = await runtimeFor(root, 3)

    const ok = await runtime.runBatch([call("c1", "read", { path: "a.txt", line: 2, context: 0 })], ctx())
    const missing = await runtime.runBatch([call("c2", "read", { path: "missing.txt" })], ctx())
    const binary = await runtime.runBatch([call("c3", "read", { path: "bin.dat" })], ctx())
    const tooLarge = await smallRuntime.runBatch([call("c4", "read", { path: "large.txt" })], ctx())

    expect(ok[0]?.content).toContain("2 | two")
    expect(missing[0]).toMatchObject({ isError: true })
    expect(missing[0]?.content).toContain("not_found")
    expect(binary[0]?.content).toContain("not_text")
    expect(tooLarge[0]?.content).toContain("too_large")
  })

  test("read rejects offset paging and oversized previews", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n", "utf8")
    const runtime = await runtimeFor(root)

    const pathOnly = await runtime.runBatch([call("c0", "read", { path: "a.txt" })], ctx())
    const offsetPaging = await runtime.runBatch([call("c1", "read", { path: "a.txt", offset: 2, limit: 1 })], ctx())
    const oversizedPreview = await runtime.runBatch([call("c2", "read", { path: "a.txt", limit: 81 })], ctx())

    expect(pathOnly[0]).toMatchObject({ isError: false })
    expect(pathOnly[0]?.content).toContain("Warning: path-only preview is coarse and capped at 80 lines")
    expect(offsetPaging[0]).toMatchObject({ isError: true })
    expect(offsetPaging[0]?.content).toContain("offset paging is disabled")
    expect(oversizedPreview[0]).toMatchObject({ isError: true })
    expect(oversizedPreview[0]?.content).toContain("limit must be <= 80")
  })

  test("glob returns sorted files, honors ignored dirs, caps results, and does not follow symlink dirs", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
    await mkdir(join(root, "references", "repos", "x"), { recursive: true })
    const outside = await createTempWorkspace("light-cc-outside-")
    await writeFile(join(root, "b.ts"), "", "utf8")
    await writeFile(join(root, "src", "a.ts"), "", "utf8")
    await writeFile(join(root, "node_modules", "pkg", "hidden.ts"), "", "utf8")
    await writeFile(join(root, "references", "repos", "x", "hidden.ts"), "", "utf8")
    await writeFile(join(outside, "outside.ts"), "", "utf8")
    await symlink(outside, join(root, "linked"))
    const runtime = await runtimeFor(root)

    const result = await runtime.runBatch([call("c1", "glob", { pattern: "**/*.ts", maxResults: 1 })], ctx())

    expect(result[0]?.content).toContain("b.ts")
    expect(result[0]?.content).toContain("[truncated:")
    expect(result[0]?.content).not.toContain("hidden.ts")
    expect(result[0]?.content).not.toContain("outside.ts")
  })

  test("grep finds matches, caps results, reports invalid regex, and respects path boundary", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "a.ts"), "Alpha\nbeta\nalphabet\n", "utf8")
    const runtime = await runtimeFor(root)

    const matches = await runtime.runBatch([call("c1", "grep", { pattern: "alpha", caseSensitive: false, maxResults: 1 })], ctx())
    const invalid = await runtime.runBatch([call("c2", "grep", { pattern: "[" })], ctx())
    const outside = await runtime.runBatch([call("c3", "grep", { pattern: "x", path: "../outside" })], ctx())
    const filePath = await runtime.runBatch([call("c4", "grep", { pattern: "beta", path: "src/a.ts" })], ctx())

    expect(matches[0]?.content).toContain("src/a.ts:1:1:Alpha")
    expect(matches[0]?.content).toContain("[truncated:")
    expect(invalid[0]).toMatchObject({ isError: true })
    expect(invalid[0]?.content).toContain("invalid_input")
    expect(outside[0]?.content).toContain("path_denied")
    expect(filePath[0]?.content).toContain("src/a.ts:2:1:beta")
  })

  test("grep supports context, files_with_matches, and count output modes", async () => {
    const root = await createTempWorkspace()
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "a.ts"), "before\nneedle one\nafter\n", "utf8")
    await writeFile(join(root, "src", "b.ts"), "needle two\nneedle three\n", "utf8")
    const runtime = await runtimeFor(root)

    const context = await runtime.runBatch(
      [call("c1", "grep", { pattern: "needle", path: "src/a.ts", context: 1, maxResults: 1 })],
      ctx(),
    )
    const files = await runtime.runBatch(
      [call("c2", "grep", { pattern: "needle", output_mode: "files_with_matches", maxResults: 1 })],
      ctx(),
    )
    const counts = await runtime.runBatch(
      [call("c3", "grep", { pattern: "needle", output_mode: "count", path: "src" })],
      ctx(),
    )

    expect(context[0]?.content).toContain("src/a.ts:1:-:before")
    expect(context[0]?.content).toContain("src/a.ts:2:1:needle one")
    expect(context[0]?.content).toContain("src/a.ts:3:-:after")
    expect(files[0]?.content).toContain("Files:\nsrc/a.ts")
    expect(files[0]?.content).toContain("[truncated: more than 1 files with matches]")
    expect(counts[0]?.content).toContain("Counts:")
    expect(counts[0]?.content).toContain("src/a.ts:1")
    expect(counts[0]?.content).toContain("src/b.ts:2")
  })

  test("read supports line context windows and deduplicates unchanged repeated ranges", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8")
    const runtime = await runtimeFor(root)

    const first = await runtime.runBatch([call("c1", "read", { path: "a.txt", line: 4, context: 1 })], ctx())
    const repeat = await runtime.runBatch([call("c2", "read", { path: "a.txt", line: 4, context: 1 })], ctx())
    const edit = await runtime.runBatch([call("c3", "edit", { path: "a.txt", oldText: "four", newText: "FOUR" })], ctx())
    const afterEdit = await runtime.runBatch([call("c4", "read", { path: "a.txt", line: 4, context: 1 })], ctx())

    expect(first[0]?.content).toContain("3 | three")
    expect(first[0]?.content).toContain("4 | four")
    expect(first[0]?.content).toContain("5 | five")
    expect(first[0]?.content).not.toContain("2 | two")
    expect(repeat[0]?.content).toContain("[repeat read: lines 3-5 unchanged; duplicate content omitted]")
    expect(repeat[0]?.content).not.toContain("4 | four")
    expect(edit[0]?.content).toContain("Edited a.txt")
    expect(afterEdit[0]?.content).toContain("4 | FOUR")
    expect(afterEdit[0]?.content).not.toContain("[repeat read:")
  })

  test("edit unique replace writes diff while missing/duplicate/outside/sensitive fail without writing", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "one\ntwo\n", "utf8")
    await writeFile(join(root, "dup.txt"), "same same", "utf8")
    await writeFile(join(root, ".env"), "SECRET=x", "utf8")
    const runtime = await runtimeFor(root)

    const ok = await runtime.runBatch([call("c1", "edit", { path: "a.txt", oldText: "two", newText: "three" })], ctx())
    const missing = await runtime.runBatch([call("c2", "edit", { path: "a.txt", oldText: "absent", newText: "x" })], ctx())
    const duplicate = await runtime.runBatch([call("c3", "edit", { path: "dup.txt", oldText: "same", newText: "x" })], ctx())
    const outside = await runtime.runBatch([call("c4", "edit", { path: "../out.txt", oldText: "x", newText: "y" })], ctx())
    const sensitive = await runtime.runBatch([call("c5", "edit", { path: ".env", oldText: "SECRET", newText: "PUBLIC" })], ctx())

    expect(ok[0]?.content).toContain("Edited a.txt")
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\nthree\n")
    expect(missing[0]?.content).toContain("not_unique")
    expect(missing[0]?.content).toContain("oldText was not found in a.txt")
    expect(missing[0]?.content).toContain("retry with exact whitespace")
    expect(duplicate[0]?.content).toContain("not_unique")
    expect(duplicate[0]?.content).toContain("oldText appears 2 times")
    expect(duplicate[0]?.content).toContain("Matching occurrence contexts")
    expect(outside[0]?.content).toMatch(/path_denied|not_found/)
    expect(sensitive[0]?.content).toContain("sensitive_path")
    expect(await readFile(join(root, "dup.txt"), "utf8")).toBe("same same")
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=x")
  })

  test("write creates, refuses existing without overwrite, overwrites with diff, and denies outside", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "existing.txt"), "old\n", "utf8")
    const runtime = await runtimeFor(root)

    const created = await runtime.runBatch([call("c1", "write", { path: "nested/new.txt", content: "new\n" })], ctx())
    const refused = await runtime.runBatch([call("c2", "write", { path: "existing.txt", content: "bad\n" })], ctx())
    const overwritten = await runtime.runBatch([call("c3", "write", { path: "existing.txt", content: "new\n", overwrite: true })], ctx())
    const outside = await runtime.runBatch([call("c4", "write", { path: "../outside.txt", content: "no" })], ctx())

    expect(created[0]?.content).toContain("Created nested/new.txt")
    expect(refused[0]).toMatchObject({ isError: true })
    expect(refused[0]?.content).toContain("patch_conflict")
    expect(overwritten[0]?.content).toContain("Wrote existing.txt")
    expect(outside[0]).toMatchObject({ isError: true })
    expect(outside[0]?.content).toContain("path_denied")
    expect(await readFile(join(root, "nested", "new.txt"), "utf8")).toBe("new\n")
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("new\n")
  })

  test("apply_patch supports add/update/delete and failures do not partially write", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "a.txt"), "one\ntwo\n", "utf8")
    await writeFile(join(root, "delete.txt"), "remove\n", "utf8")
    const runtime = await runtimeFor(root)

    const validPatch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+created",
      "*** Update File: a.txt",
      "@@",
      " one",
      "-two",
      "+three",
      "*** Delete File: delete.txt",
      "*** End Patch",
    ].join("\n")
    const ok = await runtime.runBatch([call("c1", "apply_patch", { patch: validPatch })], ctx())

    expect(ok[0]?.content).toContain("Added new.txt")
    expect(ok[0]?.content).toContain("Updated a.txt")
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created\n")
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\nthree\n")

    await writeFile(join(root, "chained.txt"), "a\nb\nc\n", "utf8")
    const chainedPatch = [
      "*** Begin Patch",
      "*** Update File: chained.txt",
      "@@",
      " a",
      "-b",
      "+B",
      " c",
      "*** Update File: chained.txt",
      "@@",
      " a",
      "-B",
      "+BB",
      " c",
      "*** End Patch",
    ].join("\n")
    const chained = await runtime.runBatch([call("c2", "apply_patch", { patch: chainedPatch })], ctx())
    expect(chained[0]).toMatchObject({ isError: false })
    expect(await readFile(join(root, "chained.txt"), "utf8")).toBe("a\nBB\nc\n")

    const before = await readFile(join(root, "a.txt"), "utf8")
    const badPatch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-does-not-exist",
      "+bad",
      "*** Add File: should-not-exist.txt",
      "+bad",
      "*** End Patch",
    ].join("\n")
    const conflict = await runtime.runBatch([call("c3", "apply_patch", { patch: badPatch })], ctx())
    const malformed = await runtime.runBatch([call("c4", "apply_patch", { patch: "*** nope" })], ctx())
    const outside = await runtime.runBatch([
      call("c5", "apply_patch", { patch: "*** Begin Patch\n*** Add File: ../x.txt\n+bad\n*** End Patch" }),
    ], ctx())

    expect(conflict[0]).toMatchObject({ isError: true })
    expect(conflict[0]?.content).toContain("patch_conflict")
    expect(malformed[0]?.content).toContain("malformed_patch")
    expect(outside[0]?.content).toContain("malformed_patch")
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe(before)
    await expect(readFile(join(root, "should-not-exist.txt"), "utf8")).rejects.toThrow()
  })
})

async function runtimeFor(root: string, maxReadBytes?: number): Promise<RealToolRuntime> {
  return new RealToolRuntime({
    registry: createBuiltinToolRegistry(),
    workspace: await WorkspaceFs.create(root, maxReadBytes),
  })
}

function ctx(): ToolContext {
  return { sessionId: "s1", turnId: "t1", stepId: "step1", signal: new AbortController().signal }
}
