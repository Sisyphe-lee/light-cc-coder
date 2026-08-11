import type { Style, Styles } from "./style"
import { charWidth } from "./width"

// Lightweight markdown styling for assistant text in the TUI. This is not a
// spec-compliant parser: it recognizes just the constructs that matter for
// terminal readability — fenced code blocks, inline `code`, **bold**, headings,
// list bullets, and blockquotes — and leaves everything else verbatim. The
// output is rows of styled segments already wrapped to the target width, so the
// renderer only has to compose them. Parsing runs over the full text on every
// paint, which keeps it correct under streaming (an unclosed fence simply
// styles the tail as code until the closing fence arrives).

export type Segment = { text: string; style?: Style }

export function renderMarkdown(text: string, width: number, styles: Styles): Segment[][] {
  const rows: Segment[][] = []
  let inFence = false
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      rows.push([{ text: line.trim(), style: styles.gray }])
      continue
    }
    if (inFence) {
      const gutter: Segment = { text: "  ", style: styles.dim }
      rows.push(...wrapSegments([gutter, { text: line, style: styles.codeBlock }], width, gutter))
      continue
    }
    // GFM table: a pipe row followed by a separator row starts a block of
    // consecutive pipe rows, rendered as an aligned grid.
    if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? "")) {
      const block: string[] = [line]
      let j = i + 1
      while (j < lines.length && isTableRow(lines[j])) {
        block.push(lines[j])
        j += 1
      }
      rows.push(...renderTable(block, width, styles))
      i = j - 1
      continue
    }
    if (/^\s*([-_*])\s*(\1\s*){2,}$/.test(line)) {
      rows.push([{ text: "─".repeat(Math.max(1, Math.min(width, 40))), style: styles.gray }])
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      rows.push(...wrapSegments([{ text: heading[2], style: styles.header }], width))
      continue
    }
    const bullet = /^(\s*)([-*+]|\d{1,3}\.)(\s+)(.*)$/.exec(line)
    if (bullet) {
      const [, indent, marker, gap, rest] = bullet
      const hang: Segment = { text: " ".repeat(indent.length + marker.length + gap.length) }
      rows.push(...wrapSegments([{ text: indent }, { text: marker, style: styles.cyan }, { text: gap }, ...inlineSegments(rest, styles)], width, hang))
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const rest = line.replace(/^\s*>\s?/, "")
      const gutter: Segment = { text: "▎ ", style: styles.gray }
      rows.push(...wrapSegments([gutter, ...inlineSegments(rest, styles).map((s) => ({ ...s, style: s.style ?? styles.dim }))], width, gutter))
      continue
    }
    rows.push(...wrapSegments(inlineSegments(line, styles), width))
  }
  return rows
}

// Split a line into styled segments for inline `code`, [links](url), and
// **bold**. Backticks win over the others so markers inside code stay literal.
export function inlineSegments(line: string, styles: Styles): Segment[] {
  const out: Segment[] = []
  for (const part of splitAlternating(line, /`([^`]+)`/g)) {
    if (part.matched) {
      out.push({ text: part.text, style: styles.inlineCode })
      continue
    }
    const text = part.text
    let last = 0
    for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      const index = match.index ?? 0
      if (index > last) out.push(...boldSegments(text.slice(last, index), styles))
      out.push({ text: match[1], style: styles.link }, { text: ` (${match[2]})`, style: styles.dim })
      last = index + match[0].length
    }
    if (last < text.length || text.length === 0) out.push(...boldSegments(text.slice(last), styles))
  }
  return out.length > 0 ? out : [{ text: "" }]
}

function boldSegments(text: string, styles: Styles): Segment[] {
  const out: Segment[] = []
  for (const bold of splitAlternating(text, /\*\*([^*]+)\*\*/g)) {
    if (bold.text.length > 0) out.push({ text: bold.text, style: bold.matched ? styles.bold : undefined })
  }
  return out
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)
}

function parseCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

// Render a table block (header, separator, body rows) as an aligned grid with
// light box-drawing joins. Column widths follow content, shrinking the widest
// columns until the grid fits; cells truncate rather than wrap. Falls back to
// raw text when the terminal is too narrow for the column count.
function renderTable(block: string[], width: number, styles: Styles): Segment[][] {
  const header = parseCells(block[0])
  const body = block.slice(2).map(parseCells)
  const columns = Math.max(header.length, ...body.map((cells) => cells.length), 1)
  const cellSegs = (cells: string[], col: number): Segment[] => inlineSegments(cells[col] ?? "", styles)
  const cellWidth = (segs: Segment[]): number => segs.reduce((total, seg) => total + measure(seg.text), 0)

  const widths: number[] = []
  for (let col = 0; col < columns; col++) {
    widths.push(Math.max(cellWidth(cellSegs(header, col)), ...body.map((cells) => cellWidth(cellSegs(cells, col))), 1))
  }
  const overhead = 3 * (columns - 1)
  const available = width - overhead
  if (available < columns * 3) {
    return block.map((line) => wrapSegments([{ text: line }], width)).flat()
  }
  // Shrink the widest column one cell at a time until the grid fits.
  while (widths.reduce((a, b) => a + b, 0) > available) {
    const max = Math.max(...widths)
    const index = widths.indexOf(max)
    widths[index] = Math.max(3, max - 1)
    if (max <= 3) break
  }

  const gridRow = (cells: string[], bold: boolean): Segment[] => {
    const segs: Segment[] = []
    for (let col = 0; col < columns; col++) {
      if (col > 0) segs.push({ text: " │ ", style: styles.gray })
      const fitted = fitSegments(cellSegs(cells, col), widths[col])
      segs.push(...(bold ? fitted.map((seg) => ({ ...seg, style: seg.style ?? styles.bold })) : fitted))
    }
    return segs
  }
  const rows: Segment[][] = [gridRow(header, true)]
  rows.push([{ text: widths.map((w) => "─".repeat(w)).join("─┼─"), style: styles.gray }])
  for (const cells of body) rows.push(gridRow(cells, false))
  return rows
}

// Cut styled segments to exactly `width` display columns, padding with spaces
// and marking truncation with an ellipsis.
function fitSegments(segments: Segment[], width: number): Segment[] {
  const total = segments.reduce((sum, seg) => sum + measure(seg.text), 0)
  const out: Segment[] = []
  let used = 0
  for (const seg of segments) {
    if (used >= width) break
    let text = ""
    for (const ch of seg.text) {
      const w = charWidth(ch.codePointAt(0) ?? 0)
      const budget = total > width ? width - 1 : width // reserve one cell for the ellipsis
      if (used + w > budget) break
      text += ch
      used += w
    }
    if (text.length > 0) out.push({ text, style: seg.style })
    if (measure(text) < measure(seg.text)) break
  }
  if (total > width && used < width) {
    out.push({ text: "…" })
    used += 1
  }
  if (used < width) out.push({ text: " ".repeat(width - used) })
  return out
}

// Alternate unmatched/matched runs of `regex` over `text`, with the delimiters
// stripped from matched runs.
function splitAlternating(text: string, regex: RegExp): Array<{ text: string; matched: boolean }> {
  const parts: Array<{ text: string; matched: boolean }> = []
  let last = 0
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index), matched: false })
    parts.push({ text: match[1] ?? "", matched: true })
    last = index + match[0].length
  }
  if (last < text.length || parts.length === 0) parts.push({ text: text.slice(last), matched: false })
  return parts
}

// Hard-wrap styled segments to `width` display columns. Continuation rows are
// prefixed with `hang` (e.g. list hanging indent or a code gutter).
export function wrapSegments(segments: Segment[], width: number, hang?: Segment): Segment[][] {
  const max = Math.max(1, width)
  const rows: Segment[][] = []
  let row: Segment[] = []
  let used = 0
  const startRow = (): void => {
    row = hang && rows.length > 0 ? [hang] : []
    used = hang && rows.length > 0 ? measure(hang.text) : 0
  }
  const flush = (): void => {
    rows.push(row)
    startRow()
  }
  for (const seg of segments) {
    let text = ""
    for (const ch of seg.text) {
      const w = charWidth(ch.codePointAt(0) ?? 0)
      if (used + w > max && used > 0) {
        if (text.length > 0) row.push({ text, style: seg.style })
        text = ""
        flush()
      }
      text += ch
      used += w
    }
    if (text.length > 0 || seg.text.length === 0) row.push({ text, style: seg.style })
  }
  rows.push(row)
  return rows
}

function measure(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0)
  return width
}
