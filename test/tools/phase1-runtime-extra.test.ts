import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { invalidToolInput, RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { ToolExecutionError } from "../../src/tools/result"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createTempWorkspace, deferred } from "../helpers"

describe("ToolRegistry extra boundaries", () => {
  test("returns registered tools by name and list callers cannot mutate registry order", () => {
    const registry = new ToolRegistry()
    const first = dummyTool("first")
    const second = dummyTool("second")

    registry.register(first)
    const listed = registry.list()
    listed.length = 0
    registry.register(second)

    expect(registry.get("first")).toBe(first)
    expect(registry.get("missing")).toBeUndefined()
    expect(registry.list().map((tool) => tool.name)).toEqual(["first", "second"])
    expect(registry.toOpenAiTools().map((tool) => tool.function.parameters)).toEqual([
      first.inputSchema,
      second.inputSchema,
    ])
  })
})

describe("RealToolRuntime extra boundaries", () => {
  test("treats invalid input sentinel as preflight error without parse or execute", async () => {
    const registry = new ToolRegistry()
    let parseCalled = false
    let executeCalled = false
    registry.register({
      ...dummyTool("json_tool"),
      parse(input) {
        parseCalled = true
        return input
      },
      async execute() {
        executeCalled = true
        return { content: "should not run" }
      },
    })
    const runtime = await createRuntime(registry)

    const results = await runtime.runBatch(
      [call("c1", "json_tool", invalidToolInput("{", "Unexpected end of JSON input"))],
      ctx(),
    )

    expect(parseCalled).toBe(false)
    expect(executeCalled).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: "c1", toolName: "json_tool", isError: true })
    expect(results[0]?.content).toContain("invalid_input")
    expect(results[0]?.content).toContain("Malformed JSON arguments: Unexpected end of JSON input")
  })

  test("parse failure causes a mixed read-only batch to execute serially", async () => {
    const registry = new ToolRegistry()
    const slowStarted = deferred<void>()
    const releaseSlow = deferred<void>()
    const executionOrder: string[] = []
    let observerStarted = false
    let parserExecuteCalled = false

    registry.register({
      ...dummyTool("slow_reader", true),
      async execute() {
        executionOrder.push("slow:start")
        slowStarted.resolve()
        await releaseSlow.promise
        executionOrder.push("slow:finish")
        return { content: "slow done" }
      },
    })
    registry.register({
      ...dummyTool("bad_parser", true),
      parse() {
        throw new ToolExecutionError("invalid_input", "parse rejected")
      },
      async execute() {
        parserExecuteCalled = true
        return { content: "should not run" }
      },
    })
    registry.register({
      ...dummyTool("observer", true),
      async execute() {
        observerStarted = true
        executionOrder.push("observer:start")
        return { content: "observer done" }
      },
    })
    const runtime = await createRuntime(registry)

    const running = runtime.runBatch(
      [call("c1", "slow_reader"), call("c2", "bad_parser"), call("c3", "observer")],
      ctx(),
    )
    await waitFor(slowStarted.promise, "slow reader did not start")
    await Promise.resolve()
    expect(observerStarted).toBe(false)

    releaseSlow.resolve()
    const results = await running

    expect(parserExecuteCalled).toBe(false)
    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2", "c3"])
    expect(results.map((result) => result.isError)).toEqual([false, true, false])
    expect(results[1]?.content).toContain("invalid_input")
    expect(results[2]?.content).toBe("observer done")
    expect(executionOrder).toEqual(["slow:start", "slow:finish", "observer:start"])
  })

  test("read-only concurrency still returns provider order under out-of-order completion", async () => {
    const registry = new ToolRegistry()
    const slowEntered = deferred<void>()
    const middleEntered = deferred<void>()
    const middleDone = deferred<void>()
    const releaseSlow = deferred<void>()
    const releaseMiddle = deferred<void>()
    const completionOrder: string[] = []

    registry.register({
      ...dummyTool("slow", true),
      async execute() {
        slowEntered.resolve()
        await releaseSlow.promise
        completionOrder.push("slow")
        return { content: "slow result" }
      },
    })
    registry.register({
      ...dummyTool("fast", true),
      async execute() {
        completionOrder.push("fast")
        return { content: "fast result" }
      },
    })
    registry.register({
      ...dummyTool("middle", true),
      async execute() {
        middleEntered.resolve()
        await releaseMiddle.promise
        completionOrder.push("middle")
        middleDone.resolve()
        return { content: "middle result" }
      },
    })
    const runtime = await createRuntime(registry)

    const running = runtime.runBatch([call("c1", "slow"), call("c2", "fast"), call("c3", "middle")], ctx())
    await Promise.all([
      waitFor(slowEntered.promise, "slow read-only tool did not start"),
      waitFor(middleEntered.promise, "middle read-only tool did not start"),
    ])
    expect(completionOrder).toEqual(["fast"])

    releaseMiddle.resolve()
    await waitFor(middleDone.promise, "middle read-only tool did not finish")
    expect(completionOrder).toEqual(["fast", "middle"])

    releaseSlow.resolve()
    const results = await running

    expect(completionOrder).toEqual(["fast", "middle", "slow"])
    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2", "c3"])
    expect(results.map((result) => result.content)).toEqual(["slow result", "fast result", "middle result"])
  })

  test("writer serial preserves read-after-write observable ordering", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "state.txt"), "before", "utf8")
    const registry = new ToolRegistry()
    const writerStarted = deferred<void>()
    const releaseWriter = deferred<void>()
    let readerStarted = false

    registry.register({
      ...dummyTool("write_state", false),
      async execute(_input, toolCtx) {
        writerStarted.resolve()
        await releaseWriter.promise
        await toolCtx.workspace.writeTextFile("state.txt", "after")
        return { content: "wrote after" }
      },
    })
    registry.register({
      ...dummyTool("read_state", true),
      async execute(_input, toolCtx) {
        readerStarted = true
        const file = await toolCtx.workspace.readTextFile("state.txt")
        return { content: `read ${file.content}` }
      },
    })
    const runtime = await createRuntime(registry, { root })

    const running = runtime.runBatch([call("c1", "write_state"), call("c2", "read_state")], ctx())
    await waitFor(writerStarted.promise, "writer did not start")
    await Promise.resolve()
    const readerStartedBeforeRelease = readerStarted
    releaseWriter.resolve()
    const results = await running

    expect(readerStartedBeforeRelease).toBe(false)
    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2"])
    expect(results.map((result) => result.content)).toEqual(["wrote after", "read after"])
  })

  test("aborted delayed writer using runtime workspace does not mutate after abort", async () => {
    const root = await createTempWorkspace()
    await writeFile(join(root, "state.txt"), "before", "utf8")
    const registry = new ToolRegistry()
    const writerStarted = deferred<void>()
    const releaseWriter = deferred<void>()
    const controller = new AbortController()

    registry.register({
      ...dummyTool("delayed_write", false),
      async execute(_input, toolCtx) {
        writerStarted.resolve()
        await releaseWriter.promise
        await toolCtx.workspace.writeTextFile("state.txt", "after")
        return { content: "wrote after abort" }
      },
    })
    const runtime = await createRuntime(registry, { root })

    const running = runtime.runBatch([call("c1", "delayed_write")], ctx(controller.signal))
    await waitFor(writerStarted.promise, "delayed writer did not start")
    controller.abort("stop")
    releaseWriter.resolve()
    const results = await running

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: "c1", isError: true })
    expect(results[0]?.content).toContain("aborted")
    expect(await readFile(join(root, "state.txt"), "utf8")).toBe("before")
  })

  test("tool execute returning isError normalizes as an error result", async () => {
    const registry = new ToolRegistry()
    registry.register({
      ...dummyTool("soft_fail", true),
      async execute() {
        return { content: "tool reported failure", isError: true }
      },
    })
    const runtime = await createRuntime(registry)

    const results = await runtime.runBatch([call("c1", "soft_fail")], ctx())

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: "c1", toolName: "soft_fail", isError: true })
    expect(results[0]?.content).toContain("Error (internal_error): tool reported failure")
  })

  test("result truncation marker preserves multi-byte UTF-8 boundaries", async () => {
    const registry = new ToolRegistry()
    const maxResultBytes = 53
    registry.register({
      ...dummyTool("emoji_output", true),
      async execute() {
        return { content: "🙂".repeat(20) }
      },
    })
    const runtime = await createRuntime(registry, { maxResultBytes })

    const results = await runtime.runBatch([call("c1", "emoji_output")], ctx())
    const content = results[0]?.content ?? ""
    const encoded = new TextEncoder().encode(content)

    expect(content).toContain("[truncated: output capped at 53 bytes]")
    expect(content).not.toContain("\uFFFD")
    expect(encoded.byteLength).toBeLessThanOrEqual(maxResultBytes)
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

async function createRuntime(
  registry: ToolRegistry,
  options: { root?: string; maxResultBytes?: number } = {},
): Promise<RealToolRuntime> {
  const root = options.root ?? (await createTempWorkspace())
  return new RealToolRuntime({
    registry,
    workspace: await WorkspaceFs.create(root),
    maxResultBytes: options.maxResultBytes,
  })
}

function ctx(signal = new AbortController().signal): ToolContext {
  return { sessionId: "s1", turnId: "t1", stepId: "step1", signal }
}

async function waitFor<T>(promise: Promise<T>, message: string, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
