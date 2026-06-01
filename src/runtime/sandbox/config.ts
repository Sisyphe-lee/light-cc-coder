import { createHash } from "node:crypto"
import { resolve } from "node:path"

export type OsSandboxMode = "off" | "auto" | "required"

export type OsSandboxConfig = {
  mode: OsSandboxMode
  settingsPath?: string
  allowDomains: string[]
  allowWrites: string[]
}

export function normalizeOsSandboxConfig(input: {
  mode?: OsSandboxMode
  settingsPath?: string
  allowDomains?: string[]
  allowWrites?: string[]
} = {}): OsSandboxConfig {
  return {
    mode: input.mode ?? "auto",
    settingsPath: input.settingsPath ? resolve(input.settingsPath) : undefined,
    allowDomains: uniqueStrings(input.allowDomains ?? []),
    allowWrites: uniqueStrings(input.allowWrites ?? []).map((path) => resolve(path)),
  }
}

export function parseOsSandboxMode(value: string): OsSandboxMode {
  if (value === "off" || value === "auto" || value === "required") return value
  throw new Error(`Invalid OS sandbox mode: ${value}`)
}

export function sandboxConfigHash(config: OsSandboxConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: config.mode,
        settingsPath: config.settingsPath,
        allowDomains: config.allowDomains,
        allowWrites: config.allowWrites,
      }),
    )
    .digest("hex")
    .slice(0, 16)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort()
}
