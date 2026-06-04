import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { SessionHooks } from "../../src/extensions/hooks"
import type { ApprovalRequester, PermissionMode } from "../../src/permissions/types"
import { RealToolRuntime, type ToolContext } from "../../src/tools/ToolRuntime"
import { createBuiltinToolRegistry } from "../../src/tools/builtins"
import { gitFeedbackTool } from "../../src/tools/builtins/gitFeedback"
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry"
import { WorkspaceFs } from "../../src/workspace/WorkspaceFs"
import { call, createDraftRecorder, createTempWorkspace, deferred } from "../helpers"

const execFileAsync = promisify(execFile)

describe("Phase 6 git_feedback trigger and permission boundaries", () => {
  test("exposes a stable read-only builtin schema", async () => {
    const runtime = await createRuntime(await createTempWorkspace(), "read-only")

    const tools = runtime.listTools()
    const schemas = runtime.getToolSchemas() as OpenAiToolSchema[]
    const info = tools.find((tool) => tool.name === "git_feedback")
    const schema = schemas.find((tool) => tool.function.name === "git_feedback")

    expect(info).toMatchObject({
      name: "git_feedback",
      readOnly: true,
    })
    expect(info?.description).toContain("Inspect git branch")
    expect(schema).toMatchObject({
      type: "function",
      function: {
        name: "git_feedback",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: {
              type: "string",
            },
          },
          required: ["reason"],
        },
      },
    })
    expect(schema?.function.description).toContain("never mutates git state")
  })

  test("succeeds in non-git read-only workspaces without requesting approval", async () => {
    const root = await createTempWorkspace()
    const runtime = await createRuntime(root, "read-only")
    const recorder = createDraftRecorder()
    let approvals = 0

    const results = await runtime.runBatch(
      [call("c1", "git_feedback", { reason: "user requested git state" })],
      ctx({
        emit: recorder.emit,
        approvals: approvalCounter(() => {
          approvals += 1
        }),
      }),
    )

    expect(approvals).toBe(0)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "git_feedback",
      isError: false,
    })
    expect(results[0]?.content).toContain("Repository: no")
    expect(results[0]?.content).toContain("workspace is not inside a git repository")
    expect(permissionDecisions(recorder.events)).toEqual([
      expect.objectContaining({
        toolCallId: "c1",
        toolName: "git_feedback",
        mode: "read-only",
        decision: "allow",
        reason: "Read-only tool is allowed",
      }),
    ])
  })

  test("succeeds in workspace-write mode without requesting approval", async () => {
    const root = await createTempWorkspace()
    await initRepo(root)
    await writeFile(join(root, "tracked.txt"), "before\n", "utf8")
    await git(root, ["add", "tracked.txt"])
    await git(root, ["commit", "-m", "init"])
    await writeFile(join(root, "tracked.txt"), "after\n", "utf8")
    const runtime = await createRuntime(root, "workspace-write")
    const recorder = createDraftRecorder()
    let approvals = 0

    const results = await runtime.runBatch(
      [call("c1", "git_feedback", { reason: "user requested changed files" })],
      ctx({
        emit: recorder.emit,
        approvals: approvalCounter(() => {
          approvals += 1
        }),
      }),
    )

    expect(approvals).toBe(0)
    expect(results[0]).toMatchObject({
      toolName: "git_feedback",
      isError: false,
    })
    expect(results[0]?.content).toContain("Repository: yes")
    expect(results[0]?.content).toContain("tracked.txt")
    expect(permissionDecisions(recorder.events)).toEqual([
      expect.objectContaining({
        toolName: "git_feedback",
        mode: "workspace-write",
        decision: "allow",
        reason: "Workspace file/read tool is allowed",
      }),
    ])
  })

  test("read-only batch runs git_feedback concurrently but returns provider order", async () => {
    const root = await createTempWorkspace()
    const slowStarted = deferred<void>()
    const releaseSlow = deferred<void>()
    const gitFinished = deferred<void>()
    const completionOrder: string[] = []
    const registry = new ToolRegistry()
    registry.register({
      ...emptyObjectTool("slow_read_only", true),
      async execute() {
        slowStarted.resolve()
        await releaseSlow.promise
        return { content: "slow done" }
      },
    })
    registry.register(gitFeedbackTool)
    const runtime = await createRuntime(root, "read-only", {
      registry,
      hooks: {
        postTool: [
          (input) => {
            completionOrder.push(input.toolCall.name)
            if (input.toolCall.name === "git_feedback") gitFinished.resolve()
          },
        ],
      },
    })

    const running = runtime.runBatch(
      [call("c1", "slow_read_only", {}), call("c2", "git_feedback", { reason: "user requested git state" })],
      ctx({ approvals: approvalCounter(() => expect.unreachable("git_feedback should not request approval")) }),
    )

    let results: Awaited<ReturnType<RealToolRuntime["runBatch"]>> | undefined
    try {
      await waitFor(slowStarted.promise, "slow read-only tool did not start")
      await waitFor(gitFinished.promise, "git_feedback did not run while the first read-only tool was pending")
      expect(completionOrder).toEqual(["git_feedback"])
    } finally {
      releaseSlow.resolve()
      results = await running
    }

    expect(completionOrder).toEqual(["git_feedback", "slow_read_only"])
    expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2"])
    expect(results.map((result) => result.toolName)).toEqual(["slow_read_only", "git_feedback"])
    expect(results[0]?.content).toBe("slow done")
    expect(results[1]?.content).toContain("Repository: no")
  })

  test("redacts sensitive path diff content while still reporting the changed file", async () => {
    const root = await createTempWorkspace()
    await initRepo(root)
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, ".env.local"), "API_TOKEN=old-secret-value\n", "utf8")
    await writeFile(join(root, "src", "visible.txt"), "public_value=before\n", "utf8")
    await git(root, ["add", ".env.local", "src/visible.txt"])
    await git(root, ["commit", "-m", "init"])
    await writeFile(join(root, ".env.local"), "API_TOKEN=new-secret-value\n", "utf8")
    await writeFile(join(root, "src", "visible.txt"), "public_value=after\n", "utf8")
    const runtime = await createRuntime(root, "read-only")

    const results = await runtime.runBatch([call("c1", "git_feedback", { reason: "inspect sensitive diff" })], ctx())

    const content = results[0]?.content ?? ""
    expect(results[0]).toMatchObject({ toolName: "git_feedback", isError: false })
    expect(content).toContain(".env.local")
    expect(content).toContain("[redacted: sensitive path patch omitted]")
    expect(content).not.toContain("old-secret-value")
    expect(content).not.toContain("new-secret-value")
    expect(content).toContain("src/visible.txt")
    expect(content).toContain("+public_value=after")
  })
})

type OpenAiToolSchema = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

async function createRuntime(
  root: string,
  permissionMode: PermissionMode,
  options: { registry?: ToolRegistry; hooks?: SessionHooks } = {},
): Promise<RealToolRuntime> {
  const workspace = await WorkspaceFs.create(root)
  return new RealToolRuntime({
    registry: options.registry ?? createBuiltinToolRegistry(),
    workspace,
    permissionMode,
    hooks: options.hooks,
  })
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepId: "step1",
    signal: new AbortController().signal,
    ...extra,
  }
}

function approvalCounter(onRequest: () => void): ApprovalRequester {
  return {
    async request() {
      onRequest()
      return "deny"
    },
  }
}

function permissionDecisions(events: { type: string }[]): { type: string }[] {
  return events.filter((event) => event.type === "permission.decision")
}

function emptyObjectTool(name: string, readOnly: boolean): ToolDefinition<Record<string, never>> {
  return {
    name,
    description: `${name} test tool`,
    readOnly,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    parse() {
      return {}
    },
    async execute() {
      return { content: `${name} done` }
    },
  }
}

async function initRepo(root: string): Promise<void> {
  await git(root, ["init"])
  await git(root, ["config", "user.name", "Light CC Test"])
  await git(root, ["config", "user.email", "light-cc-test@example.invalid"])
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root })
}

async function waitFor<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
