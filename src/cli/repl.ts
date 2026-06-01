import { createInterface, type Interface } from "node:readline"
import { ApprovalPrompt } from "./approvalPrompt"
import type { SessionEvent } from "../core/events"
import type { CreatedSession } from "./sessionFactory"
import type { EventRenderer } from "./eventRenderer"

type CommandOutputEvent = Extract<SessionEvent, { type: "command.output" }>

export type ReplOptions = {
  initial: CreatedSession
  makeRenderer: (
    created: CreatedSession,
    onHostAction: (event: CommandOutputEvent) => void,
    approvalPrompt: ApprovalPrompt,
  ) => EventRenderer
  createFresh?: () => Promise<CreatedSession>
  resume?: (target: string) => Promise<CreatedSession>
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  error?: NodeJS.WritableStream
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const error = options.error ?? process.stderr
  const inputIsTty = Boolean((input as NodeJS.ReadStream).isTTY)
  const lines: LineSource = inputIsTty
    ? new LineReader(createInterface({ input, output }), input, output)
    : new BufferedLineReader(await readAllLines(input))
  let current = options.initial
  let renderer!: EventRenderer
  let consume!: Promise<void>
  let exitRequested = false
  let activeSubmit = false
  let idleInterrupts = 0
  let pendingHostAction: CommandOutputEvent | undefined
  let hostActionWaiter: ((event: CommandOutputEvent) => void) | undefined

  const startConsumer = (created: CreatedSession) => {
    renderer = options.makeRenderer(
      created,
      (event) => {
        pendingHostAction = event
        hostActionWaiter?.(event)
        hostActionWaiter = undefined
        if (event.hostAction === "quit") exitRequested = true
      },
      createReplApprovalPrompt(input, error, (prompt) => lines.question(prompt)),
    )
    consume = renderer.consume(created.session)
  }

  startConsumer(current)
  printStartup(current, error)

  const onSigint = () => {
    if (activeSubmit || renderer.approvals.isActive()) {
      error.write("Aborting current turn...\n")
      lines.cancelPending()
      void current.session.submit({ type: "abort", reason: "Ctrl-C" }).catch(() => undefined)
      return
    }
    idleInterrupts += 1
    if (idleInterrupts === 1) {
      error.write("Press Ctrl-C again to exit.\n")
      return
    }
    exitRequested = true
    lines.close()
  }
  process.on("SIGINT", onSigint)

  try {
    while (!exitRequested) {
      const line = await lines.question("> ")
      if (line === undefined || exitRequested) break
      idleInterrupts = 0
      if (line.trim().length === 0) {
        continue
      }
      activeSubmit = true
      pendingHostAction = undefined
      const hostActionPromise = expectsHostAction(line)
        ? waitForHostAction((resolve) => {
            hostActionWaiter = resolve
          })
        : undefined
      try {
        await current.session.submit({ type: "user_message", content: line })
        if (hostActionPromise && !pendingHostAction) pendingHostAction = await hostActionPromise
      } catch (errorValue) {
        error.write(`${errorValue instanceof Error ? errorValue.message : String(errorValue)}\n`)
      } finally {
        activeSubmit = false
        hostActionWaiter = undefined
      }
      const action = pendingHostAction as CommandOutputEvent | undefined
      if (action?.hostAction === "clear" && options.createFresh) {
        current = await switchSession(current, consume!, await options.createFresh(), error)
        startConsumer(current)
        printStartup(current, error)
      } else if (action?.hostAction === "resume" && action.hostActionArgs && options.resume) {
        current = await switchSession(current, consume!, await options.resume(action.hostActionArgs), error)
        startConsumer(current)
        printStartup(current, error)
      }
    }
  } finally {
    process.off("SIGINT", onSigint)
    lines.close()
    await current.session.close().catch(() => undefined)
    await consume!.catch(() => undefined)
  }
}

export function createReplApprovalPrompt(
  input: NodeJS.ReadableStream,
  error: NodeJS.WritableStream,
  question: (prompt: string) => Promise<string | undefined>,
): ApprovalPrompt {
  return new ApprovalPrompt(input, error, question)
}

async function switchSession(
  current: CreatedSession,
  consume: Promise<void>,
  next: CreatedSession,
  error: NodeJS.WritableStream,
): Promise<CreatedSession> {
  error.write("Switching session...\n")
  await current.session.close().catch(() => undefined)
  await consume.catch(() => undefined)
  return next
}

function printStartup(created: CreatedSession, error: NodeJS.WritableStream): void {
  error.write(
    [
      `lightcc session ${created.plan.id}`,
      `cwd: ${created.session.cwd}`,
      `model: ${created.plan.metadata.model}`,
      `permission: ${created.plan.metadata.permissionMode}`,
      `transcript: ${created.plan.transcriptPath}`,
    ].join("\n") + "\n",
  )
}

class LineReader {
  private readonly queue: string[] = []
  private waiters: Array<(line: string | undefined) => void> = []
  private closed = false

  constructor(
    private readonly rl: Interface,
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.rl.on("line", (line) => this.push(line))
    this.rl.on("close", () => this.finish())
  }

  question(prompt: string): Promise<string | undefined> {
    if (this.closed) return Promise.resolve(undefined)
    if ((this.input as NodeJS.ReadStream).isTTY) this.output.write(prompt)
    const line = this.queue.shift()
    if (line !== undefined) return Promise.resolve(line)
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  close(): void {
    this.rl.close()
    this.finish()
  }

  cancelPending(): void {
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  private push(line: string): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(line)
      return
    }
    this.queue.push(line)
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}

type LineSource = {
  question(prompt: string): Promise<string | undefined>
  cancelPending(): void
  close(): void
}

class BufferedLineReader implements LineSource {
  private index = 0

  constructor(private readonly lines: string[]) {}

  question(_prompt: string): Promise<string | undefined> {
    if (this.index >= this.lines.length) return Promise.resolve(undefined)
    const line = this.lines[this.index]
    this.index += 1
    return Promise.resolve(line)
  }

  cancelPending(): void {}

  close(): void {}
}

function readAllLines(input: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let text = ""
    input.setEncoding("utf8")
    input.on("data", (chunk) => {
      text += String(chunk)
    })
    input.on("error", reject)
    input.on("end", () => resolve(text.split(/\r?\n/).filter((line, index, lines) => index < lines.length - 1 || line.length > 0)))
    input.resume()
  })
}

function expectsHostAction(line: string): boolean {
  return /^\/(?:clear|resume|quit|exit)(?:\s|$)/.test(line.trim())
}

function waitForHostAction(register: (resolve: (event: CommandOutputEvent) => void) => void): Promise<CommandOutputEvent | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 1_000)
    register((event) => {
      clearTimeout(timer)
      resolve(event)
    })
  })
}
