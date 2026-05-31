import type { AgentsMdContext } from "../context/agentsMd"
import type { ProviderMessage } from "../providers/types"
import { GLOBAL_SYSTEM_PROMPT, renderProjectInstructions, renderRuntimeFacts } from "./ContextAssembler"

export type ContextBuilderInput = {
  cwd: string
  agentsMd?: AgentsMdContext
}

export function buildContextPrefix(input: ContextBuilderInput): ProviderMessage[] {
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content: `${GLOBAL_SYSTEM_PROMPT}\n\n${renderRuntimeFacts({
        cwd: input.cwd,
        createdAt: "unavailable",
      })}`,
    },
  ]
  if (input.agentsMd && input.agentsMd.content.length > 0) {
    messages.push({ role: "user", content: renderProjectInstructions(input.agentsMd) })
  }
  return messages
}
