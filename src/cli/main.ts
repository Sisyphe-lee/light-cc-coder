#!/usr/bin/env bun
import { realpathSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseCliArgs, usage } from "./args"
import { resolveConfig } from "./config"
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

  if (args.mode === "help") {
    process.stdout.write(usage())
    process.stdout.write("\n")
    return 0
  }

  if (args.mode === "profile") {
    return runProfile(args.profileTranscript ?? "", { json: args.json, out: args.profileOut })
  }

  let config
  try {
    config = await resolveConfig(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  const store = new SessionStore(config.dataRoot.value)

  if (args.mode === "doctor") {
    const result = await runDoctor(config, store, { sandboxOnly: args.doctorSandbox, json: args.json })
    process.stdout.write(result.output)
    if (!result.output.endsWith("\n")) process.stdout.write("\n")
    return result.exitCode
  }

  if (args.mode === "sessions") {
    process.stdout.write(await store.renderSessions(config.cwd.value))
    process.stdout.write("\n")
    return 0
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
  return runOneShot(args.prompt, config, store, { json: args.json })
}

// Offline profile summary. Reads one JSONL transcript and never calls a provider,
// runs tools, mutates the transcript, or requires workspace write access. The
// reducer is loaded via dynamic import so normal runs do not depend on profiling/.
async function runProfile(transcriptPath: string, options: { json?: boolean; out?: string }): Promise<number> {
  const path = resolve(transcriptPath)
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    console.error(`Failed to read transcript ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const events: Record<string, unknown>[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // Tolerate malformed/partial lines; the reducer warns when no spans are found.
    }
  }
  const { summarizeProfile, renderText, renderJson } = await import("../../profiling/index")
  const report = summarizeProfile(events, { sourceTranscript: path, generatedAt: new Date().toISOString() })
  if (options.out) {
    await writeFile(resolve(options.out), `${renderJson(report)}\n`, "utf8")
    process.stdout.write(`Wrote profile report to ${resolve(options.out)}\n`)
    return 0
  }
  process.stdout.write(options.json ? renderJson(report) : renderText(report))
  process.stdout.write("\n")
  return 0
}

async function runOneShot(
  prompt: string,
  config: Awaited<ReturnType<typeof resolveConfig>>,
  store: SessionStore,
  options: { json?: boolean } = {},
): Promise<number> {
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
    json: options.json,
    permissionMode: config.permissionMode.value,
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
        permissionMode: config.permissionMode.value,
        showTurnStatus: true,
        showActivityIndicator: true,
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
