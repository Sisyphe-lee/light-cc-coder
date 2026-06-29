import type { Key } from "./keys"
import { stringWidth } from "./width"

// Pure single-line input editor with cursor, history, and common readline-style
// bindings. Operates on code points (via Array.from) so multi-byte and CJK input
// edit cleanly. App-level keys (scroll, redraw, approval) are not handled here;
// applyKey returns "ignored" so the orchestrator can route them.

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
    case "enter": {
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
      return { kind: "update", state: { ...state, cursor: 0 } }
    case "end":
      return { kind: "update", state: { ...state, cursor: chars.length } }
    case "up":
      return { kind: "update", state: historyPrev(state) }
    case "down":
      return { kind: "update", state: historyNext(state) }
    case "ctrl":
      return applyCtrl(state, chars, key.value)
    default:
      return { kind: "ignored" }
  }
}

export function cursorColumn(state: InputState): number {
  // Display columns consumed by the buffer before the cursor.
  return stringWidth(Array.from(state.buffer).slice(0, state.cursor).join(""))
}

function insert(state: InputState, chars: string[], value: string): InputState {
  const inserted = Array.from(value)
  const next = chars.slice(0, state.cursor).concat(inserted, chars.slice(state.cursor))
  return { ...state, buffer: next.join(""), cursor: state.cursor + inserted.length }
}

function applyCtrl(state: InputState, chars: string[], value: string): EditResult {
  switch (value) {
    case "c":
      return { kind: "interrupt" }
    case "d":
      return state.buffer.length === 0 ? { kind: "eof" } : { kind: "ignored" }
    case "a":
      return { kind: "update", state: { ...state, cursor: 0 } }
    case "e":
      return { kind: "update", state: { ...state, cursor: chars.length } }
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
  while (i > 0 && chars[i - 1] !== " ") i -= 1
  return i
}
