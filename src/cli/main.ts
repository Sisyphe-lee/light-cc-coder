#!/usr/bin/env bun
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseCliArgs, usage } from "./args"
import { renderConfigReport, resolveConfig } from "./config"
import { renderDryRun, runDoctor } from "./doctor"
import { ApprovalPrompt } from "./approvalPrompt"
import { EventRenderer } from "./eventRenderer"
import { createProvider, createSession, type CreatedSession } from "./sessionFactory"
import { runRepl } from "./repl"
import { SessionMetadataUpdater, SessionStore } from "./sessionStore"

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseCliArgs(argv, { stdinIsTty: process.stdin.isTTY })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  let config
  try {
    config = await resolveConfig(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  const store = new SessionStore(config.dataRoot.value)

  if (args.mode === "help") {
    process.stdout.write(usage())
    process.stdout.write("\n")
    return 0
  }

  if (args.mode === "doctor") {
    const result = await runDoctor(config, store)
    process.stdout.write(result.output)
    if (!result.output.endsWith("\n")) process.stdout.write("\n")
    return result.exitCode
  }

  if (args.mode === "dry-run") {
    process.stdout.write(renderDryRun(config, store, args.prompt))
    process.stdout.write("\n")
    return 0
  }

  if (args.mode === "resume") {
    try {
      const resume = await store.resolveResume(args.resume ?? { last: true }, config.cwd.value)
      const created = await createSession({ config, store, resume })
      await runInteractive(created, config, store)
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  if (args.mode === "repl") {
    try {
      const created = await createSession({ config, store })
      await runInteractive(created, config, store)
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  if (!args.prompt) {
    console.error(usage())
    return 2
  }
  return runOneShot(args.prompt, config, store)
}

async function runOneShot(prompt: string, config: Awaited<ReturnType<typeof resolveConfig>>, store: SessionStore): Promise<number> {
  let created: CreatedSession
  try {
    // Validate provider configuration before creating a default session transcript.
    createProvider(config)
    created = await createSession({ config, store })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const updater = new SessionMetadataUpdater(store, created.plan)
  const renderer = new EventRenderer({
    verbose: config.verbose.value,
    approvalPrompt: new ApprovalPrompt(),
    onEvent: (event) => updater.handle(event),
  })
  const consume = renderer.consume(created.session)
  try {
    await created.session.submit({ type: "user_message", content: prompt })
    await created.session.close()
    await consume
    return 0
  } catch (error) {
    await created.session.close().catch(() => undefined)
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function runInteractive(
  initial: CreatedSession,
  config: Awaited<ReturnType<typeof resolveConfig>>,
  store: SessionStore,
): Promise<void> {
  await runRepl({
    initial,
    makeRenderer: (created, onHostAction, approvalPrompt) => {
      const updater = new SessionMetadataUpdater(store, created.plan)
      return new EventRenderer({
        verbose: config.verbose.value,
        showTurnStatus: true,
        approvalPrompt,
        onEvent: (event) => updater.handle(event),
        onHostAction,
      })
    },
    createFresh: () => createSession({ config, store }),
    resume: async (target) => {
      const resume = await store.resolveResume(target === "last" ? { last: true } : { id: target }, config.cwd.value)
      return createSession({ config, store, resume })
    },
  })
}

function isMainModule(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean }
  if (typeof meta.main === "boolean") return meta.main
  const entry = process.argv[1]
  if (!entry) return false
  const modulePath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(modulePath) === realpathSync(entry)
  } catch {
    return modulePath === resolve(entry)
  }
}

if (isMainModule()) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
