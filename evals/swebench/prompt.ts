import type { SweBenchInstance } from "./types"

export function buildSweBenchPrompt(instance: SweBenchInstance): string {
  return [
    "You are working on a SWE-bench issue in a local repository checkout.",
    "",
    "Goal:",
    "Fix the issue described below by editing the repository. Use the available tools to inspect files, make a minimal correct patch, and run focused verification when possible.",
    "",
    "Rules:",
    "- Do not look up the issue, pull request, gold patch, or tests on the internet.",
    "- Do not assume hidden evaluator tests are visible.",
    "- Do not modify tests just to satisfy the benchmark.",
    "- Keep the patch focused on the reported issue.",
    "- When you finish, leave the repository with the intended code changes in the working tree.",
    "",
    "Instance:",
    `- instance_id: ${instance.instance_id}`,
    `- repo: ${instance.repo}`,
    `- base_commit: ${instance.base_commit}`,
    "",
    "Problem statement:",
    instance.problem_statement.trim(),
    "",
  ].join("\n")
}
