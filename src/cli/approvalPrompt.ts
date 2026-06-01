import { createInterface } from "node:readline/promises"
import type { SessionEvent } from "../core/events"

export type ApprovalDecision = "allow" | "deny" | "aborted"
export type ApprovalQuestion = (prompt: string) => Promise<string | undefined>

export class ApprovalPrompt {
  private active = false

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stderr,
    private readonly question?: ApprovalQuestion,
  ) {}

  isActive(): boolean {
    return this.active
  }

  async ask(event: Extract<SessionEvent, { type: "approval.requested" }>, cwd: string): Promise<ApprovalDecision> {
    this.active = true
    try {
      this.output.write(`approval.requested ${event.toolName}\n`)
      this.output.write(`Cwd: ${event.cwd ?? cwd}\n`)
      this.output.write(`Permission mode: ${event.permissionMode ?? "unknown"}\n`)
      this.output.write(`Subject: ${event.subject}\n`)
      this.output.write(`Policy: ${event.policyReason ?? event.reason}\n`)
      if (event.toolDescription) this.output.write(`Tool: ${event.toolDescription}\n`)
      if (event.toolReason) this.output.write(`Tool reason: ${event.toolReason}\n`)
      if (event.inputSummary) this.output.write(`Input: ${event.inputSummary}\n`)
      if (event.accessSummary) this.output.write(`Access: ${event.accessSummary}\n`)
      if (event.riskSummary) this.output.write(`Risk: ${event.riskSummary}\n`)
      const answer = await this.readAnswer()
      if (answer === undefined) return "aborted"
      return /^(y|yes|allow)$/i.test(answer.trim()) ? "allow" : "deny"
    } finally {
      this.active = false
    }
  }

  private async readAnswer(): Promise<string | undefined> {
    if (this.question) {
      return await this.question("Allow this tool call? [y/N] ")
    }
    if (!(this.input as NodeJS.ReadStream).isTTY) {
      this.output.write("Allow this tool call? [y/N] ")
      return readPipedLine(this.input, 100)
    }
    const rl = createInterface({ input: this.input, output: this.output })
    try {
      return await rl.question("Allow this tool call? [y/N] ")
    } finally {
      rl.close()
    }
  }
}

function readPipedLine(input: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      input.off("data", onData)
      input.off("end", finish)
      input.pause()
      resolve(text.split(/\r?\n/)[0] ?? "")
    }
    const onData = (chunk: Buffer | string) => {
      text += String(chunk)
      if (/\r?\n/.test(text)) finish()
    }
    input.setEncoding("utf8")
    input.on("data", onData)
    input.once("end", finish)
    input.resume()
    timer = setTimeout(finish, timeoutMs)
  })
}
