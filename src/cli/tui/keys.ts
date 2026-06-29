// Pure decoder from raw stdin bytes to key events. Keeping this stateless and
// side-effect free makes input handling testable without a TTY. Chunk splitting
// across escape sequences is rare for interactive keypresses; a trailing lone
// ESC degrades to an "escape" key rather than corrupting later input.

export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
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

const ESCAPE_TABLE: Array<[string, Key]> = [
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
      const matched = matchEscape(input, i)
      if (matched) {
        keys.push(matched.key)
        i = matched.next
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

function matchEscape(input: string, start: number): { key: Key; next: number } | undefined {
  for (const [seq, key] of ESCAPE_TABLE) {
    if (input.startsWith(seq, start)) return { key, next: start + seq.length }
  }
  return undefined
}
