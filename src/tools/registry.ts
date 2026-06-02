import type { ToolCall } from "../core/messages"
import type { Runtime } from "../runtime/types"
import type { WorkspaceFs } from "../workspace/WorkspaceFs"
import type { ToolContext } from "./ToolRuntime"
import type { JsonSchema, OpenAiToolSchema } from "./schemas"
import type { ToolObservation } from "./result"

export type ToolAccesses = {
  reads?: string[]
  writes?: string[]
  searches?: string[]
}

export type ToolExecutionContext = ToolContext & {
  workspace: WorkspaceFs
  runtime?: Runtime
}

export type ToolDefinition<Input = unknown> = {
  name: string
  description: string
  inputSchema: JsonSchema
  readOnly: boolean
  /**
   * Whether this tool is safe to run concurrently inside a read-only batch.
   * Defaults to true. Set false for tools that are read-only for permission
   * purposes (no workspace writes, allowed in read-only mode) but mutate shared
   * session state and must therefore serialize, e.g. `todo`.
   */
  concurrencySafe?: boolean
  parse(input: unknown, call: ToolCall): Input
  accesses?(input: Input): ToolAccesses
  execute(input: Input, ctx: ToolExecutionContext): Promise<ToolObservation>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly order: string[] = []

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    this.order.push(tool.name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return this.order.map((name) => {
      const tool = this.tools.get(name)
      if (!tool) throw new Error(`Tool registry lost ${name}`)
      return tool
    })
  }

  toOpenAiTools(): OpenAiToolSchema[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))
  }
}
