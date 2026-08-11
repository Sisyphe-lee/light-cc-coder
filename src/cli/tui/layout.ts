// Pure layout math: given a terminal size, carve out the transcript region, an
// optional right sidebar, a one-row status bar, and a multi-row input box. Rows
// and columns here are 0-indexed; the renderer converts to 1-indexed cursor
// positions when it writes.

export type Rect = { x: number; y: number; width: number; height: number }

export type TuiLayout = {
  transcript: Rect
  sidebar?: Rect
  status: Rect
  input: Rect
}

export type LayoutOptions = {
  rows: number
  cols: number
  showSidebar?: boolean
  sidebarWidth?: number
  inputHeight?: number
}

const STATUS_HEIGHT = 1
const MIN_SIDEBAR_COLS = 60 // hide the sidebar on narrow terminals

export function computeLayout(options: LayoutOptions): TuiLayout {
  const rows = Math.max(1, Math.floor(options.rows))
  const cols = Math.max(1, Math.floor(options.cols))
  const inputHeight = clamp(options.inputHeight ?? 1, 1, Math.max(1, rows - STATUS_HEIGHT - 1))
  const bodyHeight = Math.max(1, rows - STATUS_HEIGHT - inputHeight)

  const showSidebar = Boolean(options.showSidebar) && cols >= MIN_SIDEBAR_COLS
  const sidebarWidth = showSidebar ? clamp(options.sidebarWidth ?? 30, 18, Math.floor(cols / 3)) : 0
  const transcriptWidth = Math.max(1, cols - sidebarWidth)

  const layout: TuiLayout = {
    transcript: { x: 0, y: 0, width: transcriptWidth, height: bodyHeight },
    status: { x: 0, y: bodyHeight, width: cols, height: STATUS_HEIGHT },
    input: { x: 0, y: bodyHeight + STATUS_HEIGHT, width: cols, height: inputHeight },
  }
  if (showSidebar) {
    layout.sidebar = { x: transcriptWidth, y: 0, width: sidebarWidth, height: bodyHeight }
  }
  return layout
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}
