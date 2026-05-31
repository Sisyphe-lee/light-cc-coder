import { AbortTurnError, isAbortError, throwIfAborted } from "../core/errors"
import type { AssistantMessage } from "../core/messages"
import type { Provider, ProviderRequest } from "../providers/types"

export type ExecuteStepInput = {
  provider: Provider
  request: ProviderRequest
  signal: AbortSignal
  onDelta?: (text: string) => Promise<void>
}

export async function executeStep(input: ExecuteStepInput): Promise<AssistantMessage> {
  let assistant: AssistantMessage | undefined
  const iterator = input.provider.stream(input.request, input.signal)[Symbol.asyncIterator]()
  try {
    throwIfAborted(input.signal)
    while (true) {
      const next = await abortableNext(iterator, input.signal)
      if (next.done) break
      const event = next.value
      throwIfAborted(input.signal)
      if (event.type === "text_delta") {
        await input.onDelta?.(event.text)
        continue
      }
      if (event.type === "assistant_message") {
        assistant = event.message
        continue
      }
      throw new Error(event.error)
    }
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) {
      await iterator.return?.()
      throw new AbortTurnError(input.signal.aborted ? String(input.signal.reason ?? "aborted") : "aborted")
    }
    throw error
  }

  if (!assistant) {
    throw new Error("Provider stream ended without an assistant message")
  }
  return assistant
}

async function abortableNext<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  throwIfAborted(signal)
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new AbortTurnError(String(signal.reason ?? "aborted")))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    iterator.next().then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}
