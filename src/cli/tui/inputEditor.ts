import type { Key } from "./keys"
import { stringWidth } from "./width"

// Pure multi-line input editor with cursor, history, and common readline-style
// bindings. Operates on code points (via Array.from) so multi-byte and CJK input
// edit cleanly. The buffer may contain newlines: Alt+Enter and bracketed paste
// insert them, a trailing backslash before Enter continues the line, and
// Up/Down move within lines before falling back to history recall. App-level
// keys (scroll, redraw, approval) are not handled here; applyKey returns
// "ignored" so the orchestrator can route them.

export type InputState = {
  buffer: string
  cursor: number // index into the code-point array, 0..length
  history: string[]
  historyIndex: number // history.length means "current draft"
  draft: string
}

export type EditResult =
  | { kind: "update"; state: InputState }
  | { kind: "submit"; state: InputState; value: string }
  | { kind: "interrupt" } // Ctrl-C
  | { kind: "eof" } // Ctrl-D on an empty buffer
  | { kind: "ignored" }

export function initialInputState(history: string[] = []): InputState {
  return { buffer: "", cursor: 0, history, historyIndex: history.length, draft: "" }
}

export function applyKey(state: InputState, key: Key): EditResult {
  const chars = Array.from(state.buffer)
  switch (key.type) {
    case "char":
      return { kind: "update", state: insert(state, chars, key.value) }
    case "paste":
      return key.value.length === 0 ? { kind: "ignored" } : { kind: "update", state: insert(state, chars, key.value) }
    case "altEnter":
      return { kind: "update", state: insert(state, chars, "\n") }
    case "enter": {
      // A trailing backslash continues onto a new line instead of submitting.
      if (state.buffer.endsWith("\\")) {
        const next = chars.slice(0, -1).concat("\n")
        const cursor = state.cursor >= chars.length ? next.length : Math.min(state.cursor, next.length)
        return { kind: "update", state: { ...state, buffer: next.join(""), cursor } }
      }
      const value = state.buffer
      if (value.trim().length === 0) return { kind: "ignored" }
      const history = [...state.history, value]
      return { kind: "submit", state: { buffer: "", cursor: 0, history, historyIndex: history.length, draft: "" }, value }
    }
    case "backspace": {
      if (state.cursor === 0) return { kind: "update", state }
      const next = chars.slice(0, state.cursor - 1).concat(chars.slice(state.cursor))
      return { kind: "update", state: { ...state, buffer: next.join(""), cursor: state.cursor - 1 } }
    }
    case "delete": {
      if (state.cursor >= chars.length) return { kind: "update", state }
      const next = chars.slice(0, state.cursor).concat(chars.slice(state.cursor + 1))
      return { kind: "update", state: { ...state, buffer: next.join("") } }
    }
    case "left":
      return { kind: "update", state: { ...state, cursor: Math.max(0, state.cursor - 1) } }
    case "right":
      return { kind: "update", state: { ...state, cursor: Math.min(chars.length, state.cursor + 1) } }
    case "home":
      return { kind: "update", state: { ...state, cursor: lineBounds(chars, state.cursor).start } }
    case "end":
      return { kind: "update", state: { ...state, cursor: lineBounds(chars, state.cursor).end } }
    case "up": {
      const moved = moveVertical(state, chars, -1)
      return { kind: "update", state: moved ?? historyPrev(state) }
    }
    case "down": {
      const moved = moveVertical(state, chars, 1)
      return { kind: "update", state: moved ?? historyNext(state) }
    }
    case "ctrl":
      return applyCtrl(state, chars, key.value)
    default:
      return { kind: "ignored" }
  }
}

// Display columns consumed by the buffer on the cursor's line, before the cursor.
export function cursorColumn(state: InputState): number {
  const chars = Array.from(state.buffer)
  const { start } = lineBounds(chars, state.cursor)
  return stringWidth(chars.slice(start, state.cursor).join(""))
}

// 0-based line index of the cursor, for multi-row input rendering.
export function cursorLine(state: InputState): number {
  const chars = Array.from(state.buffer)
  let line = 0
  for (let i = 0; i < state.cursor && i < chars.length; i++) if (chars[i] === "\n") line += 1
  return line
}

function insert(state: InputState, chars: string[], value: string): InputState {
  const inserted = Array.from(value)
  const next = chars.slice(0, state.cursor).concat(inserted, chars.slice(state.cursor))
  return { ...state, buffer: next.join(""), cursor: state.cursor + inserted.length }
}

// Start/end code-point indexes of the line containing `cursor` (end excludes \n).
function lineBounds(chars: string[], cursor: number): { start: number; end: number } {
  let start = Math.min(cursor, chars.length)
  while (start > 0 && chars[start - 1] !== "\n") start -= 1
  let end = Math.min(cursor, chars.length)
  while (end < chars.length && chars[end] !== "\n") end += 1
  return { start, end }
}

// Move the cursor one line up/down keeping the column, or undefined when the
// cursor is already on the first/last line (the caller falls back to history).
function moveVertical(state: InputState, chars: string[], dir: -1 | 1): InputState | undefined {
  const { start, end } = lineBounds(chars, state.cursor)
  if (dir === -1 && start === 0) return undefined
  if (dir === 1 && end >= chars.length) return undefined
  const col = state.cursor - start
  const target = dir === -1 ? lineBounds(chars, start - 1) : lineBounds(chars, end + 1)
  return { ...state, cursor: Math.min(target.start + col, target.end) }
}

function applyCtrl(state: InputState, chars: string[], value: string): EditResult {
  switch (value) {
    case "c":
      return { kind: "interrupt" }
    case "d":
      return state.buffer.length === 0 ? { kind: "eof" } : { kind: "ignored" }
    case "a":
      return { kind: "update", state: { ...state, cursor: lineBounds(chars, state.cursor).start } }
    case "e":
      return { kind: "update", state: { ...state, cursor: lineBounds(chars, state.cursor).end } }
    case "u": {
      const next = chars.slice(state.cursor)
      return { kind: "update", state: { ...state, buffer: next.join(""), cursor: 0 } }
    }
    case "k": {
      const next = chars.slice(0, state.cursor)
      return { kind: "update", state: { ...state, buffer: next.join("") } }
    }
    case "w": {
      const start = wordStart(chars, state.cursor)
      const next = chars.slice(0, start).concat(chars.slice(state.cursor))
      return { kind: "update", state: { ...state, buffer: next.join(""), cursor: start } }
    }
    default:
      return { kind: "ignored" }
  }
}

function historyPrev(state: InputState): InputState {
  if (state.history.length === 0) return state
  const atDraft = state.historyIndex >= state.history.length
  const draft = atDraft ? state.buffer : state.draft
  const index = Math.max(0, state.historyIndex - 1)
  const buffer = state.history[index] ?? ""
  return { ...state, historyIndex: index, buffer, cursor: Array.from(buffer).length, draft }
}

function historyNext(state: InputState): InputState {
  if (state.historyIndex >= state.history.length) return state
  const index = state.historyIndex + 1
  const buffer = index >= state.history.length ? state.draft : state.history[index] ?? ""
  return { ...state, historyIndex: Math.min(index, state.history.length), buffer, cursor: Array.from(buffer).length }
}

function wordStart(chars: string[], cursor: number): number {
  let i = cursor
  while (i > 0 && chars[i - 1] === " ") i -= 1
  while (i > 0 && chars[i - 1] !== " " && chars[i - 1] !== "\n") i -= 1
  return i
}
