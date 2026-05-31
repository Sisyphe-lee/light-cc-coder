import type { WorkspaceFs } from "../workspace/WorkspaceFs"
import type { ToolAccesses } from "../tools/registry"

export class SandboxPolicy {
  async checkFileAccesses(accesses: ToolAccesses | undefined, workspace: WorkspaceFs): Promise<void> {
    for (const path of accesses?.reads ?? []) {
      await workspace.resolveForRead(path)
    }
    for (const path of accesses?.writes ?? []) {
      await workspace.resolveForWrite(path)
    }
  }
}
