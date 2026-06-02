import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { EVAL_RESULT_SCHEMA_VERSION, type UnifiedEvalResult } from "../../results/types"

type Options = {
  instruction: string
  workspace: string
  artifactDir: string
  transcriptPath: string
  patchPath: string
  resultPath: string
  shouldPass: boolean
}

async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv)
    await mkdir(options.artifactDir, { recursive: true })
    await mkdir(dirname(options.transcriptPath), { recursive: true })
    await mkdir(dirname(options.patchPath), { recursive: true })
    await mkdir(dirname(options.resultPath), { recursive: true })

    await writeFile(
      options.transcriptPath,
      `${JSON.stringify({
        type: "fake-coder.message",
        instruction: options.instruction,
        workspace: options.workspace,
      })}\n`,
      "utf8",
    )
    await writeFile(
      options.patchPath,
      [
        "diff --git a/FAKE_RESULT.txt b/FAKE_RESULT.txt",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/FAKE_RESULT.txt",
        "@@ -0,0 +1 @@",
        `+${options.instruction.replace(/\r?\n/g, " ")}`,
        "",
      ].join("\n"),
      "utf8",
    )

    const result: UnifiedEvalResult = {
      schemaVersion: EVAL_RESULT_SCHEMA_VERSION,
      runId: "fake-coder-conformance",
      createdAt: new Date().toISOString(),
      coder: { id: "fake-coder", displayName: "Fake Coder" },
      benchmark: "adapter-conformance",
      task: { id: "fake-task", attempt: 1 },
      status: options.shouldPass ? "passed" : "failed",
      passed: options.shouldPass,
      durationMs: 1,
      artifacts: {
        rootDir: options.artifactDir,
        transcriptPath: options.transcriptPath,
        patchPath: options.patchPath,
        rawResultPath: options.resultPath,
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      reproducibility: {
        adapterId: "fake-coder",
        adapterStatus: "draft",
        installKind: "none",
        attempts: 1,
      },
    }
    await writeFile(options.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
    return options.shouldPass ? 0 : 2
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { shouldPass: true }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--instruction") options.instruction = requireValue(argv, ++index, arg)
    else if (arg === "--workspace") options.workspace = requireValue(argv, ++index, arg)
    else if (arg === "--artifact-dir") options.artifactDir = requireValue(argv, ++index, arg)
    else if (arg === "--transcript") options.transcriptPath = requireValue(argv, ++index, arg)
    else if (arg === "--patch") options.patchPath = requireValue(argv, ++index, arg)
    else if (arg === "--result") options.resultPath = requireValue(argv, ++index, arg)
    else if (arg === "--fail") options.shouldPass = false
    else throw new Error(`Unknown argument: ${arg}`)
  }

  for (const key of ["instruction", "workspace", "artifactDir", "transcriptPath", "patchPath", "resultPath"] as const) {
    if (!options[key]) throw new Error(`Missing required fake-coder option: ${key}`)
  }
  return options as Options
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
