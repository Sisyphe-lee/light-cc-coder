import { applyPatchTool } from "./applyPatch"
import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readTool } from "./read"
import { createTodoTool, TodoState } from "./todo"
import { writeTool } from "./write"
import { ToolRegistry } from "../registry"

export type BuiltinToolRegistryOptions = {
  todoState?: TodoState
}

export function createBuiltinToolRegistry(options: BuiltinToolRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(applyPatchTool)
  registry.register(bashTool)
  registry.register(createTodoTool(options.todoState ?? new TodoState()))
  return registry
}

export { TodoState, createTodoTool }
export type { TodoItem, TodoInput, TodoStatus } from "./todo"
