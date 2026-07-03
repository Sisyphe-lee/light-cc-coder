// Display-width helpers for the TUI. Terminal cells are not 1:1 with JS string
// length: CJK and emoji occupy two columns, combining marks occupy none. These
// keep layout math correct without pulling in an external dependency.

export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0
  // C0/C1 controls render unpredictably; treat as zero so they do not shift layout.
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  // Combining marks and zero-width joiners.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x200b ||
    codePoint === 0x200d ||
    codePoint === 0xfeff
  )
    return 0
  return isWide(codePoint) ? 2 : 1
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji and symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  )
}

// ANSI escape sequences: CSI (colors, cursor), OSC (titles), and single-char
// ESC forms. Stripped from display text so tool/model output cannot corrupt
// the frame or move the cursor.
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g

// Normalize arbitrary text for cell-exact rendering: drop ANSI escapes, expand
// tabs (the renderer treats controls as zero-width, but a real terminal jumps
// to the next tab stop — that mismatch leaves stale cells), and drop remaining
// C0 controls except newline.
export function sanitizeDisplayText(text: string, tabWidth = 4): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replace(/\t/g, " ".repeat(Math.max(1, tabWidth)))
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

export function stringWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0)
  return width
}

// Pad (or truncate) a string to exactly `width` display columns.
export function padToWidth(text: string, width: number): string {
  if (width <= 0) return ""
  const current = stringWidth(text)
  if (current === width) return text
  if (current < width) return text + " ".repeat(width - current)
  return truncateToWidth(text, width, "")
}

// Truncate to a maximum display width, appending `ellipsis` when content is cut.
export function truncateToWidth(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return ""
  if (stringWidth(text) <= max) return text
  const budget = Math.max(0, max - stringWidth(ellipsis))
  let width = 0
  let out = ""
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (width + w > budget) break
    out += ch
    width += w
  }
  return out + ellipsis
}

// Hard-wrap text to a column width, honoring existing newlines and display width.
// A returned row never exceeds `width` display columns. Empty input keeps one row.
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""]
  const rows: string[] = []
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      rows.push("")
      continue
    }
    let current = ""
    let currentWidth = 0
    for (const ch of rawLine) {
      const w = charWidth(ch.codePointAt(0) ?? 0)
      if (currentWidth + w > width && current.length > 0) {
        rows.push(current)
        current = ""
        currentWidth = 0
      }
      current += ch
      currentWidth += w
    }
    rows.push(current)
  }
  return rows
}
