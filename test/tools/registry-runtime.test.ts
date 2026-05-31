import { describe, expect, test } from "bun:test"
import { ToolExecutionError } from "../../src/tools/result"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createTempWorkspace, deferred } from "../helpers"

describe("ToolRegistry", () => {
  test("exports OpenAI-compatible schemas in registration order and rejects duplicates", () => {
    const registry = new ToolRegistry()
    registry.register(dummyTool("first"))
    registry.register(dummyTool("second"))

    expect(registry.toOpenAiTools().map((tool) => tool.function.name)).toEqual(["first", "second"])
    expect(() => registry.register(dummyTool("first"))).toThrow("Duplicate tool name")
  })
})

describe("RealToolRuntime", () => {
  test("turns unknown, invalid, and thrown tool failures into ordered tool results", async () => {
    const registry = new ToolRegistry()
    registry.register({
      ...dummyTool("validated"),
      parse() {
        throw new ToolExecutionError("invalid_input", "bad input")
      },
    })
    registry.register({
      ...dummyTool("throws"),
      async execute() {
        throw new Error("boom")
      },
    })
    const runtime = await createRuntime(registry)

    const results = await runtime.runBatch(
      [call("c1", "missing"), call("c2", "validated"), call("c3", "throws")],
      ctx(),
    )

    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2", "c3"])
    expect(results.every((result) => result.isError)).toBe(true)
    expect(results[0]?.content).toContain("unknown_tool")
    expect(results[1]?.content).toContain("invalid_input")
    expect(results[2]?.content).toContain("internal_error")
  })

  test("runs all-read-only batches concurrently but returns provider order", async () => {
    const registry = new ToolRegistry()
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const release = deferred<void>()
    registry.register({
      ...dummyTool("first", true),
      async execute() {
        firstEntered.resolve()
        await release.promise
        return { content: "first done" }
      },
    })
    registry.register({
      ...dummyTool("second", true),
      async execute() {
        secondEntered.resolve()
        return { content: "second done" }
      },
    })
    const runtime = await createRuntime(registry)

    const running = runtime.runBatch([call("c1", "first"), call("c2", "second")], ctx())
    await Promise.all([firstEntered.promise, secondEntered.promise])
    release.resolve()
    const results = await running

    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2"])
    expect(results.map((result) => result.content)).toEqual(["first done", "second done"])
  })

  test("serializes the whole batch when a writer is present", async () => {
    const registry = new ToolRegistry()
    const writerEntered = deferred<void>()
    const releaseWriter = deferred<void>()
    let readerStarted = false
    registry.register({
      ...dummyTool("writer", false),
      async execute() {
        writerEntered.resolve()
        await releaseWriter.promise
        return { content: "writer done" }
      },
    })
    registry.register({
      ...dummyTool("reader", true),
      async execute() {
        readerStarted = true
        return { content: "reader done" }
      },
    })
    const runtime = await createRuntime(registry)

    const running = runtime.runBatch([call("c1", "writer"), call("c2", "reader")], ctx())
    await writerEntered.promise
    expect(readerStarted).toBe(false)
    releaseWriter.resolve()
    const results = await running

    expect(readerStarted).toBe(true)
    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2"])
  })

  test("returns paired aborted result and truncates long UTF-8 output", async () => {
    const registry = new ToolRegistry()
    registry.register(dummyTool("ok"))
    registry.register({
      ...dummyTool("long"),
      async execute() {
        return { content: "é".repeat(200) }
      },
    })
    const workspace = await WorkspaceFs.create(await createTempWorkspace())
    const runtime = new RealToolRuntime({ registry, workspace, maxResultBytes: 80 })
    const controller = new AbortController()
    controller.abort("stop")

    const aborted = await runtime.runBatch([call("c1", "ok")], ctx(controller.signal))
    const long = await runtime.runBatch([call("c2", "long")], ctx())

    expect(aborted).toHaveLength(1)
    expect(aborted[0]).toMatchObject({ toolCallId: "c1", isError: true })
    expect(aborted[0]?.content).toContain("aborted")
    expect(long[0]?.content).toContain("[truncated:")
    expect(() => new TextEncoder().encode(long[0]?.content ?? "")).not.toThrow()
  })
})

function dummyTool(name: string, readOnly = true): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    readOnly,
    inputSchema: { type: "object", additionalProperties: true },
    parse(input) {
      return input
    },
    async execute() {
      return { content: `ok:${name}` }
    },
  }
}

async function createRuntime(registry: ToolRegistry): Promise<RealToolRuntime> {
  return new RealToolRuntime({
    registry,
    workspace: await WorkspaceFs.create(await createTempWorkspace()),
  })
}

function ctx(signal = new AbortController().signal): ToolContext {
  return { sessionId: "s1", turnId: "t1", stepId: "step1", signal }
}
