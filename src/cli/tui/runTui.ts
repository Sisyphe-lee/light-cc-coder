import type { SessionEvent } from "../../core/events"
import { SLASH_COMMANDS } from "../../extensions/commands"
import type { CreatedSession } from "../sessionFactory"
import { applyKey, initialInputState, type InputState } from "./inputEditor"
import { decodeKeys, PASTE_END, PASTE_START, type Key } from "./keys"
import { computeLayout } from "./layout"
import { frameToAnsi, renderFrame, totalTranscriptLines, type Activity, type Suggestions } from "./render"
import { makeStyles } from "./style"
import { createTerminal } from "./term"
import { initialViewModel, reduceViewModel, type TranscriptItem, type TuiViewModel } from "./viewModel"

// Orchestrator for the full-screen TUI. It runs two cooperating loops on the
// single Node event loop: an async consumer over session.events() that folds the
// stream into a view model, and a synchronous key handler over raw stdin. Paints
// are coalesced on a short timer to avoid flicker during streaming. The core
// session/engine/tool layers are untouched — this is purely another events()
// consumer plus an input source, mirroring runRepl.

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type CommandOutputEvent = Extract<SessionEvent, { type: "command.output" }>

export type TuiOptions = {
  initial: CreatedSession
  model: string
  permissionMode: string
  maxContextTokens?: number
  compactAtTokens?: number
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
  let vm = freshViewModel(options.initial)
  let editor: InputState = initialInputState()
  let scrollOffset = 0
  let busy = false
  let closed = false
  let switching = false
  let quitArmed = false
  let mouseCaptured = true
  let helpVisible = false
  let suggestIndex = 0
  let queuedInputs: string[] = []
  let keyCarry = "" // holds an unterminated bracketed-paste tail across stdin chunks
  let localSeq = 0
  let pendingHostAction: CommandOutputEvent | undefined
  let consume: Promise<void> = Promise.resolve()
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  let activityTimer: ReturnType<typeof setInterval> | undefined
  let spinnerIndex = 0
  let turnStartMs: number | undefined
  let toolStartMs: number | undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => (resolveDone = resolve))

  function freshViewModel(created: CreatedSession): TuiViewModel {
    const home = process.env.HOME
    const cwd = created.plan.metadata.cwd
    return initialViewModel({
      model: created.plan.metadata.model || options.model,
      permissionMode: options.permissionMode,
      maxContextTokens: options.maxContextTokens,
      compactAtTokens: options.compactAtTokens,
      sessionId: created.plan.id,
      cwd: home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
    })
  }

  const pushNotice = (level: "info" | "warn" | "error", text: string): void => {
    const item: TranscriptItem = { kind: "notice", key: `local-${(localSeq += 1)}`, level, text }
    vm = { ...vm, items: [...vm.items, item] }
  }

  const layoutNow = () => {
    const size = terminal.size()
    // The input region grows with the multi-line buffer, capped so the
    // transcript keeps most of the screen.
    const inputHeight = Math.min(6, editor.buffer.split("\n").length)
    return computeLayout({ rows: size.rows, cols: size.cols, showSidebar: true, inputHeight })
  }

  // Completion popup state, derived from the buffer: active while the user is
  // typing the first word of a slash command.
  const currentSuggestions = (): Suggestions | undefined => {
    if (vm.pendingApproval || helpVisible) return undefined
    const buffer = editor.buffer
    if (!buffer.startsWith("/") || /\s/.test(buffer)) return undefined
    const prefix = buffer.slice(1).toLowerCase()
    const items = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix))
    if (items.length === 0) return undefined
    return { items, index: Math.min(suggestIndex, items.length - 1) }
  }

  const pageStep = (): number => Math.max(1, layoutNow().transcript.height - 1)

  const currentActivity = (): Activity => ({
    spinner: SPINNER[spinnerIndex % SPINNER.length],
    turnElapsedMs: turnStartMs != null ? Date.now() - turnStartMs : undefined,
    toolElapsedMs: toolStartMs != null ? Date.now() - toolStartMs : undefined,
    nowMs: Date.now(),
  })

  const paint = (): void => {
    if (closed) return
    const layout = layoutNow()
    const activity = currentActivity()
    const panelHeight = vm.pendingApproval ? Math.min(6, Math.max(0, layout.transcript.height - 1)) : 0
    const transcriptHeight = Math.max(1, layout.transcript.height - panelHeight)
    const maxScroll = Math.max(0, totalTranscriptLines(vm, layout.transcript.width, styles, activity, queuedInputs) - transcriptHeight)
    if (scrollOffset > maxScroll) scrollOffset = maxScroll
    if (scrollOffset < 0) scrollOffset = 0
    const frame = renderFrame({
      vm,
      layout,
      editor,
      scrollOffset,
      styles,
      activity,
      copyMode: !mouseCaptured,
      queued: queuedInputs,
      suggestions: currentSuggestions(),
      helpVisible,
    })
    terminal.write(frameToAnsi(frame, !vm.pendingApproval))
  }

  const scheduleRender = (): void => {
    if (renderTimer || closed) return
    renderTimer = setTimeout(() => {
      renderTimer = undefined
      paint()
    }, 16)
    renderTimer.unref?.()
  }

  // Animate the spinner and tick elapsed time only while a turn is in flight, so
  // an idle session does no periodic work.
  const ensureActivityTimer = (): void => {
    const busy = vm.turnState === "thinking" || vm.turnState === "running"
    if (busy && !activityTimer && !closed) {
      activityTimer = setInterval(() => {
        spinnerIndex += 1
        paint()
      }, 120)
      activityTimer.unref?.()
    } else if ((!busy || closed) && activityTimer) {
      clearInterval(activityTimer)
      activityTimer = undefined
    }
  }

  const quit = (): void => {
    if (closed) return
    closed = true
    if (activityTimer) {
      clearInterval(activityTimer)
      activityTimer = undefined
    }
    resolveDone()
  }

  const startConsumer = (session: CreatedSession): void => {
    const onEvent = options.makeOnEvent?.(session)
    consume = (async () => {
      for await (const event of session.session.events()) {
        await onEvent?.(event)
        if (event.type === "command.output" && event.hostAction) pendingHostAction = event
        if (event.type === "turn.started") turnStartMs = Date.now()
        else if (event.type === "turn.ended") {
          turnStartMs = undefined
          toolStartMs = undefined
        }
        if (event.type === "tool.call") toolStartMs = Date.now()
        else if (event.type === "tool.result") toolStartMs = undefined
        vm = reduceViewModel(vm, event)
        ensureActivityTimer()
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
    vm = freshViewModel(next)
    editor = initialInputState(editor.history)
    scrollOffset = 0
    queuedInputs = []
    helpVisible = false
    suggestIndex = 0
    startConsumer(current)
    paint()
  }

  // While a turn is in flight, new input queues up and is dispatched in order as
  // turns complete. Aborting (Esc/Ctrl-C) also drops the queue.
  const submitLine = (value: string): void => {
    if (busy) {
      queuedInputs = [...queuedInputs, value]
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
        // Queued messages targeted the old conversation; switching drops them.
        await switchTo(await options.createFresh())
      } else if (action?.hostAction === "resume" && action.hostActionArgs && options.resume) {
        await switchTo(await options.resume(action.hostActionArgs))
      } else {
        scheduleRender()
        if (!closed && queuedInputs.length > 0) {
          const [next, ...rest] = queuedInputs
          queuedInputs = rest
          submitLine(next)
        }
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
      queuedInputs = []
      void current.session.submit({ type: "abort", reason: "approval aborted" }).catch(() => undefined)
      return
    }
    if (key.type === "ctrl" && key.value === "c") {
      queuedInputs = []
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
      queuedInputs = []
      void current.session.submit({ type: "abort", reason: "Ctrl-C" }).catch(() => undefined)
      quitArmed = false
      scheduleRender()
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

  const routeToEditor = (key: Key): void => {
    const result = applyKey(editor, key)
    switch (result.kind) {
      case "update":
        if (result.state.buffer !== editor.buffer) suggestIndex = 0
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

  // Ctrl-G toggles copy mode: release the mouse so the terminal's native
  // selection works for copy/paste, then re-capture it to restore wheel scroll.
  const toggleCopyMode = (): void => {
    mouseCaptured = !mouseCaptured
    terminal.setMouseCapture(mouseCaptured)
    paint()
  }

  const clearInput = (): void => {
    editor = { ...editor, buffer: "", cursor: 0, historyIndex: editor.history.length, draft: "" }
    suggestIndex = 0
  }

  const handleKey = (chunk: string): void => {
    // Reassemble bracketed paste payloads that span stdin chunks: hold an
    // unterminated tail until its closing marker arrives (with a size cap as a
    // backstop against a lost terminator).
    let data = keyCarry + chunk
    keyCarry = ""
    const pasteStart = data.lastIndexOf(PASTE_START)
    if (pasteStart !== -1 && data.indexOf(PASTE_END, pasteStart + PASTE_START.length) === -1 && data.length - pasteStart < 4_000_000) {
      keyCarry = data.slice(pasteStart)
      data = data.slice(0, pasteStart)
    }
    for (const key of decodeKeys(data)) {
      if (key.type === "mouse" || key.type === "unknown") continue
      if (key.type === "ctrl" && key.value === "g") {
        toggleCopyMode()
        continue
      }
      // Mouse wheel (SGR) scrolls the transcript one line at a time.
      if (key.type === "wheelUp") {
        scrollOffset += 1
        scheduleRender()
        continue
      }
      if (key.type === "wheelDown") {
        scrollOffset = Math.max(0, scrollOffset - 1)
        scheduleRender()
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
      if (helpVisible) {
        if (key.type === "ctrl" && key.value === "c") {
          handleInterrupt()
          continue
        }
        if (key.type === "escape" || key.type === "enter" || (key.type === "char" && (key.value === "?" || key.value === "q"))) {
          helpVisible = false
          paint()
        }
        continue
      }
      if (vm.pendingApproval) {
        handleApprovalKey(key)
        continue
      }
      if (key.type === "ctrl" && key.value === "l") {
        paint()
        continue
      }
      // Esc aborts an in-flight turn (dropping queued messages); otherwise it
      // clears the input line.
      if (key.type === "escape") {
        if (busy || vm.turnState === "thinking" || vm.turnState === "running") {
          queuedInputs = []
          void current.session.submit({ type: "abort", reason: "Esc" }).catch(() => undefined)
          scheduleRender()
        } else if (editor.buffer.length > 0) {
          clearInput()
          scheduleRender()
        }
        continue
      }
      if (key.type === "char" && key.value === "?" && editor.buffer.length === 0) {
        helpVisible = true
        paint()
        continue
      }
      // Completion popup keys: Tab completes, Up/Down select, Enter runs the
      // selected command. Anything else falls through to the editor.
      const suggestions = currentSuggestions()
      if (suggestions) {
        const selected = suggestions.items[suggestions.index]
        if (key.type === "tab") {
          const text = `/${selected.name} `
          editor = { ...editor, buffer: text, cursor: Array.from(text).length }
          suggestIndex = 0
          scheduleRender()
          continue
        }
        if (key.type === "up" || key.type === "down") {
          const len = suggestions.items.length
          suggestIndex = (suggestions.index + (key.type === "down" ? 1 : -1) + len) % len
          scheduleRender()
          continue
        }
        if (key.type === "enter") {
          const seeded: InputState = { ...editor, buffer: `/${selected.name}`, cursor: Array.from(`/${selected.name}`).length }
          const result = applyKey(seeded, { type: "enter" })
          if (result.kind === "submit") {
            editor = result.state
            suggestIndex = 0
            submitLine(result.value)
          }
          scheduleRender()
          continue
        }
      }
      // Arrows move across lines then recall history; chars/backspace/enter
      // edit and submit.
      routeToEditor(key)
    }
  }

  terminal.onKey(handleKey)
  terminal.onResize(() => {
    // Wipe the old grid so a smaller/taller terminal does not leave stale cells.
    terminal.clear()
    paint()
  })
  terminal.enter()
  startConsumer(current)
  paint()

  try {
    await done
  } finally {
    if (renderTimer) clearTimeout(renderTimer)
    if (activityTimer) clearInterval(activityTimer)
    switching = true
    terminal.leave()
    await current.session.close().catch(() => undefined)
    await consume.catch(() => undefined)
  }
}
