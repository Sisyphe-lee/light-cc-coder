export class AbortTurnError extends Error {
  constructor(message = "Turn aborted") {
    super(message)
    this.name = "AbortTurnError"
  }
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingError"
  }
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProjectionError"
  }
}

export class TranscriptWriteError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message)
    this.name = "TranscriptWriteError"
  }
}

export class ActiveTurnError extends Error {
  constructor(message = "A turn is already running") {
    super(message)
    this.name = "ActiveTurnError"
  }
}

export function abortReason(signal: AbortSignal): string {
  const reason = signal.reason
  if (typeof reason === "string") return reason
  if (reason instanceof Error) return reason.message
  return "aborted"
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortTurnError(abortReason(signal))
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof AbortTurnError || (error instanceof Error && error.name === "AbortError")
}
