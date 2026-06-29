import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "../../../src/core/events"
import { applyKey, cursorColumn, initialInputState } from "../../../src/cli/tui/inputEditor"
import { decodeKeys } from "../../../src/cli/tui/keys"
import { computeLayout } from "../../../src/cli/tui/layout"
import { renderFrame, totalTranscriptLines } from "../../../src/cli/tui/render"
import { makeStyles } from "../../../src/cli/tui/style"
import { initialViewModel, reduceViewModel, summarizeToolInput, type TuiViewModel } from "../../../src/cli/tui/viewModel"
import { padToWidth, stringWidth, truncateToWidth, wrapText } from "../../../src/cli/tui/width"

describe("width", () => {
  test("CJK characters are two columns wide", () => {
    expect(stringWidth("ab")).toBe(2)
    expect(stringWidth("你好")).toBe(4)
    expect(stringWidth("a你b")).toBe(4)
  })

  test("truncateToWidth respects display width and appends ellipsis", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello")
    expect(truncateToWidth("hello world", 5)).toBe("hell…")
    expect(stringWidth(truncateToWidth("你好世界", 5))).toBeLessThanOrEqual(5)
  })

  test("padToWidth fills to exact display width", () => {
    expect(stringWidth(padToWidth("hi", 6))).toBe(6)
    expect(stringWidth(padToWidth("你好", 6))).toBe(6)
    expect(padToWidth("hi", 4)).toBe("hi  ")
  })

  test("wrapText hard-wraps to width and keeps newlines", () => {
    expect(wrapText("abcdef", 3)).toEqual(["abc", "def"])
    expect(wrapText("a\nb", 5)).toEqual(["a", "b"])
    for (const row of wrapText("你好世界你好", 5)) expect(stringWidth(row)).toBeLessThanOrEqual(5)
  })
})

describe("keys", () => {
  test("decodes printable, control, and escape sequences", () => {
    expect(decodeKeys("a")).toEqual([{ type: "char", value: "a" }])
    expect(decodeKeys("你")).toEqual([{ type: "char", value: "你" }])
    expect(decodeKeys("\r")).toEqual([{ type: "enter" }])
    expect(decodeKeys("\x7f")).toEqual([{ type: "backspace" }])
    expect(decodeKeys("\x03")).toEqual([{ type: "ctrl", value: "c" }])
    expect(decodeKeys("\x1b[A")).toEqual([{ type: "up" }])
    expect(decodeKeys("\x1b[5~")).toEqual([{ type: "pageUp" }])
  })

  test("decodes a multi-key chunk in order", () => {
    expect(decodeKeys("hi\r")).toEqual([
      { type: "char", value: "h" },
      { type: "char", value: "i" },
      { type: "enter" },
    ])
  })
})

describe("layout", () => {
  test("regions partition the screen with a sidebar on wide terminals", () => {
    const layout = computeLayout({ rows: 24, cols: 80, showSidebar: true, inputHeight: 1 })
    expect(layout.transcript.height).toBe(22)
    expect(layout.status.y).toBe(22)
    expect(layout.input.y).toBe(23)
    expect(layout.status.width).toBe(80)
    expect(layout.sidebar).toBeDefined()
    expect(layout.sidebar!.x).toBe(layout.transcript.width)
    expect(layout.transcript.width + layout.sidebar!.width).toBe(80)
  })

  test("hides the sidebar on narrow terminals", () => {
    const layout = computeLayout({ rows: 24, cols: 40, showSidebar: true })
    expect(layout.sidebar).toBeUndefined()
    expect(layout.transcript.width).toBe(40)
  })
})

describe("inputEditor", () => {
  test("inserts characters and tracks the cursor", () => {
    let state = initialInputState()
    for (const ch of ["h", "i"]) {
      const result = applyKey(state, { type: "char", value: ch })
      expect(result.kind).toBe("update")
      if (result.kind === "update") state = result.state
    }
    expect(state.buffer).toBe("hi")
    expect(state.cursor).toBe(2)
    expect(cursorColumn(state)).toBe(2)
  })

  test("backspace and left+insert edit at the cursor", () => {
    let state = initialInputState()
    state = update(state, { type: "char", value: "h" })
    state = update(state, { type: "char", value: "i" })
    state = update(state, { type: "backspace" })
    expect(state.buffer).toBe("h")
    state = update(state, { type: "left" })
    state = update(state, { type: "char", value: "X" })
    expect(state.buffer).toBe("Xh")
    expect(state.cursor).toBe(1)
  })

  test("enter submits, clears the buffer, and records history", () => {
    let state = initialInputState()
    state = update(state, { type: "char", value: "h" })
    state = update(state, { type: "char", value: "i" })
    const result = applyKey(state, { type: "enter" })
    expect(result.kind).toBe("submit")
    if (result.kind === "submit") {
      expect(result.value).toBe("hi")
      expect(result.state.buffer).toBe("")
      expect(result.state.history).toEqual(["hi"])
      // Up arrow recalls the submitted line.
      const recalled = applyKey(result.state, { type: "up" })
      expect(recalled.kind).toBe("update")
      if (recalled.kind === "update") expect(recalled.state.buffer).toBe("hi")
    }
  })

  test("ctrl-u clears text before the cursor; ctrl-c interrupts", () => {
    let state = initialInputState()
    for (const ch of ["a", "b", "c"]) state = update(state, { type: "char", value: ch })
    const cleared = applyKey(state, { type: "ctrl", value: "u" })
    expect(cleared.kind).toBe("update")
    if (cleared.kind === "update") expect(cleared.state.buffer).toBe("")
    expect(applyKey(state, { type: "ctrl", value: "c" }).kind).toBe("interrupt")
    expect(applyKey(initialInputState(), { type: "ctrl", value: "d" }).kind).toBe("eof")
  })
})

describe("viewModel", () => {
  test("folds an event stream into transcript items and status", () => {
    let seq = 0
    const ev = (partial: Record<string, unknown>): SessionEvent =>
      ({ seq: (seq += 1), timestamp: "t", sessionId: "s", ...partial }) as unknown as SessionEvent

    let vm = initialViewModel({ model: "deepseek-v4-flash", permissionMode: "workspace-write", maxContextTokens: 200000 })
    vm = reduceViewModel(vm, ev({ type: "user.message", turnId: "T1", message: { id: "u1", role: "user", content: "fix it" } }))
    vm = reduceViewModel(vm, ev({ type: "turn.started", turnId: "T1" }))
    vm = reduceViewModel(vm, ev({ type: "step.started", turnId: "T1", stepId: "S1" }))
    vm = reduceViewModel(vm, ev({ type: "assistant.delta", turnId: "T1", stepId: "S1", text: "Look" }))
    vm = reduceViewModel(vm, ev({ type: "assistant.delta", turnId: "T1", stepId: "S1", text: "ing" }))
    vm = reduceViewModel(vm, ev({ type: "tool.call", turnId: "T1", stepId: "S1", call: { id: "c1", name: "read", input: { path: "a.ts", line: 5 } } }))
    expect(vm.turnState).toBe("running")
    expect(vm.activeLabel).toBe("read")
    vm = reduceViewModel(vm, ev({ type: "tool.result", turnId: "T1", stepId: "S1", result: { id: "r1", role: "tool", toolCallId: "c1", toolName: "read", content: "line one\nline two", isError: false } }))
    vm = reduceViewModel(vm, ev({ type: "assistant.message", turnId: "T1", stepId: "S2", message: { id: "a2", role: "assistant", content: "done", toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, promptCacheHitTokens: 80, promptCacheMissTokens: 20 } } }))
    vm = reduceViewModel(vm, ev({ type: "context.step", turnId: "T1", stepId: "S2", snapshot: { estimatedTokens: 12345 } }))
    vm = reduceViewModel(vm, ev({ type: "todo.updated", turnId: "T1", stepId: "S2", items: [{ id: "1", content: "step one", status: "in_progress" }] }))
    vm = reduceViewModel(vm, ev({ type: "turn.ended", turnId: "T1", reason: "completed" }))

    const kinds = vm.items.map((i) => i.kind)
    expect(kinds).toEqual(["user", "assistant", "tool", "assistant"])
    const streamed = vm.items[1]
    expect(streamed.kind === "assistant" && streamed.text).toBe("Looking")
    const tool = vm.items[2]
    expect(tool.kind === "tool" && tool.status).toBe("ok")
    expect(tool.kind === "tool" && tool.inputSummary).toBe("a.ts:5")
    expect(vm.usage.inputTokens).toBe(100)
    expect(vm.usage.cacheHitTokens).toBe(80)
    expect(vm.contextTokens).toBe(12345)
    expect(vm.todos).toHaveLength(1)
    expect(vm.turnState).toBe("idle")
  })

  test("approval requested then responded toggles pendingApproval", () => {
    let vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    vm = reduceViewModel(vm, { seq: 1, timestamp: "t", sessionId: "s", type: "approval.requested", turnId: "T", stepId: "S", approvalId: "ap1", toolCallId: "c1", toolName: "bash", subject: "rm -rf", reason: "writes" } as unknown as SessionEvent)
    expect(vm.turnState).toBe("awaiting-approval")
    expect(vm.pendingApproval?.approvalId).toBe("ap1")
    vm = reduceViewModel(vm, { seq: 2, timestamp: "t", sessionId: "s", type: "approval.responded", approvalId: "ap1", decision: "allow" } as unknown as SessionEvent)
    expect(vm.pendingApproval).toBeUndefined()
  })

  test("summarizeToolInput renders compact per-tool summaries", () => {
    expect(summarizeToolInput("bash", { command: "ls -la" })).toBe("ls -la")
    expect(summarizeToolInput("grep", { pattern: "foo", path: "src" })).toBe("foo  in src")
    expect(summarizeToolInput("edit", { path: "x.ts" })).toBe("x.ts")
  })
})

describe("render", () => {
  test("produces a full frame with status bar and input cursor", () => {
    const styles = makeStyles(false)
    let vm: TuiViewModel = initialViewModel({ model: "deepseek-v4-flash", permissionMode: "workspace-write", maxContextTokens: 200000 })
    vm = reduceViewModel(vm, { seq: 1, timestamp: "t", sessionId: "s", type: "user.message", turnId: "T", message: { id: "u", role: "user", content: "hello world" } } as unknown as SessionEvent)
    const layout = computeLayout({ rows: 12, cols: 60, showSidebar: true, inputHeight: 1 })
    const editor = initialInputState()
    const frame = renderFrame({ vm, layout, editor, scrollOffset: 0, styles })
    expect(frame.output).toContain("hello world")
    expect(frame.output).toContain("deepseek-v4-flash")
    expect(frame.cursor).toBeDefined()
    expect(frame.cursor!.row).toBe(layout.input.y)
    expect(totalTranscriptLines(vm, layout.transcript.width, styles)).toBeGreaterThan(0)
  })

  test("animates a spinner and colors the status bar while a tool runs", () => {
    let vm: TuiViewModel = initialViewModel({ model: "deepseek-v4-flash", permissionMode: "workspace-write", maxContextTokens: 200000 })
    const ev = (p: Record<string, unknown>): SessionEvent => ({ seq: 1, timestamp: "t", sessionId: "s", ...p }) as unknown as SessionEvent
    vm = reduceViewModel(vm, ev({ type: "tool.call", turnId: "T", stepId: "S", call: { id: "c1", name: "glob", input: { pattern: "src/**/*.ts" } } }))
    const layout = computeLayout({ rows: 24, cols: 100, showSidebar: true, inputHeight: 1 })
    const colored = renderFrame({ vm, layout, editor: initialInputState(), scrollOffset: 0, styles: makeStyles(true), activity: { spinner: "⠹", turnElapsedMs: 2300, toolElapsedMs: 800 } })
    expect(colored.output).toContain("⠹") // animated spinner on the running tool card
    expect(colored.output).toContain("48;5;24") // status-bar background color
    expect(colored.output).toContain("0.8s") // active tool elapsed
    // Color disabled keeps the frame plain for snapshot-friendly assertions.
    const plain = renderFrame({ vm, layout, editor: initialInputState(), scrollOffset: 0, styles: makeStyles(false), activity: { spinner: "⠹" } })
    expect(plain.output).not.toContain("\x1b[48;5;24")
  })
})

function update(state: ReturnType<typeof initialInputState>, key: Parameters<typeof applyKey>[1]) {
  const result = applyKey(state, key)
  if (result.kind === "update" || result.kind === "submit") return result.state
  return state
}
