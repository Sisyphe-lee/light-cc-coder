import type { SessionEvent } from "../../core/events"
import type { CreatedSession } from "../sessionFactory"
import { applyKey, initialInputState, type InputState } from "./inputEditor"
import { decodeKeys, type Key } from "./keys"
import { computeLayout } from "./layout"
import { renderFrame, totalTranscriptLines } from "./render"
import { makeStyles } from "./style"
import { createTerminal } from "./term"
import { initialViewModel, reduceViewModel, type TranscriptItem, type TuiViewModel } from "./viewModel"

// Orchestrator for the full-screen TUI. It runs two cooperating loops on the
// single Node event loop: an async consumer over session.events() that folds the
// stream into a view model, and a synchronous key handler over raw stdin. Paints
// are coalesced on a short timer to avoid flicker during streaming. The core
// session/engine/tool layers are untouched — this is purely another events()
// consumer plus an input source, mirroring runRepl.

const CSI = "\x1b["

type CommandOutputEvent = Extract<SessionEvent, { type: "command.output" }>

export type TuiOptions = {
  initial: CreatedSession
  model: string
  permissionMode: string
  maxContextTokens?: number
  // Built per session so transcript metadata updates target the right plan across
  // /clear and /resume switches (mirrors runRepl's makeRenderer).
  makeOnEvent?: (created: CreatedSession) => ((event: SessionEvent) => Promise<void> | void) | undefined
  createFresh?: () => Promise<CreatedSession>
  resume?: (target: string) => Promise<CreatedSession>
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  color?: boolean
}

export async function runTui(options: TuiOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const terminal = createTerminal(input, output)
  const colorEnabled = options.color ?? (Boolean(output.isTTY) && !process.env.NO_COLOR)
  const styles = makeStyles(colorEnabled)

  let current = options.initial
  let vm = freshViewModel()
  let editor: InputState = initialInputState()
  let scrollOffset = 0
  let busy = false
  let closed = false
  let switching = false
  let quitArmed = false
  let localSeq = 0
  let pendingHostAction: CommandOutputEvent | undefined
  let consume: Promise<void> = Promise.resolve()
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => (resolveDone = resolve))

  function freshViewModel(): TuiViewModel {
    return initialViewModel({ model: options.model, permissionMode: options.permissionMode, maxContextTokens: options.maxContextTokens })
  }

  const pushNotice = (level: "info" | "warn" | "error", text: string): void => {
    const item: TranscriptItem = { kind: "notice", key: `local-${(localSeq += 1)}`, level, text }
    vm = { ...vm, items: [...vm.items, item] }
  }

  const layoutNow = () => {
    const size = terminal.size()
    return computeLayout({ rows: size.rows, cols: size.cols, showSidebar: true, inputHeight: 1 })
  }

  const pageStep = (): number => Math.max(1, layoutNow().transcript.height - 1)

  const paint = (): void => {
    if (closed) return
    const layout = layoutNow()
    const panelHeight = vm.pendingApproval ? Math.min(6, Math.max(0, layout.transcript.height - 1)) : 0
    const transcriptHeight = Math.max(1, layout.transcript.height - panelHeight)
    const maxScroll = Math.max(0, totalTranscriptLines(vm, layout.transcript.width, styles) - transcriptHeight)
    if (scrollOffset > maxScroll) scrollOffset = maxScroll
    if (scrollOffset < 0) scrollOffset = 0
    const frame = renderFrame({ vm, layout, editor, scrollOffset, styles })
    let out = frame.output
    if (frame.cursor && !vm.pendingApproval) {
      out += `${CSI}${frame.cursor.row + 1};${frame.cursor.col + 1}H${CSI}?25h`
    } else {
      out += `${CSI}?25l`
    }
    terminal.write(out)
  }

  const scheduleRender = (): void => {
    if (renderTimer || closed) return
    renderTimer = setTimeout(() => {
      renderTimer = undefined
      paint()
    }, 16)
    renderTimer.unref?.()
  }

  const quit = (): void => {
    if (closed) return
    closed = true
    resolveDone()
  }

  const startConsumer = (session: CreatedSession): void => {
    const onEvent = options.makeOnEvent?.(session)
    consume = (async () => {
      for await (const event of session.session.events()) {
        await onEvent?.(event)
        if (event.type === "command.output" && event.hostAction) pendingHostAction = event
        vm = reduceViewModel(vm, event)
        scheduleRender()
      }
    })().then(() => {
      if (!closed && !switching) quit()
    })
  }

  const switchTo = async (next: CreatedSession): Promise<void> => {
    switching = true
    await current.session.close().catch(() => undefined)
    await consume.catch(() => undefined)
    switching = false
    current = next
    vm = freshViewModel()
    editor = initialInputState(editor.history)
    scrollOffset = 0
    startConsumer(current)
    paint()
  }

  const submitLine = (value: string): void => {
    if (busy) {
      pushNotice("warn", "Busy — wait for the current turn to finish.")
      scheduleRender()
      return
    }
    busy = true
    quitArmed = false
    scrollOffset = 0
    pendingHostAction = undefined
    void (async () => {
      try {
        await current.session.submit({ type: "user_message", content: value })
      } catch (error) {
        pushNotice("error", error instanceof Error ? error.message : String(error))
      } finally {
        busy = false
      }
      const action = pendingHostAction as CommandOutputEvent | undefined
      pendingHostAction = undefined
      if (action?.hostAction === "quit") {
        quit()
      } else if (action?.hostAction === "clear" && options.createFresh) {
        await switchTo(await options.createFresh())
      } else if (action?.hostAction === "resume" && action.hostActionArgs && options.resume) {
        await switchTo(await options.resume(action.hostActionArgs))
      } else {
        scheduleRender()
      }
    })()
  }

  const respondApproval = (decision: "allow" | "deny"): void => {
    const approval = vm.pendingApproval
    if (!approval) return
    void current.session.submit({ type: "approval.respond", approvalId: approval.approvalId, decision }).catch(() => undefined)
  }

  const handleApprovalKey = (key: Key): void => {
    if (key.type === "escape") {
      void current.session.submit({ type: "abort", reason: "approval aborted" }).catch(() => undefined)
      return
    }
    if (key.type === "ctrl" && key.value === "c") {
      void current.session.submit({ type: "abort", reason: "Ctrl-C" }).catch(() => undefined)
      return
    }
    if (key.type !== "char") return
    const c = key.value.toLowerCase()
    if (c === "a" || c === "y") respondApproval("allow")
    else if (c === "d" || c === "n") respondApproval("deny")
  }

  const handleInterrupt = (): void => {
    if (busy || vm.pendingApproval) {
      void current.session.submit({ type: "abort", reason: "Ctrl-C" }).catch(() => undefined)
      quitArmed = false
      return
    }
    if (!quitArmed) {
      quitArmed = true
      pushNotice("info", "Press Ctrl-C again to exit.")
      scheduleRender()
      return
    }
    quit()
  }

  const handleKey = (chunk: string): void => {
    for (const key of decodeKeys(chunk)) {
      if (vm.pendingApproval) {
        handleApprovalKey(key)
        continue
      }
      if (key.type === "pageUp") {
        scrollOffset += pageStep()
        scheduleRender()
        continue
      }
      if (key.type === "pageDown") {
        scrollOffset = Math.max(0, scrollOffset - pageStep())
        scheduleRender()
        continue
      }
      if (key.type === "ctrl" && key.value === "l") {
        paint()
        continue
      }
      const result = applyKey(editor, key)
      switch (result.kind) {
        case "update":
          editor = result.state
          quitArmed = false
          scheduleRender()
          break
        case "submit":
          editor = result.state
          submitLine(result.value)
          scheduleRender()
          break
        case "interrupt":
          handleInterrupt()
          break
        case "eof":
          quit()
          break
        case "ignored":
          break
      }
    }
  }

  terminal.onKey(handleKey)
  terminal.onResize(() => scheduleRender())
  terminal.enter()
  startConsumer(current)
  paint()

  try {
    await done
  } finally {
    if (renderTimer) clearTimeout(renderTimer)
    switching = true
    terminal.leave()
    await current.session.close().catch(() => undefined)
    await consume.catch(() => undefined)
  }
}
