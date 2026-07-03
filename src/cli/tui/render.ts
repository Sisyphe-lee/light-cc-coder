import type { SlashCommandInfo } from "../../extensions/commands"
import { cursorColumn, cursorLine, type InputState } from "./inputEditor"
import type { Rect, TuiLayout } from "./layout"
import { renderMarkdown, type Segment } from "./markdown"
import type { Style, Styles } from "./style"
import type { PendingApproval, TranscriptItem, TuiViewModel } from "./viewModel"
import { charWidth, padToWidth, stringWidth, truncateToWidth, wrapText } from "./width"

// Pure frame composer: (view model + layout + input + activity) -> a single
// string of ANSI positioning + styled cells that repaints the whole screen, plus
// where to park the cursor. Every emitted line is padded to its region width so a
// repaint overwrites stale cells without a full clear (less flicker than CSI 2J).

const CSI = "\x1b["
const STATUS_BG = 24 // dark teal status-bar background (256-color)

// Live activity passed from the orchestrator each paint so spinners animate and
// elapsed time ticks without the pure reducer needing a clock. nowMs lets each
// running tool card compute its own elapsed from its startedAtMs.
export type Activity = { spinner: string; turnElapsedMs?: number; toolElapsedMs?: number; nowMs?: number }

export type Frame = { output: string; cursor?: { row: number; col: number } }

// Wrap a frame for writing to the terminal. The cursor is hidden BEFORE any
// repositioning writes and only re-shown at its final parked position, so it
// never flickers across the screen mid-repaint. The whole payload is bracketed
// in synchronized-update mode (DECSET 2026) so supporting terminals apply the
// frame atomically; others ignore the markers.
export function frameToAnsi(frame: Frame, showCursor: boolean): string {
  let out = `${CSI}?2026h${CSI}?25l${frame.output}`
  if (showCursor && frame.cursor) {
    out += `${CSI}${frame.cursor.row + 1};${frame.cursor.col + 1}H${CSI}?25h`
  }
  return `${out}${CSI}?2026l`
}

export type Suggestions = { items: readonly SlashCommandInfo[]; index: number }

export type RenderInput = {
  vm: TuiViewModel
  layout: TuiLayout
  editor: InputState
  scrollOffset: number
  styles: Styles
  activity?: Activity
  copyMode?: boolean
  queued?: readonly string[]
  suggestions?: Suggestions
  helpVisible?: boolean
}

export function renderFrame(input: RenderInput): Frame {
  const { vm, layout, editor, scrollOffset, styles, activity, copyMode, queued, suggestions, helpVisible } = input
  let out = ""

  const panel = vm.pendingApproval ? renderApprovalPanel(vm.pendingApproval, layout.transcript.width, styles) : []
  const transcriptHeight = Math.max(1, layout.transcript.height - panel.length)
  const allLines = helpVisible
    ? renderHelpOverlay(layout.transcript.width, transcriptHeight, styles)
    : viewportSlice(renderTranscript(vm, layout.transcript.width, styles, activity, queued), transcriptHeight, scrollOffset, layout.transcript.width)
  allLines.forEach((line, i) => {
    out += at(layout.transcript.y + i, layout.transcript.x) + line
  })
  panel.forEach((line, i) => {
    out += at(layout.transcript.y + transcriptHeight + i, layout.transcript.x) + line
  })

  // Slash-command completion popup, anchored to the bottom of the transcript
  // region (directly above the status bar) so it reads as attached to the input.
  if (!helpVisible && suggestions && suggestions.items.length > 0) {
    const popup = renderSuggestions(suggestions, layout.transcript.width, transcriptHeight, styles)
    popup.forEach((line, i) => {
      out += at(layout.transcript.y + transcriptHeight - popup.length + i, layout.transcript.x) + line
    })
  }

  if (layout.sidebar) {
    const lines = renderSidebar(vm, layout.sidebar, styles)
    for (let i = 0; i < layout.sidebar.height; i++) {
      out += at(layout.sidebar.y + i, layout.sidebar.x) + (lines[i] ?? composeLine([], layout.sidebar.width))
    }
  }

  out += at(layout.status.y, layout.status.x) + renderStatusBar(vm, layout.status.width, styles, activity)

  const inputRender = renderInput(vm, editor, layout.input, styles, copyMode)
  inputRender.lines.forEach((line, i) => {
    out += at(layout.input.y + i, layout.input.x) + line
  })

  return { output: out, cursor: inputRender.cursor }
}

// 0-indexed row/col in, 1-indexed CSI cursor position out.
function at(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`
}

function viewportSlice(lines: string[], height: number, scrollOffset: number, width: number): string[] {
  const maxStart = Math.max(0, lines.length - height)
  const start = Math.max(0, maxStart - Math.max(0, scrollOffset))
  const slice = lines.slice(start, start + height)
  while (slice.length < height) slice.push(composeLine([], width))
  return slice
}

export function totalTranscriptLines(vm: TuiViewModel, width: number, styles: Styles, activity?: Activity, queued?: readonly string[]): number {
  return renderTranscript(vm, width, styles, activity, queued).length
}

function renderTranscript(vm: TuiViewModel, width: number, styles: Styles, activity?: Activity, queued?: readonly string[]): string[] {
  const lines: string[] = []
  if (vm.items.length === 0 && !queued?.length) return renderWelcome(vm, width, styles)
  for (const item of vm.items) {
    if (item.kind === "user") {
      if (lines.length > 0) lines.push(composeLine([], width))
      wrapText(item.text, Math.max(1, width - 2)).forEach((row, idx) => {
        lines.push(composeLine([{ text: idx === 0 ? "❯ " : "  ", style: styles.cyanBold }, { text: row, style: styles.bold }], width))
      })
    } else if (item.kind === "assistant") {
      if (lines.length > 0) lines.push(composeLine([], width))
      renderMarkdown(item.text, Math.max(1, width - 2), styles).forEach((row, idx) => {
        lines.push(composeLine([{ text: idx === 0 ? "● " : "  ", style: styles.gray }, ...row], width))
      })
    } else if (item.kind === "tool") {
      lines.push(renderToolHeader(item, width, styles, activity))
      if (item.resultPreview) {
        for (const row of wrapText(item.resultPreview, Math.max(1, width - 5)).slice(0, 2)) {
          lines.push(composeLine([{ text: "  ⎿ ", style: styles.gray }, { text: row, style: styles.dim }], width))
        }
      }
    } else if (item.kind === "summary") {
      wrapText(item.text, Math.max(1, width - 2)).forEach((row, idx) => {
        lines.push(composeLine([{ text: idx === 0 ? "╰ " : "  ", style: styles.dim }, { text: row, style: styles.dim }], width))
      })
    } else {
      const style = item.level === "error" ? styles.red : item.level === "warn" ? styles.yellow : styles.gray
      const icon = item.level === "error" ? "✗ " : item.level === "warn" ? "! " : "· "
      wrapText(item.text, Math.max(1, width - 2)).forEach((row, idx) => {
        lines.push(composeLine([{ text: idx === 0 ? icon : "  ", style }, { text: row, style }], width))
      })
    }
  }
  // Ephemeral "thinking" row so an in-flight turn with no active tool still shows
  // motion. A running tool already animates its own card, so skip it then.
  if (vm.turnState === "thinking" && activity) {
    const label = `thinking…${activity.turnElapsedMs != null ? `  ${formatElapsed(activity.turnElapsedMs)}` : ""}`
    lines.push(composeLine([{ text: `${activity.spinner} `, style: styles.yellow }, { text: label, style: styles.dim }], width))
  }
  // Messages typed while a turn was in flight wait here; each becomes a real
  // user item when it is dequeued and submitted.
  for (const pending of queued ?? []) {
    const collapsed = pending.replace(/\s+/g, " ").trim()
    lines.push(composeLine([{ text: "⧗ ", style: styles.gray }, { text: collapsed, style: styles.dim }], width))
  }
  return lines
}

function renderToolHeader(
  item: Extract<TranscriptItem, { kind: "tool" }>,
  width: number,
  styles: Styles,
  activity?: Activity,
): string {
  const running = item.status === "running"
  const icon = item.status === "ok" ? "✓" : item.status === "error" ? "✗" : activity?.spinner ?? "•"
  const iconStyle = item.status === "ok" ? styles.green : item.status === "error" ? styles.red : styles.yellow
  // Each card times itself from its own start event; finished cards keep their
  // final duration as a quiet suffix.
  let elapsed = ""
  let elapsedStyle = styles.yellow
  if (running) {
    const ms = item.startedAtMs != null && activity?.nowMs != null ? Math.max(0, activity.nowMs - item.startedAtMs) : activity?.toolElapsedMs
    if (ms != null) elapsed = `  ${formatElapsed(ms)}`
  } else if (item.durationMs != null && item.durationMs >= 100) {
    elapsed = `  ${formatElapsed(item.durationMs)}`
    elapsedStyle = styles.dim
  }
  return composeLine(
    [
      { text: icon, style: iconStyle },
      { text: " " },
      { text: item.name, style: styles.cyanBold },
      { text: item.inputSummary ? "  " : "" },
      { text: item.inputSummary, style: styles.dim },
      { text: elapsed, style: elapsedStyle },
    ],
    width,
  )
}

// First-open banner shown while the transcript is empty: identity, session
// facts, and how to discover the rest of the UI.
function renderWelcome(vm: TuiViewModel, width: number, styles: Styles): string[] {
  const inner = Math.max(20, Math.min(width - 4, 56))
  const lines: string[] = []
  const box = (segs: Segment[]): string => {
    let used = 0
    for (const seg of segs) used += stringWidth(seg.text)
    const pad = Math.max(0, inner - used)
    return composeLine([{ text: "│ ", style: styles.gray }, ...segs, { text: " ".repeat(pad) }, { text: " │", style: styles.gray }], width)
  }
  const field = (label: string, value?: string): Segment[] => [
    { text: `${label.padEnd(6)} `, style: styles.dim },
    { text: truncateToWidth(value ?? "", Math.max(1, inner - 7)), style: styles.cyan },
  ]
  lines.push(composeLine([], width))
  lines.push(composeLine([{ text: `╭${"─".repeat(inner + 2)}╮`, style: styles.gray }], width))
  lines.push(box([{ text: "lightcc", style: styles.header }, { text: "  — lightweight coding agent", style: styles.dim }]))
  lines.push(box([]))
  lines.push(box(field("model", vm.model)))
  if (vm.cwd) lines.push(box(field("cwd", vm.cwd)))
  lines.push(box(field("mode", String(vm.permissionMode))))
  if (vm.sessionId) lines.push(box(field("id", vm.sessionId)))
  lines.push(composeLine([{ text: `╰${"─".repeat(inner + 2)}╯`, style: styles.gray }], width))
  lines.push(composeLine([], width))
  lines.push(
    composeLine(
      [
        { text: "  Type a task to get started.  ", style: styles.dim },
        { text: "?", style: styles.cyanBold },
        { text: " help · ", style: styles.dim },
        { text: "/", style: styles.cyanBold },
        { text: " commands · ", style: styles.dim },
        { text: "\\+Enter", style: styles.cyanBold },
        { text: " newline", style: styles.dim },
      ],
      width,
    ),
  )
  return lines
}

function renderApprovalPanel(approval: PendingApproval, width: number, styles: Styles): string[] {
  const lines: string[] = []
  lines.push(composeLine([{ text: "┌ ", style: styles.yellow }, { text: `Approve ${approval.toolName}`, style: styles.cyanBold }], width))
  const detail = (label: string, value?: string) => {
    if (!value) return
    const rows = wrapText(value, Math.max(1, width - 2 - (label ? label.length + 2 : 0)))
    rows.forEach((row, idx) => {
      const head = idx === 0 && label ? `${label}: ` : ""
      lines.push(composeLine([{ text: "│ ", style: styles.yellow }, { text: head, style: styles.dim }, { text: row }], width))
    })
  }
  detail("", approval.subject)
  detail("access", approval.accessSummary)
  detail("risk", approval.riskSummary)
  lines.push(
    composeLine(
      [
        { text: "│ ", style: styles.yellow },
        { text: "a", style: styles.green },
        { text: " allow   ", style: styles.dim },
        { text: "d", style: styles.red },
        { text: " deny   ", style: styles.dim },
        { text: "Esc", style: styles.gray },
        { text: " abort", style: styles.dim },
      ],
      width,
    ),
  )
  return lines.slice(0, 6)
}

function renderSuggestions(suggestions: Suggestions, width: number, maxHeight: number, styles: Styles): string[] {
  const cap = Math.max(1, Math.min(6, maxHeight))
  // Keep the selection visible when the list is longer than the popup.
  const start = Math.min(Math.max(0, suggestions.index - cap + 1), Math.max(0, suggestions.items.length - cap))
  const visible = suggestions.items.slice(start, start + cap)
  const usageWidth = Math.min(28, Math.max(0, ...visible.map((item) => stringWidth(item.usage))))
  return visible.map((item, i) => {
    const selected = start + i === suggestions.index
    return composeLine(
      [
        { text: selected ? "❯ " : "  ", style: styles.cyanBold },
        { text: padToWidth(item.usage, usageWidth), style: selected ? styles.cyanBold : styles.cyan },
        { text: "  " },
        { text: item.description, style: selected ? undefined : styles.dim },
      ],
      width,
    )
  })
}

const HELP_ROWS: Array<[string, string]> = [
  ["Enter", "send message"],
  ["\\ + Enter / Alt+Enter", "insert a newline"],
  ["Esc", "abort the running turn · clear input · close help"],
  ["Ctrl-C", "abort the running turn; press twice to quit"],
  ["Ctrl-D", "quit (on empty input)"],
  ["Up / Down", "move across input lines, then recall history"],
  ["Wheel / PgUp / PgDn", "scroll the transcript"],
  ["Tab", "complete a slash command"],
  ["Ctrl-G", "copy mode (native terminal selection)"],
  ["Ctrl-L", "repaint the screen"],
  ["Ctrl-A / Ctrl-E", "jump to line start / end"],
  ["Ctrl-U / Ctrl-K / Ctrl-W", "delete to line start / line end / word"],
]

function renderHelpOverlay(width: number, height: number, styles: Styles): string[] {
  const lines: string[] = []
  const keyWidth = Math.min(26, Math.max(...HELP_ROWS.map(([key]) => stringWidth(key))))
  lines.push(composeLine([{ text: " Help", style: styles.header }], width))
  lines.push(composeLine([], width))
  for (const [key, description] of HELP_ROWS) {
    lines.push(composeLine([{ text: "  " }, { text: padToWidth(key, keyWidth), style: styles.cyan }, { text: "  " }, { text: description, style: styles.dim }], width))
  }
  lines.push(composeLine([], width))
  lines.push(composeLine([{ text: "  Type ", style: styles.dim }, { text: "/", style: styles.cyanBold }, { text: " to browse slash commands. ", style: styles.dim }, { text: "?", style: styles.cyanBold }, { text: " or ", style: styles.dim }, { text: "Esc", style: styles.cyanBold }, { text: " closes this help.", style: styles.dim }], width))
  while (lines.length < height) lines.push(composeLine([], width))
  return lines.slice(0, height)
}

function renderSidebar(vm: TuiViewModel, rect: Rect, styles: Styles): string[] {
  const inner = Math.max(1, rect.width - 2)
  const rule = (segs: Segment[]): string => composeLine([{ text: "│ ", style: styles.gray }, ...segs], rect.width)
  const field = (label: string, value: string, valueStyle: Style | undefined = styles.cyan): string =>
    rule([{ text: `${label.padEnd(7)}`, style: styles.dim }, { text: truncateToWidth(value, Math.max(1, inner - 7)), style: valueStyle }])
  const divider = (): string => rule([{ text: "─".repeat(Math.max(1, inner - 1)), style: styles.gray }])
  const lines: string[] = []

  lines.push(rule([{ text: "Session", style: styles.header }]))
  lines.push(field("model", vm.model))
  lines.push(field("mode", String(vm.permissionMode)))
  if (vm.sessionId) lines.push(field("id", vm.sessionId.slice(0, 12), styles.gray))

  lines.push(divider())
  lines.push(...renderContextPanel(vm, inner, rule, styles))

  lines.push(divider())
  lines.push(rule([{ text: "Usage", style: styles.header }]))
  lines.push(field("input", formatTokens(vm.usage.inputTokens)))
  lines.push(field("output", formatTokens(vm.usage.outputTokens)))
  const cache = cacheHitRate(vm)
  if (cache != null) lines.push(field("cache", `${cache}%`, cache >= 80 ? styles.green : styles.cyan))
  lines.push(field("steps", String(vm.steps)))

  lines.push(divider())
  lines.push(rule([{ text: "Todos", style: styles.header }]))
  if (vm.todos.length === 0) {
    lines.push(rule([{ text: "(none)", style: styles.dim }]))
  } else {
    for (const todo of vm.todos) {
      const done = todo.status === "completed"
      const active = todo.status === "in_progress"
      const icon = done ? "✓" : active ? "◐" : "○"
      const style = done ? styles.green : active ? styles.yellow : styles.gray
      const textStyle = active ? styles.bold : done ? styles.dim : undefined
      lines.push(rule([{ text: `${icon} `, style }, { text: truncateToWidth(todo.content, Math.max(1, inner - 2), "…"), style: textStyle }]))
    }
  }

  while (lines.length < rect.height) lines.push(rule([]))
  return lines.slice(0, rect.height)
}

// Context block: used/max ratio, a meter with the auto-compact threshold tick,
// and the absolute compaction trigger. Colors escalate as usage approaches the
// threshold (green -> yellow within 75% of it -> red at/after it).
function renderContextPanel(
  vm: TuiViewModel,
  inner: number,
  rule: (segs: Segment[]) => string,
  styles: Styles,
): string[] {
  const lines: string[] = []
  const used = vm.contextTokens
  const max = vm.maxContextTokens
  const pctText = used != null && max ? `${Math.min(100, Math.round((used / max) * 100))}%` : ""
  const title: Segment[] = [{ text: "Context", style: styles.header }]
  if (pctText) {
    const gap = Math.max(1, inner - stringWidth("Context") - stringWidth(pctText) - 1)
    title.push({ text: " ".repeat(gap) }, { text: pctText, style: usageStyle(used ?? 0, max ?? 0, vm.compactAtTokens, styles) })
  }
  lines.push(rule(title))
  if (used != null && max) {
    lines.push(rule(meterSegments(used, max, vm.compactAtTokens, Math.max(4, inner - 1), styles)))
    lines.push(rule([{ text: `${formatTokens(used)} of ${formatTokens(max)}`, style: styles.dim }]))
    if (vm.compactAtTokens) {
      lines.push(
        rule([
          { text: "auto-compact @ ", style: styles.dim },
          { text: formatTokens(vm.compactAtTokens), style: styles.yellow },
          { text: ` (${Math.round((vm.compactAtTokens / max) * 100)}%)`, style: styles.dim },
        ]),
      )
    }
  } else {
    lines.push(rule([{ text: used != null ? `~${formatTokens(used)}` : "(no estimate yet)", style: styles.dim }]))
  }
  return lines
}

function usageStyle(used: number, max: number, compactAt: number | undefined, styles: Styles): Style {
  const threshold = compactAt ?? max
  if (used >= threshold) return styles.red
  if (used >= threshold * 0.75) return styles.yellow
  return styles.green
}

// Usage meter with a tick at the auto-compact threshold. The tick stays visible
// while unfilled; once usage crosses it the whole fill turns red, which reads
// louder than the tick anyway.
export function meterSegments(used: number, max: number, compactAt: number | undefined, width: number, styles: Styles): Segment[] {
  const ratio = Math.max(0, Math.min(1, used / max))
  const filled = Math.round(ratio * width)
  const tick = compactAt != null && compactAt < max ? Math.min(width - 1, Math.round((compactAt / max) * width)) : undefined
  const fillStyle = usageStyle(used, max, compactAt, styles)
  const segs: Segment[] = []
  if (filled > 0) segs.push({ text: "█".repeat(filled), style: fillStyle })
  if (tick != null && tick >= filled) {
    if (tick > filled) segs.push({ text: "░".repeat(tick - filled), style: styles.gray })
    segs.push({ text: "▏", style: styles.red })
    if (width - tick - 1 > 0) segs.push({ text: "░".repeat(width - tick - 1), style: styles.gray })
  } else if (width - filled > 0) {
    segs.push({ text: "░".repeat(width - filled), style: styles.gray })
  }
  return segs
}

function renderStatusBar(vm: TuiViewModel, width: number, styles: Styles, activity?: Activity): string {
  const state = stateSegment(vm, activity)
  const segs: Array<{ text: string; fg: number }> = [
    { text: "lightcc", fg: 231 },
    { text: vm.model, fg: 45 },
    { text: String(vm.permissionMode), fg: 250 },
  ]
  if (vm.contextTokens != null) {
    const max = vm.maxContextTokens
    const pct = max ? ` ${Math.min(100, Math.round((vm.contextTokens / max) * 100))}%` : ""
    const threshold = vm.compactAtTokens ?? max
    const fg = threshold && vm.contextTokens >= threshold ? 203 : threshold && vm.contextTokens >= threshold * 0.75 ? 221 : 250
    segs.push({ text: `ctx ${formatTokens(vm.contextTokens)}${max ? `/${formatTokens(max)}` : ""}${pct}`, fg })
  }
  segs.push({ text: `↑${formatTokens(vm.usage.inputTokens)} ↓${formatTokens(vm.usage.outputTokens)}`, fg: 245 })
  const cache = cacheHitRate(vm)
  if (cache != null) segs.push({ text: `cache ${cache}%`, fg: 245 })
  segs.push(state)
  if (vm.turnState === "idle") segs.push({ text: "? help", fg: 240 })

  if (!styles.enabled) {
    return padToWidth(truncateToWidth(` ${segs.map((s) => s.text).join("  ·  ")} `, width, "…"), width)
  }

  const bg = `${CSI}48;5;${STATUS_BG}m`
  let out = `${bg} `
  let used = 1
  for (let i = 0; i < segs.length; i++) {
    if (used >= width) break
    if (i > 0) {
      if (used + 3 >= width) break
      out += `${bg}${CSI}38;5;239m · `
      used += 3
    }
    const vis = truncateToWidth(segs[i].text, width - used, "")
    if (!vis) continue
    out += `${bg}${CSI}38;5;${segs[i].fg}m${vis}`
    used += stringWidth(vis)
  }
  if (used < width) out += `${bg}${" ".repeat(width - used)}`
  return `${out}${CSI}0m`
}

function stateSegment(vm: TuiViewModel, activity?: Activity): { text: string; fg: number } {
  const spin = activity?.spinner ?? "•"
  switch (vm.turnState) {
    case "thinking":
      return { text: `${spin} thinking${elapsedSuffix(activity?.turnElapsedMs)}`, fg: 221 }
    case "running":
      return { text: `${spin} ${vm.activeLabel ?? "running"}${elapsedSuffix(activity?.toolElapsedMs ?? activity?.turnElapsedMs)}`, fg: 221 }
    case "awaiting-approval":
      return { text: "⏸ approval needed", fg: 215 }
    case "error":
      return { text: "✗ error", fg: 203 }
    default:
      return { text: "● ready", fg: 78 }
  }
}

function renderInput(
  vm: TuiViewModel,
  editor: InputState,
  rect: Rect,
  styles: Styles,
  copyMode?: boolean,
): { lines: string[]; cursor?: { row: number; col: number } } {
  const lines: string[] = []
  if (copyMode) {
    lines.push(composeLine([{ text: "✂ copy mode ", style: styles.yellow }, { text: "— drag to select, then Ctrl-G to resume", style: styles.dim }], rect.width))
    while (lines.length < rect.height) lines.push(composeLine([], rect.width))
    return { lines }
  }
  if (vm.pendingApproval) {
    lines.push(composeLine([{ text: "❯ ", style: styles.dim }, { text: "awaiting approval — a allow · d deny · Esc abort", style: styles.yellow }], rect.width))
    while (lines.length < rect.height) lines.push(composeLine([], rect.width))
    return { lines }
  }
  // Multi-line buffer: one row per line, vertically windowed around the cursor
  // when the buffer is taller than the input region. Only the cursor's line
  // scrolls horizontally; other lines truncate.
  const rawLines = editor.buffer.split("\n")
  const curLine = cursorLine(editor)
  const curCol = cursorColumn(editor)
  const height = Math.max(1, rect.height)
  let top = Math.max(0, rawLines.length - height)
  if (curLine < top) top = curLine
  if (curLine >= top + height) top = curLine - height + 1
  let cursor: { row: number; col: number } | undefined
  for (let i = top; i < Math.min(rawLines.length, top + height); i++) {
    const prompt = i === 0 ? "❯ " : "│ "
    const promptStyle = i === 0 ? styles.cyanBold : styles.dim
    const promptWidth = stringWidth(prompt)
    const avail = Math.max(1, rect.width - promptWidth)
    const text = rawLines[i] ?? ""
    if (i === curLine) {
      const startCol = curCol > avail ? curCol - avail : 0
      lines.push(composeLine([{ text: prompt, style: promptStyle }, { text: sliceByWidth(text, startCol, avail) }], rect.width))
      cursor = { row: rect.y + (i - top), col: rect.x + promptWidth + (curCol - startCol) }
    } else {
      lines.push(composeLine([{ text: prompt, style: promptStyle }, { text: truncateToWidth(text, avail) }], rect.width))
    }
  }
  while (lines.length < rect.height) lines.push(composeLine([], rect.width))
  return { lines, cursor }
}

function composeLine(segments: Segment[], width: number): string {
  let out = ""
  let used = 0
  for (const seg of segments) {
    if (!seg.text || used >= width) continue
    const visible = truncateToWidth(seg.text, width - used, "")
    if (!visible) continue
    used += stringWidth(visible)
    out += seg.style ? seg.style(visible) : visible
  }
  if (used < width) out += " ".repeat(width - used)
  return out
}

function sliceByWidth(text: string, startCol: number, width: number): string {
  let col = 0
  let out = ""
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (col >= startCol && col + w <= startCol + width) out += ch
    col += w
  }
  return out
}

function elapsedSuffix(ms?: number): string {
  const text = formatElapsed(ms)
  return text ? `  ${text}` : ""
}

function formatElapsed(ms?: number): string {
  if (ms == null) return ""
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`
}

function cacheHitRate(vm: TuiViewModel): number | null {
  const total = vm.usage.cacheHitTokens + vm.usage.cacheMissTokens
  if (total <= 0) return null
  return Math.round((vm.usage.cacheHitTokens / total) * 100)
}
