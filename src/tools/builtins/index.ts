import { applyPatchTool } from "./applyPatch"
import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readTool } from "./read"
import { writeTool } from "./write"
import { ToolRegistry } from "../registry"

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(applyPatchTool)
  registry.register(bashTool)
  return registry
}
