import type { SessionEvent } from "../../core/events"
import { ToolExecutionError } from "../result"
import type { ToolDefinition, ToolExecutionContext } from "../registry"
import { expectObject, expectString } from "./util"

export type TodoStatus = "pending" | "in_progress" | "completed"

export type TodoItem = {
  id: string
  content: string
  status: TodoStatus
}

export type TodoInput =
  | { action: "replace"; items: TodoItem[] }
  | { action: "list" }
  | { action: "clear" }

export class TodoState {
  private items: TodoItem[] = []

  replace(items: TodoItem[]): void {
    this.items = items.map((item) => ({ ...item }))
  }

  clear(): void {
    this.items = []
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }))
  }

  summary(maxItems = 20): string {
    if (this.items.length === 0) return ""
    const visible = this.items.slice(0, maxItems)
    const lines = ["# Session Todo"]
    for (const item of visible) {
      lines.push(`- [${statusMarker(item.status)}] ${item.id}: ${item.content}`)
    }
    if (this.items.length > visible.length) {
      lines.push(`[truncated: ${this.items.length - visible.length} additional todo items omitted]`)
    }
    return lines.join("\n")
  }
}

export function createTodoTool(state: TodoState): ToolDefinition<TodoInput> {
  return {
    name: "todo",
    description: "Manage a session-scoped todo list. It does not read or write workspace files.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["replace", "list", "clear"] },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["action"],
    },
    parse(input) {
      const object = expectObject(input, "todo")
      const action = expectString(object, "action")
      if (action === "list" || action === "clear") return { action }
      if (action !== "replace") {
        throw new ToolExecutionError("invalid_input", "action must be one of replace, list, clear")
      }
      const rawItems = object.items
      if (!Array.isArray(rawItems)) {
        throw new ToolExecutionError("invalid_input", "items must be an array for replace")
      }
      const ids = new Set<string>()
      const items = rawItems.map((item, index) => parseTodoItem(item, index, ids))
      return { action, items }
    },
    async execute(input, ctx) {
      if (input.action === "list") {
        return { content: renderTodoList(state.list()) }
      }
      if (input.action === "clear") {
        state.clear()
        await emitTodoUpdated(ctx, state)
        return { content: "Todo list cleared." }
      }
      state.replace(input.items)
      await emitTodoUpdated(ctx, state)
      return { content: `Todo list replaced with ${input.items.length} item${input.items.length === 1 ? "" : "s"}.` }
    },
    todoState: state,
  } as ToolDefinition<TodoInput> & { todoState: TodoState }
}

export function replayTodoState(events: SessionEvent[]): TodoState {
  const state = new TodoState()
  for (const event of events) {
    if (event.type !== "todo.updated") continue
    state.replace(event.items)
  }
  return state
}

function parseTodoItem(input: unknown, index: number, ids: Set<string>): TodoItem {
  const object = expectObject(input, `todo.items[${index}]`)
  const id = expectString(object, "id").trim()
  const content = expectString(object, "content").trim()
  const status = expectString(object, "status")
  if (!id) throw new ToolExecutionError("invalid_input", `items[${index}].id must be non-empty`)
  if (!content) throw new ToolExecutionError("invalid_input", `items[${index}].content must be non-empty`)
  if (ids.has(id)) throw new ToolExecutionError("invalid_input", `duplicate todo id: ${id}`)
  ids.add(id)
  if (status !== "pending" && status !== "in_progress" && status !== "completed") {
    throw new ToolExecutionError("invalid_input", `items[${index}].status is invalid`)
  }
  return { id, content, status }
}

function renderTodoList(items: TodoItem[]): string {
  if (items.length === 0) return "Todo list is empty."
  return items.map((item) => `${item.status}\t${item.id}\t${item.content}`).join("\n")
}

async function emitTodoUpdated(ctx: ToolExecutionContext, state: TodoState): Promise<void> {
  await ctx.emit?.({
    type: "todo.updated",
    turnId: ctx.turnId,
    stepId: ctx.stepId,
    toolCallId: ctx.toolCallId,
    items: state.list(),
  })
}

function statusMarker(status: TodoStatus): string {
  if (status === "completed") return "x"
  if (status === "in_progress") return ">"
  return " "
}
