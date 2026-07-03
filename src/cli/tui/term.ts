// Thin side-effecting wrapper over a TTY: alternate screen, raw mode, cursor
// visibility, size, and raw key/resize subscriptions. All escape-sequence
// composition for the frame lives in render.ts; this module only drives the
// real streams so the rest of the TUI stays testable.

const CSI = "\x1b["

export type TerminalSize = { rows: number; cols: number }

export type Terminal = {
  size(): TerminalSize
  write(text: string): void
  enter(): void
  leave(): void
  clear(): void
  setMouseCapture(on: boolean): void
  onKey(handler: (chunk: string) => void): void
  onResize(handler: () => void): void
}

const MOUSE_ON = `${CSI}?1000h${CSI}?1006h` // button + SGR extended mouse reporting
const MOUSE_OFF = `${CSI}?1000l${CSI}?1006l`

export function createTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Terminal {
  let keyHandler: ((chunk: string) => void) | undefined
  let resizeHandler: (() => void) | undefined
  const onData = (chunk: Buffer | string): void => {
    keyHandler?.(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
  }
  const onResize = (): void => resizeHandler?.()

  return {
    size() {
      return { rows: output.rows ?? 24, cols: output.columns ?? 80 }
    },
    write(text) {
      output.write(text)
    },
    enter() {
      output.write(`${CSI}?1049h`) // enter alternate screen buffer
      output.write(`${CSI}?2004h`) // bracketed paste, so pasted newlines insert instead of submitting
      output.write(MOUSE_ON) // capture the mouse so the wheel scrolls the TUI, not the terminal scrollback
      output.write(`${CSI}?25l`) // hide cursor while painting
      output.write(`${CSI}2J${CSI}H`) // clear once on entry
      if (input.isTTY) input.setRawMode?.(true)
      input.setEncoding("utf8")
      input.resume()
      input.on("data", onData)
      output.on("resize", onResize)
    },
    leave() {
      input.off("data", onData)
      output.off("resize", onResize)
      if (input.isTTY) input.setRawMode?.(false)
      input.pause()
      output.write(MOUSE_OFF) // release mouse capture
      output.write(`${CSI}?2004l`) // disable bracketed paste
      output.write(`${CSI}?25h`) // restore cursor
      output.write(`${CSI}?1049l`) // leave alternate screen buffer
    },
    clear() {
      output.write(`${CSI}2J${CSI}H`)
    },
    setMouseCapture(on) {
      // Toggle mouse reporting at runtime: off lets the user drag-select and copy
      // with the terminal's native selection; on returns the wheel to the TUI.
      output.write(on ? MOUSE_ON : MOUSE_OFF)
    },
    onKey(handler) {
      keyHandler = handler
    },
    onResize(handler) {
      resizeHandler = handler
    },
  }
}
