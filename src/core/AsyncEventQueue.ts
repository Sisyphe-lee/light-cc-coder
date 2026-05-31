export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly resolvers: Array<() => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    this.values.push(value)
    this.flush()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.flush()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0
    return {
      next: () => {
        if (index < this.values.length) {
          const value = this.values[index]
          index += 1
          return Promise.resolve({ value, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true })
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(() => {
            if (index < this.values.length) {
              const value = this.values[index]
              index += 1
              resolve({ value, done: false })
              return
            }
            resolve({ value: undefined as T, done: true })
          })
        })
      },
    }
  }

  private flush(): void {
    const pending = this.resolvers.splice(0)
    for (const resolve of pending) resolve()
  }
}
