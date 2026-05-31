import { LocalRuntime, type LocalRuntimeOptions } from "./LocalRuntime"

export class LocalDeployment {
  private runtime?: LocalRuntime

  async start(options: LocalRuntimeOptions): Promise<LocalRuntime> {
    this.runtime = await LocalRuntime.create(options)
    return this.runtime
  }

  async close(): Promise<void> {
    await this.runtime?.close?.()
    this.runtime = undefined
  }
}
