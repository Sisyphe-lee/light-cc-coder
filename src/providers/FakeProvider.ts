import { AbortTurnError, throwIfAborted } from "../core/errors"
import type { AssistantMessage } from "../core/messages"
import type { ModelEvent, Provider, ProviderRequest } from "./types"

export type FakeProviderStep = {
  message?: AssistantMessage
  deltas?: string[]
  error?: string
  waitBeforeDeltas?: Promise<unknown>
  waitBeforeMessage?: Promise<unknown>
}

export type FakeProviderOptions = {
  steps: FakeProviderStep[]
  onRequest?: (request: ProviderRequest, index: number) => void | Promise<void>
}

export class FakeProvider implements Provider {
  readonly requests: ProviderRequest[] = []
  private readonly steps: FakeProviderStep[]
  private readonly onRequest?: (request: ProviderRequest, index: number) => void | Promise<void>

  constructor(options: FakeProviderOptions) {
    this.steps = options.steps
    this.onRequest = options.onRequest
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.length
    this.requests.push(request)
    await this.onRequest?.(request, index)
    const step = this.steps[index]
    if (!step) {
      throw new Error(`FakeProvider has no step ${index}`)
    }

    await waitFor(step.waitBeforeDeltas, signal)
    for (const text of step.deltas ?? []) {
      throwIfAborted(signal)
      yield { type: "text_delta", text }
    }

    await waitFor(step.waitBeforeMessage, signal)
    throwIfAborted(signal)

    if (step.error) {
      yield { type: "error", error: step.error }
      return
    }

    if (!step.message) {
      throw new Error(`FakeProvider step ${index} has no assistant message`)
    }
    yield { type: "assistant_message", message: step.message }
  }
}

async function waitFor(promise: Promise<unknown> | undefined, signal: AbortSignal): Promise<void> {
  if (!promise) return
  throwIfAborted(signal)
  await Promise.race([
    promise.then(() => undefined),
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new AbortTurnError(String(signal.reason ?? "aborted"))),
        { once: true },
      )
    }),
  ])
  throwIfAborted(signal)
}
