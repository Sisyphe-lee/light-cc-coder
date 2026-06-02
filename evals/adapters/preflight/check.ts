import { access } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"
import { buildCoderCommand, loadCoderAdapter } from "../coders/loader"
import type { CoderAdapter, CoderAdapterVariables, CoderEvalTarget } from "../coders/types"

export type AdapterPreflightStatus = "pass" | "warn" | "fail"

export type AdapterPreflightCheck = {
  name: string
  status: AdapterPreflightStatus
  detail: string
}

export type AdapterPreflightOptions = {
  adapter: string | CoderAdapter
  benchmark: CoderEvalTarget
  variables: CoderAdapterVariables
  env?: Record<string, string | undefined>
  checkExecutable?: boolean
}

export async function runAdapterPreflight(options: AdapterPreflightOptions): Promise<AdapterPreflightCheck[]> {
  const adapter = typeof options.adapter === "string" ? await loadCoderAdapter(options.adapter) : options.adapter
  const env = options.env ?? process.env
  const checks: AdapterPreflightCheck[] = []

  checks.push({
    name: "adapter.status",
    status: adapter.status === "ready" ? "pass" : "warn",
    detail: adapter.status,
  })
  checks.push({
    name: "adapter.target",
    status: adapter.targets.includes(options.benchmark) ? "pass" : "fail",
    detail: options.benchmark,
  })

  let rendered: ReturnType<typeof buildCoderCommand> | undefined
  try {
    rendered = buildCoderCommand(adapter, options.variables)
    checks.push({ name: "adapter.render", status: "pass", detail: rendered.executable })
  } catch (error) {
    checks.push({ name: "adapter.render", status: "fail", detail: stringifyError(error) })
  }

  if (rendered) {
    for (const name of rendered.requiredEnv) {
      checks.push({
        name: `env.${name}`,
        status: env[name] ? "pass" : "fail",
        detail: env[name] ? "set" : "missing",
      })
    }
    if (options.checkExecutable ?? false) {
      checks.push(await checkExecutable(rendered.executable, env.PATH))
    }
  }

  return checks
}

async function checkExecutable(executable: string, pathValue: string | undefined): Promise<AdapterPreflightCheck> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (pathValue ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, executable))

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { name: "command.executable", status: "pass", detail: candidate }
    } catch {
      // Keep searching.
    }
  }
  return { name: "command.executable", status: "fail", detail: executable }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
