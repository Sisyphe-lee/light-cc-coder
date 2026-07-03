import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "../../../src/core/events"
import { SLASH_COMMANDS } from "../../../src/extensions/commands"
import { applyKey, cursorColumn, cursorLine, initialInputState } from "../../../src/cli/tui/inputEditor"
import { decodeKeys } from "../../../src/cli/tui/keys"
import { computeLayout } from "../../../src/cli/tui/layout"
import { renderMarkdown } from "../../../src/cli/tui/markdown"
import { frameToAnsi, renderFrame, totalTranscriptLines } from "../../../src/cli/tui/render"
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

  test("decodes SGR mouse wheel events and ignores clicks", () => {
    expect(decodeKeys("\x1b[<64;10;5M")).toEqual([{ type: "wheelUp" }])
    expect(decodeKeys("\x1b[<65;10;5M")).toEqual([{ type: "wheelDown" }])
    expect(decodeKeys("\x1b[<80;1;1M")).toEqual([{ type: "wheelUp" }]) // ctrl+wheel-up: modifier bits masked
    expect(decodeKeys("\x1b[<0;3;4M")).toEqual([{ type: "mouse" }]) // left click -> no-op
  })

  test("decodes a multi-key chunk in order", () => {
    expect(decodeKeys("hi\r")).toEqual([
      { type: "char", value: "h" },
      { type: "char", value: "i" },
      { type: "enter" },
    ])
  })

  test("decodes bracketed paste as one key with normalized newlines", () => {
    expect(decodeKeys("\x1b[200~a\r\nb\rc\x1b[201~")).toEqual([{ type: "paste", value: "a\nb\nc" }])
    // Control characters other than \n and \t are stripped from the payload.
    expect(decodeKeys("\x1b[200~x\x1b[1myz\x1b[201~")).toEqual([{ type: "paste", value: "x[1myz" }])
    // Unterminated paste (chunk split fallback) takes the rest of the chunk.
    expect(decodeKeys("\x1b[200~tail")).toEqual([{ type: "paste", value: "tail" }])
  })

  test("decodes Alt+Enter and swallows unrecognized escape sequences", () => {
    expect(decodeKeys("\x1b\r")).toEqual([{ type: "altEnter" }])
    expect(decodeKeys("\x1b[1;5C")).toEqual([{ type: "unknown" }]) // Ctrl-Right
    expect(decodeKeys("\x1bx")).toEqual([{ type: "unknown" }]) // Alt+x
    expect(decodeKeys("\x1b")).toEqual([{ type: "escape" }]) // lone trailing ESC
    expect(decodeKeys("\x1b[1;5Cq")).toEqual([{ type: "unknown" }, { type: "char", value: "q" }])
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

  test("paste and Alt+Enter insert newlines; trailing backslash continues the line", () => {
    let state = initialInputState()
    state = update(state, { type: "paste", value: "line1\nline2" })
    expect(state.buffer).toBe("line1\nline2")
    expect(cursorLine(state)).toBe(1)
    state = update(state, { type: "altEnter" })
    expect(state.buffer).toBe("line1\nline2\n")
    // Enter on a buffer ending in backslash swaps it for a newline instead of submitting.
    let cont = initialInputState()
    for (const ch of ["h", "i", "\\"]) cont = update(cont, { type: "char", value: ch })
    const result = applyKey(cont, { type: "enter" })
    expect(result.kind).toBe("update")
    if (result.kind === "update") expect(result.state.buffer).toBe("hi\n")
    // Enter on a multi-line buffer submits the whole thing.
    const multi = applyKey(state, { type: "enter" })
    expect(multi.kind).toBe("submit")
    if (multi.kind === "submit") expect(multi.value).toBe("line1\nline2\n")
  })

  test("up/down move across lines before falling back to history", () => {
    let state = initialInputState(["old command"])
    state = update(state, { type: "paste", value: "ab\ncd" })
    expect(cursorLine(state)).toBe(1)
    state = update(state, { type: "up" }) // line 1 -> line 0, same column
    expect(cursorLine(state)).toBe(0)
    expect(state.buffer).toBe("ab\ncd") // still editing, not history
    state = update(state, { type: "up" }) // first line -> history recall
    expect(state.buffer).toBe("old command")
    state = update(state, { type: "down" }) // back to the draft
    expect(state.buffer).toBe("ab\ncd")
    state = update(state, { type: "down" }) // last line: no-op (already at draft)
    expect(state.buffer).toBe("ab\ncd")
  })

  test("home/end and ctrl-a/ctrl-e are line-scoped in multi-line buffers", () => {
    let state = initialInputState()
    state = update(state, { type: "paste", value: "ab\ncd" })
    state = update(state, { type: "home" })
    expect(state.cursor).toBe(3) // start of "cd", not start of buffer
    state = update(state, { type: "ctrl", value: "e" })
    expect(state.cursor).toBe(5)
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

  test("tool cards time themselves from event timestamps", () => {
    const t0 = "2026-07-03T00:00:00.000Z"
    const t1 = "2026-07-03T00:00:02.500Z"
    let vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    vm = reduceViewModel(vm, { seq: 1, timestamp: t0, sessionId: "s", type: "tool.call", turnId: "T", stepId: "S", call: { id: "c1", name: "bash", input: { command: "ls" } } } as unknown as SessionEvent)
    const running = vm.items[0]
    expect(running.kind === "tool" && running.startedAtMs).toBe(Date.parse(t0))
    vm = reduceViewModel(vm, { seq: 2, timestamp: t1, sessionId: "s", type: "tool.result", turnId: "T", stepId: "S", result: { id: "r1", role: "tool", toolCallId: "c1", toolName: "bash", content: "ok", isError: false } } as unknown as SessionEvent)
    const done = vm.items[0]
    expect(done.kind === "tool" && done.durationMs).toBe(2500)
  })

  test("turn.ended appends a summary line with duration, steps, and tokens", () => {
    const start = "2026-07-03T00:00:00.000Z"
    const end = "2026-07-03T00:00:14.000Z"
    let vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    vm = reduceViewModel(vm, { seq: 1, timestamp: start, sessionId: "s", type: "turn.started", turnId: "T" } as unknown as SessionEvent)
    vm = reduceViewModel(vm, { seq: 2, timestamp: start, sessionId: "s", type: "step.started", turnId: "T", stepId: "S1" } as unknown as SessionEvent)
    vm = reduceViewModel(vm, { seq: 3, timestamp: start, sessionId: "s", type: "assistant.message", turnId: "T", stepId: "S1", message: { id: "a", role: "assistant", content: "done", toolCalls: [], usage: { inputTokens: 12000, outputTokens: 1100 } } } as unknown as SessionEvent)
    vm = reduceViewModel(vm, { seq: 4, timestamp: end, sessionId: "s", type: "turn.ended", turnId: "T", reason: "completed" } as unknown as SessionEvent)
    const summary = vm.items.at(-1)
    expect(summary?.kind).toBe("summary")
    expect(summary?.kind === "summary" && summary.text).toBe("done · 14s · 1 step · ↑12.0k ↓1.1k")
    // An error turn does not add a summary (the error notice already covers it).
    let err = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    err = reduceViewModel(err, { seq: 1, timestamp: start, sessionId: "s", type: "turn.started", turnId: "T" } as unknown as SessionEvent)
    err = reduceViewModel(err, { seq: 2, timestamp: end, sessionId: "s", type: "turn.ended", turnId: "T", reason: "error" } as unknown as SessionEvent)
    expect(err.items.some((item) => item.kind === "summary")).toBe(false)
    // Hitting the step limit adds an actionable warning.
    let capped = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    capped = reduceViewModel(capped, { seq: 1, timestamp: start, sessionId: "s", type: "turn.started", turnId: "T" } as unknown as SessionEvent)
    capped = reduceViewModel(capped, { seq: 2, timestamp: end, sessionId: "s", type: "turn.ended", turnId: "T", reason: "max_steps" } as unknown as SessionEvent)
    const warning = capped.items.find((item) => item.kind === "notice")
    expect(warning?.kind === "notice" && warning.level).toBe("warn")
    expect(warning?.kind === "notice" && warning.text).toContain("--max-steps")
  })

  test("display text is sanitized: tabs expand and ANSI escapes are stripped", () => {
    let vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    // /tools-style tab-separated command output must not reach the renderer raw:
    // the terminal would jump to the next tab stop and leave stale cells behind.
    vm = reduceViewModel(vm, { seq: 1, timestamp: "t", sessionId: "s", type: "command.output", command: "tools", content: "read\tread-only" } as unknown as SessionEvent)
    const notice = vm.items[0]
    expect(notice.kind === "notice" && notice.text).toBe("read    read-only")
    // Colored bash output in a result preview loses its escape sequences.
    vm = reduceViewModel(vm, { seq: 2, timestamp: "t", sessionId: "s", type: "tool.call", turnId: "T", stepId: "S", call: { id: "c1", name: "bash", input: { command: "ls" } } } as unknown as SessionEvent)
    vm = reduceViewModel(vm, { seq: 3, timestamp: "t", sessionId: "s", type: "tool.result", turnId: "T", stepId: "S", result: { id: "r1", role: "tool", toolCallId: "c1", toolName: "bash", content: "\x1b[31mred\x1b[0m file", isError: false } } as unknown as SessionEvent)
    const tool = vm.items[1]
    expect(tool.kind === "tool" && tool.resultPreview).toBe("red file")
    // Assistant deltas are cleaned too.
    vm = reduceViewModel(vm, { seq: 4, timestamp: "t", sessionId: "s", type: "assistant.delta", turnId: "T", stepId: "S2", text: "a\tb\x1b[1m!" } as unknown as SessionEvent)
    const assistant = vm.items.at(-1)
    expect(assistant?.kind === "assistant" && assistant.text).toBe("a    b!")
  })

  test("pasted tabs become spaces so the input editor stays cell-exact", () => {
    expect(decodeKeys("\x1b[200~a\tb\x1b[201~")).toEqual([{ type: "paste", value: "a  b" }])
  })

  test("summarizeToolInput renders compact per-tool summaries", () => {
    expect(summarizeToolInput("bash", { command: "ls -la" })).toBe("ls -la")
    expect(summarizeToolInput("grep", { pattern: "foo", path: "src" })).toBe("foo  in src")
    expect(summarizeToolInput("edit", { path: "x.ts" })).toBe("x.ts")
  })
})

describe("markdown", () => {
  const plain = makeStyles(false)
  const text = (rows: ReturnType<typeof renderMarkdown>): string[] => rows.map((row) => row.map((seg) => seg.text).join(""))

  test("strips inline code and bold markers", () => {
    expect(text(renderMarkdown("run `bun test` and **read** output", 80, plain))).toEqual(["run bun test and read output"])
  })

  test("keeps fence lines and indents code block content", () => {
    const rows = text(renderMarkdown("```ts\nconst x = 1\n```", 80, plain))
    expect(rows).toEqual(["```ts", "  const x = 1", "```"])
  })

  test("bold markers inside code stay literal", () => {
    expect(text(renderMarkdown("`a ** b`", 80, plain))).toEqual(["a ** b"])
  })

  test("wraps list items with a hanging indent", () => {
    const rows = text(renderMarkdown(`- ${"x".repeat(10)}`, 8, plain))
    expect(rows[0]).toBe(`- ${"x".repeat(6)}`)
    expect(rows[1]).toBe(`  ${"x".repeat(4)}`)
  })

  test("applies color to inline code and headings when styles are enabled", () => {
    const styled = makeStyles(true)
    const code = renderMarkdown("see `x`", 80, styled)
    const joined = code.map((row) => row.map((seg) => (seg.style ? seg.style(seg.text) : seg.text)).join("")).join("\n")
    expect(joined).toContain("38;5;80m") // inlineCode color
    const heading = renderMarkdown("## Title", 80, styled)
    const headJoined = heading.map((row) => row.map((seg) => (seg.style ? seg.style(seg.text) : seg.text)).join("")).join("\n")
    expect(headJoined).toContain("38;5;39m") // header color
    expect(headJoined).toContain("Title")
    expect(headJoined).not.toContain("##") // hashes stripped
  })

  test("renders GFM tables as an aligned grid", () => {
    const md = "| 特性 | 状态 |\n|------|------|\n| 多 tab | 无 |\n| **粗体项** | `code` |"
    const rows = text(renderMarkdown(md, 60, plain))
    expect(rows).toHaveLength(4) // header, separator, two body rows
    expect(rows[0]).toContain("特性")
    expect(rows[0]).toContain("│")
    expect(rows[1]).toContain("┼")
    expect(rows[1]).toMatch(/^─+─┼──+$/)
    expect(rows[2]).toContain("多 tab")
    expect(rows[3]).toContain("粗体项") // inline markers stripped inside cells
    expect(rows[3]).toContain("code")
    // Columns align: both body rows put │ at the same display column (string
    // indexes differ because CJK cells use fewer, wider characters).
    expect(stringWidth(rows[2].slice(0, rows[2].indexOf("│")))).toBe(stringWidth(rows[3].slice(0, rows[3].indexOf("│"))))
    // Raw pipe/dash source never leaks through.
    expect(rows.join("\n")).not.toContain("|")
  })

  test("narrow tables shrink and cells truncate with an ellipsis", () => {
    const md = `| name | description |\n|---|---|\n| x | ${"y".repeat(60)} |`
    const rows = text(renderMarkdown(md, 30, plain))
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(30)
    expect(rows[2]).toContain("…")
  })

  test("renders links and horizontal rules", () => {
    expect(text(renderMarkdown("see [docs](https://ex.am/p)", 80, plain))).toEqual(["see docs (https://ex.am/p)"])
    const hr = text(renderMarkdown("---", 80, plain))
    expect(hr[0]).toMatch(/^─+$/)
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

  test("renders queued messages after the transcript", () => {
    const styles = makeStyles(false)
    let vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    vm = reduceViewModel(vm, { seq: 1, timestamp: "t", sessionId: "s", type: "user.message", turnId: "T", message: { id: "u", role: "user", content: "hi" } } as unknown as SessionEvent)
    const layout = computeLayout({ rows: 12, cols: 60, showSidebar: false, inputHeight: 1 })
    const frame = renderFrame({ vm, layout, editor: initialInputState(), scrollOffset: 0, styles, queued: ["next question please"] })
    expect(frame.output).toContain("⧗ next question please")
    expect(totalTranscriptLines(vm, 60, styles, undefined, ["a", "b"])).toBe(totalTranscriptLines(vm, 60, styles) + 2)
  })

  test("empty transcript shows the welcome banner with session facts", () => {
    const styles = makeStyles(false)
    const vm = initialViewModel({ model: "deepseek-v4-flash", permissionMode: "workspace-write", sessionId: "abc12345", cwd: "~/proj" })
    const layout = computeLayout({ rows: 20, cols: 80, showSidebar: false, inputHeight: 1 })
    const frame = renderFrame({ vm, layout, editor: initialInputState(), scrollOffset: 0, styles })
    expect(frame.output).toContain("lightcc")
    expect(frame.output).toContain("deepseek-v4-flash")
    expect(frame.output).toContain("~/proj")
    expect(frame.output).toContain("Type a task to get started.")
  })

  test("sidebar shows the context ratio and the auto-compact threshold", () => {
    const styles = makeStyles(false)
    let vm = initialViewModel({ model: "m", permissionMode: "workspace-write", maxContextTokens: 200000, compactAtTokens: 175000 })
    vm = reduceViewModel(vm, { seq: 1, timestamp: "t", sessionId: "s", type: "context.step", turnId: "T", stepId: "S", snapshot: { estimatedTokens: 84000 } } as unknown as SessionEvent)
    const layout = computeLayout({ rows: 24, cols: 100, showSidebar: true, inputHeight: 1 })
    const frame = renderFrame({ vm, layout, editor: initialInputState(), scrollOffset: 0, styles })
    expect(frame.output).toContain("84.0k of 200k")
    expect(frame.output).toContain("auto-compact @ 175k")
    expect(frame.output).toContain("(88%)")
    expect(frame.output).toContain("42%") // used ratio in the panel header
    expect(frame.output).toContain("▏") // threshold tick on the meter
  })

  test("renders the slash-command completion popup with the selection marked", () => {
    const styles = makeStyles(false)
    const vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    const layout = computeLayout({ rows: 16, cols: 70, showSidebar: false, inputHeight: 1 })
    const editor = { ...initialInputState(), buffer: "/re", cursor: 3 }
    const items = SLASH_COMMANDS.filter((c) => c.name.startsWith("re"))
    const frame = renderFrame({ vm, layout, editor, scrollOffset: 0, styles, suggestions: { items, index: 0 } })
    expect(frame.output).toContain("❯ /resume")
    expect(frame.output).toContain("Resume a stored session")
  })

  test("help overlay replaces the transcript viewport", () => {
    const styles = makeStyles(false)
    const vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    const layout = computeLayout({ rows: 24, cols: 80, showSidebar: false, inputHeight: 1 })
    const frame = renderFrame({ vm, layout, editor: initialInputState(), scrollOffset: 0, styles, helpVisible: true })
    expect(frame.output).toContain("Help")
    expect(frame.output).toContain("copy mode")
    expect(frame.output).toContain("abort the running turn")
  })

  test("frameToAnsi hides the cursor before painting and re-shows it only at its parked spot", () => {
    const payload = frameToAnsi({ output: "FRAME", cursor: { row: 5, col: 2 } }, true)
    // Hidden before any frame content, shown only after the final reposition,
    // all bracketed by synchronized-update markers.
    expect(payload).toBe("\x1b[?2026h\x1b[?25lFRAME\x1b[6;3H\x1b[?25h\x1b[?2026l")
    const noCursor = frameToAnsi({ output: "FRAME", cursor: { row: 5, col: 2 } }, false)
    expect(noCursor).toBe("\x1b[?2026h\x1b[?25lFRAME\x1b[?2026l")
    expect(noCursor).not.toContain("\x1b[?25h")
  })

  test("multi-line input renders one row per line and parks the cursor on its line", () => {
    const styles = makeStyles(false)
    const vm = initialViewModel({ model: "m", permissionMode: "workspace-write" })
    const layout = computeLayout({ rows: 14, cols: 60, showSidebar: false, inputHeight: 2 })
    const editor = { ...initialInputState(), buffer: "first\nsecond", cursor: Array.from("first\nsecond").length }
    const frame = renderFrame({ vm, layout, editor, scrollOffset: 0, styles })
    expect(frame.output).toContain("❯ first")
    expect(frame.output).toContain("│ second")
    expect(frame.cursor).toBeDefined()
    expect(frame.cursor!.row).toBe(layout.input.y + 1)
    expect(frame.cursor!.col).toBe(2 + "second".length)
  })
})

function update(state: ReturnType<typeof initialInputState>, key: Parameters<typeof applyKey>[1]) {
  const result = applyKey(state, key)
  if (result.kind === "update" || result.kind === "submit") return result.state
  return state
}
