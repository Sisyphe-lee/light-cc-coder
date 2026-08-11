// Pure decoder from raw stdin bytes to key events. Keeping this stateless and
// side-effect free makes input handling testable without a TTY. Chunk splitting
// across escape sequences is rare for interactive keypresses; a trailing lone
// ESC degrades to an "escape" key rather than corrupting later input.

export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "altEnter" } // Alt+Enter (ESC CR) — inserts a newline instead of submitting
  | { type: "paste"; value: string } // bracketed paste payload, newlines normalized to \n
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "escape" }
  | { type: "ctrl"; value: string } // value is a lowercase letter, e.g. "c", "u", "w"
  | { type: "wheelUp" }
  | { type: "wheelDown" }
  | { type: "mouse" } // other mouse events (clicks/drags) — ignored by the app
  | { type: "unknown" } // unrecognized escape/Alt sequence, consumed whole — ignored by the app

// Bracketed paste (DECSET 2004) delimiters. term.ts enables the mode; here the
// payload between the markers becomes a single "paste" key so newlines in
// pasted text insert instead of submitting line by line.
export const PASTE_START = "\x1b[200~"
export const PASTE_END = "\x1b[201~"

const ESCAPE_TABLE: Array<[string, Key]> = [
  ["\x1b\r", { type: "altEnter" }],
  ["\x1b\n", { type: "altEnter" }],
  ["\x1b[A", { type: "up" }],
  ["\x1b[B", { type: "down" }],
  ["\x1b[C", { type: "right" }],
  ["\x1b[D", { type: "left" }],
  ["\x1b[H", { type: "home" }],
  ["\x1b[F", { type: "end" }],
  ["\x1b[1~", { type: "home" }],
  ["\x1b[4~", { type: "end" }],
  ["\x1b[3~", { type: "delete" }],
  ["\x1b[5~", { type: "pageUp" }],
  ["\x1b[6~", { type: "pageDown" }],
  ["\x1bOA", { type: "up" }],
  ["\x1bOB", { type: "down" }],
  ["\x1bOC", { type: "right" }],
  ["\x1bOD", { type: "left" }],
  ["\x1bOH", { type: "home" }],
  ["\x1bOF", { type: "end" }],
]

export function decodeKeys(input: string): Key[] {
  const keys: Key[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    const code = input.charCodeAt(i)
    if (ch === "\x1b") {
      if (input.startsWith(PASTE_START, i)) {
        const end = input.indexOf(PASTE_END, i + PASTE_START.length)
        // Unterminated paste (chunk split) degrades to "take the rest"; the
        // orchestrator carries unterminated tails so this is a last resort.
        const payload = end === -1 ? input.slice(i + PASTE_START.length) : input.slice(i + PASTE_START.length, end)
        keys.push({ type: "paste", value: normalizePaste(payload) })
        i = end === -1 ? input.length : end + PASTE_END.length
        continue
      }
      const mouse = matchMouse(input, i)
      if (mouse) {
        keys.push(mouse.key)
        i = mouse.next
        continue
      }
      const matched = matchEscape(input, i)
      if (matched) {
        keys.push(matched.key)
        i = matched.next
        continue
      }
      // Unrecognized sequences are consumed whole as "unknown" so their bytes
      // never leak into the buffer as typed characters. A lone trailing ESC is
      // a real Escape keypress (terminals send it in its own chunk).
      const unknown = matchUnknownSequence(input, i)
      if (unknown) {
        keys.push({ type: "unknown" })
        i = unknown.next
        continue
      }
      keys.push({ type: "escape" })
      i += 1
      continue
    }
    if (ch === "\r" || ch === "\n") {
      keys.push({ type: "enter" })
      i += 1
      continue
    }
    if (code === 0x7f || code === 0x08) {
      keys.push({ type: "backspace" })
      i += 1
      continue
    }
    if (ch === "\t") {
      keys.push({ type: "tab" })
      i += 1
      continue
    }
    if (code < 0x20) {
      // Remaining C0 controls map to Ctrl-<letter>: 0x01 -> "a", 0x03 -> "c".
      keys.push({ type: "ctrl", value: String.fromCharCode(code + 96) })
      i += 1
      continue
    }
    const cp = input.codePointAt(i) ?? code
    const str = String.fromCodePoint(cp)
    keys.push({ type: "char", value: str })
    i += str.length
  }
  return keys
}

// Normalize CRLF/CR to LF, expand tabs to spaces (the input renderer is
// cell-exact and cannot represent tab stops), and drop other C0 controls so
// pasted text edits cleanly and cannot smuggle escape sequences into the buffer.
function normalizePaste(text: string): string {
  let out = ""
  for (const ch of text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ")) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 && ch !== "\n") continue
    if (code === 0x7f) continue
    out += ch
  }
  return out
}

function matchEscape(input: string, start: number): { key: Key; next: number } | undefined {
  for (const [seq, key] of ESCAPE_TABLE) {
    if (input.startsWith(seq, start)) return { key, next: start + seq.length }
  }
  return undefined
}

// Consume an unrecognized escape-prefixed sequence in full: CSI (ESC [ params
// intermediates final), SS3 (ESC O x), or an Alt+key chord (ESC x). Returns
// undefined for a lone trailing ESC.
function matchUnknownSequence(input: string, start: number): { next: number } | undefined {
  if (start + 1 >= input.length) return undefined
  const second = input[start + 1]
  if (second === "[") {
    let j = start + 2
    while (j < input.length && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j += 1
    while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j += 1
    if (j < input.length && input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e) return { next: j + 1 }
    return { next: input.length } // truncated CSI — drop the tail
  }
  if (second === "O") return { next: Math.min(input.length, start + 3) }
  if (second === "\x1b") return undefined // ESC ESC: let the loop emit two escapes
  const cp = input.codePointAt(start + 1) ?? 0
  return { next: start + 1 + String.fromCodePoint(cp).length } // Alt+key
}

// SGR mouse reports (DECSET 1006): ESC [ < Cb ; Cx ; Cy (M|m). The scroll wheel
// uses button codes 64 (up) and 65 (down); modifier/motion bits are masked off.
// Clicks and drags decode to a no-op "mouse" key so they never disturb input.
function matchMouse(input: string, start: number): { key: Key; next: number } | undefined {
  if (!input.startsWith("\x1b[<", start)) return undefined
  let j = start + 3
  while (j < input.length && input[j] !== "M" && input[j] !== "m") j += 1
  if (j >= input.length) return undefined // incomplete sequence; treat as bare ESC
  const cb = Number.parseInt(input.slice(start + 3, j).split(";")[0] ?? "", 10)
  const next = j + 1
  if (!Number.isFinite(cb)) return { key: { type: "mouse" }, next }
  const button = cb & 0b11000011 // strip shift(4)/alt(8)/ctrl(16)/motion(32) bits
  if (button === 64) return { key: { type: "wheelUp" }, next }
  if (button === 65) return { key: { type: "wheelDown" }, next }
  return { key: { type: "mouse" }, next }
}
