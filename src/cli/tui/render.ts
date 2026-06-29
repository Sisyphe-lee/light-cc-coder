import { cursorColumn, type InputState } from "./inputEditor"
import type { Rect, TuiLayout } from "./layout"
import type { Style, Styles } from "./style"
import type { PendingApproval, TranscriptItem, TuiViewModel } from "./viewModel"
import { charWidth, padToWidth, stringWidth, truncateToWidth, wrapText } from "./width"

// Pure frame composer: (view model + layout + input) -> a single string of ANSI
// positioning + styled cells that repaints the whole screen, plus where to park
// the cursor. Every emitted line is padded to its region width so a repaint
// overwrites stale cells without a full clear (less flicker than CSI 2J).

const CSI = "\x1b["

export type Frame = { output: string; cursor?: { row: number; col: number } }

export type RenderInput = {
  vm: TuiViewModel
  layout: TuiLayout
  editor: InputState
  scrollOffset: number
  styles: Styles
}

type Segment = { text: string; style?: Style }

export function renderFrame(input: RenderInput): Frame {
  const { vm, layout, editor, scrollOffset, styles } = input
  let out = ""

  const panel = vm.pendingApproval ? renderApprovalPanel(vm.pendingApproval, layout.transcript.width, styles) : []
  const transcriptHeight = Math.max(1, layout.transcript.height - panel.length)
  const allLines = renderTranscript(vm.items, layout.transcript.width, styles)
  const viewport = viewportSlice(allLines, transcriptHeight, scrollOffset, layout.transcript.width)
  viewport.forEach((line, i) => {
    out += at(layout.transcript.y + i, layout.transcript.x) + line
  })
  panel.forEach((line, i) => {
    out += at(layout.transcript.y + transcriptHeight + i, layout.transcript.x) + line
  })

  if (layout.sidebar) {
    const lines = renderSidebar(vm, layout.sidebar, styles)
    for (let i = 0; i < layout.sidebar.height; i++) {
      out += at(layout.sidebar.y + i, layout.sidebar.x) + (lines[i] ?? composeLine([], layout.sidebar.width))
    }
  }

  out += at(layout.status.y, layout.status.x) + renderStatusBar(vm, layout.status.width, styles)

  const inputRender = renderInput(vm, editor, layout.input, styles)
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

export function totalTranscriptLines(vm: TuiViewModel, width: number, styles: Styles): number {
  return renderTranscript(vm.items, width, styles).length
}

function renderTranscript(items: TranscriptItem[], width: number, styles: Styles): string[] {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind === "user") {
      if (lines.length > 0) lines.push(composeLine([], width))
      wrapText(item.text, Math.max(1, width - 2)).forEach((row, idx) => {
        lines.push(composeLine([{ text: idx === 0 ? "❯ " : "  ", style: styles.cyan }, { text: row, style: styles.bold }], width))
      })
    } else if (item.kind === "assistant") {
      for (const row of wrapText(item.text, width)) lines.push(composeLine([{ text: row }], width))
    } else if (item.kind === "tool") {
      lines.push(renderToolHeader(item, width, styles))
      if (item.resultPreview) {
        for (const row of wrapText(item.resultPreview, Math.max(1, width - 2)).slice(0, 2)) {
          lines.push(composeLine([{ text: "  " }, { text: row, style: styles.dim }], width))
        }
      }
    } else {
      const style = item.level === "error" ? styles.red : item.level === "warn" ? styles.yellow : styles.gray
      const icon = item.level === "error" ? "✗ " : item.level === "warn" ? "! " : "· "
      wrapText(item.text, Math.max(1, width - 2)).forEach((row, idx) => {
        lines.push(composeLine([{ text: idx === 0 ? icon : "  ", style }, { text: row, style }], width))
      })
    }
  }
  return lines
}

function renderToolHeader(
  item: Extract<TranscriptItem, { kind: "tool" }>,
  width: number,
  styles: Styles,
): string {
  const iconStyle = item.status === "ok" ? styles.green : item.status === "error" ? styles.red : styles.yellow
  const icon = item.status === "ok" ? "✓" : item.status === "error" ? "✗" : "•"
  return composeLine(
    [
      { text: icon, style: iconStyle },
      { text: " " },
      { text: item.name, style: styles.bold },
      { text: item.inputSummary ? "  " : "" },
      { text: item.inputSummary, style: styles.dim },
    ],
    width,
  )
}

function renderApprovalPanel(approval: PendingApproval, width: number, styles: Styles): string[] {
  const lines: string[] = []
  lines.push(composeLine([{ text: "┌ ", style: styles.yellow }, { text: `Approve ${approval.toolName}`, style: styles.bold }], width))
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
      [{ text: "│ ", style: styles.yellow }, { text: "[a]llow  [d]eny  [Esc] abort", style: styles.bold }],
      width,
    ),
  )
  return lines.slice(0, 6)
}

function renderSidebar(vm: TuiViewModel, rect: Rect, styles: Styles): string[] {
  const inner = Math.max(1, rect.width - 2)
  const rule = (segs: Segment[]): string => composeLine([{ text: "│ ", style: styles.dim }, ...segs], rect.width)
  const lines: string[] = []
  lines.push(rule([{ text: "Todos", style: styles.bold }]))
  if (vm.todos.length === 0) {
    lines.push(rule([{ text: "(none)", style: styles.dim }]))
  } else {
    for (const todo of vm.todos) {
      const done = todo.status === "completed"
      const active = todo.status === "in_progress"
      const icon = done ? "✓" : active ? "◐" : "○"
      const style = done ? styles.green : active ? styles.yellow : styles.gray
      lines.push(rule([{ text: `${icon} `, style }, { text: truncateToWidth(todo.content, Math.max(1, inner - 2), "…") }]))
    }
  }
  lines.push(rule([]))
  lines.push(rule([{ text: "Context", style: styles.bold }]))
  const ctx =
    vm.contextTokens != null
      ? `~${formatTokens(vm.contextTokens)}${vm.maxContextTokens ? ` / ${formatTokens(vm.maxContextTokens)}` : ""}`
      : "—"
  lines.push(rule([{ text: "tokens ", style: styles.dim }, { text: ctx }]))
  lines.push(rule([{ text: "in/out ", style: styles.dim }, { text: `${formatTokens(vm.usage.inputTokens)}/${formatTokens(vm.usage.outputTokens)}` }]))
  const cache = cacheHitRate(vm)
  if (cache != null) lines.push(rule([{ text: "cache ", style: styles.dim }, { text: `${cache}%` }]))
  while (lines.length < rect.height) lines.push(rule([]))
  return lines.slice(0, rect.height)
}

function renderStatusBar(vm: TuiViewModel, width: number, styles: Styles): string {
  const parts: string[] = ["lightcc", vm.model, String(vm.permissionMode)]
  if (vm.contextTokens != null) {
    parts.push(`ctx ~${formatTokens(vm.contextTokens)}${vm.maxContextTokens ? `/${formatTokens(vm.maxContextTokens)}` : ""}`)
  }
  parts.push(`↑${formatTokens(vm.usage.inputTokens)} ↓${formatTokens(vm.usage.outputTokens)}`)
  parts.push(stateLabel(vm))
  const text = ` ${parts.join("  ·  ")} `
  return styles.inverse(padToWidth(truncateToWidth(text, width, "…"), width))
}

function renderInput(
  vm: TuiViewModel,
  editor: InputState,
  rect: Rect,
  styles: Styles,
): { lines: string[]; cursor?: { row: number; col: number } } {
  const lines: string[] = []
  if (vm.pendingApproval) {
    lines.push(composeLine([{ text: "❯ ", style: styles.dim }, { text: "awaiting approval — a allow · d deny · Esc abort", style: styles.dim }], rect.width))
    while (lines.length < rect.height) lines.push(composeLine([], rect.width))
    return { lines }
  }
  const prompt = "❯ "
  const promptWidth = stringWidth(prompt)
  const avail = Math.max(1, rect.width - promptWidth)
  const cursor = cursorColumn(editor)
  const startCol = cursor > avail ? cursor - avail : 0
  const visible = sliceByWidth(editor.buffer, startCol, avail)
  lines.push(composeLine([{ text: prompt, style: styles.cyan }, { text: visible }], rect.width))
  while (lines.length < rect.height) lines.push(composeLine([], rect.width))
  return { lines, cursor: { row: rect.y, col: rect.x + promptWidth + (cursor - startCol) } }
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

function stateLabel(vm: TuiViewModel): string {
  switch (vm.turnState) {
    case "thinking":
      return "◌ thinking"
    case "running":
      return `▸ ${vm.activeLabel ?? "running"}`
    case "awaiting-approval":
      return "approval needed"
    case "error":
      return "error"
    default:
      return "● idle"
  }
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
