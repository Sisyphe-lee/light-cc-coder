export type SessionOp =
  | { type: "user_message"; content: string; id?: string }
  | { type: "compact.request"; id?: string; instruction?: string }
  | { type: "approval.respond"; approvalId: string; decision: "allow" | "deny" }
  | { type: "abort"; reason?: string }
