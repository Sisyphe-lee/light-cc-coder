import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

export type SkillConfig = {
  directories?: string[]
  enabledSkills?: string[]
  maxSkillBytes?: number
  maxTotalBytes?: number
}

export type SkillSnapshot = {
  name: string
  description?: string
  path: string
  content: string
  bytes: number
  originalBytes: number
  truncated: boolean
  hash: string
}

export type SkillLoadDiagnostic = {
  name?: string
  path: string
  status: "loaded" | "activated" | "skipped" | "error"
  message?: string
}

export type LoadedSkills = {
  all: SkillSnapshot[]
  active: SkillSnapshot[]
  diagnostics: SkillLoadDiagnostic[]
}

export async function loadSkills(config: SkillConfig | undefined): Promise<LoadedSkills> {
  const directories = (config?.directories ?? []).map((item) => resolve(item))
  const maxSkillBytes = config?.maxSkillBytes ?? 32 * 1024
  const diagnostics: SkillLoadDiagnostic[] = []
  const all: SkillSnapshot[] = []
  for (const directory of directories) {
    const skillPath = join(directory, "SKILL.md")
    try {
      const raw = await readFile(skillPath, "utf8")
      const snapshot = snapshotSkill({ directory, path: skillPath, raw, maxSkillBytes })
      all.push(snapshot)
      diagnostics.push({ name: snapshot.name, path: skillPath, status: "loaded" })
    } catch (error) {
      diagnostics.push({
        path: skillPath,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const enabled = config?.enabledSkills ?? []
  const byName = new Map<string, SkillSnapshot>()
  for (const skill of all) {
    byName.set(skill.name, skill)
    byName.set(skill.name.toLowerCase(), skill)
    byName.set(basename(dirname(skill.path)), skill)
  }
  const byPath = new Map(all.map((skill) => [resolve(skill.path), skill]))
  const active =
    enabled.length > 0
      ? enabled
          .map((nameOrPath) => byName.get(nameOrPath) ?? byName.get(nameOrPath.toLowerCase()) ?? byPath.get(resolve(nameOrPath)))
          .filter((skill): skill is SkillSnapshot => Boolean(skill))
      : []

  if (enabled.length > 0) {
    for (const nameOrPath of enabled) {
      const found = byName.get(nameOrPath) ?? byName.get(nameOrPath.toLowerCase()) ?? byPath.get(resolve(nameOrPath))
      if (found) {
        diagnostics.push({ name: found.name, path: found.path, status: "activated" })
      } else {
        diagnostics.push({ name: nameOrPath, path: nameOrPath, status: "skipped", message: "Enabled skill not found" })
      }
    }
  }

  return { all, active: capTotal(active, config?.maxTotalBytes ?? 64 * 1024), diagnostics }
}

export function renderSkillsContext(skills: SkillSnapshot[]): string {
  if (skills.length === 0) return ""
  const lines = ["# Active Skills"]
  for (const skill of skills) {
    lines.push("", `## ${skill.name}`)
    if (skill.description) lines.push(skill.description, "")
    lines.push(skill.content)
    if (skill.truncated) lines.push("", `[truncated: SKILL.md capped at ${skill.bytes} bytes]`)
  }
  return lines.join("\n")
}

function snapshotSkill(input: { directory: string; path: string; raw: string; maxSkillBytes: number }): SkillSnapshot {
  const originalBytes = byteLength(input.raw)
  const content = capBytes(input.raw, input.maxSkillBytes)
  const name = extractName(content) ?? basename(input.directory)
  const description = extractDescription(content)
  return {
    name,
    description,
    path: input.path,
    content,
    bytes: byteLength(content),
    originalBytes,
    truncated: originalBytes > byteLength(content),
    hash: hashText(content),
  }
}

function extractName(content: string): string | undefined {
  const frontmatter = frontmatterValue(content, "name")
  if (frontmatter) return frontmatter
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading && heading.length > 0 ? heading : undefined
}

function extractDescription(content: string): string | undefined {
  return frontmatterValue(content, "description")
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined
  const end = content.indexOf("\n---", 3)
  if (end === -1) return undefined
  const frontmatter = content.slice(3, end)
  const pattern = new RegExp(`^${escapeRegex(key)}:\\s*(.+)$`, "m")
  const value = frontmatter.match(pattern)?.[1]?.trim()
  return value ? value.replace(/^["']|["']$/g, "") : undefined
}

function capTotal(skills: SkillSnapshot[], maxTotalBytes: number): SkillSnapshot[] {
  const ordered = skills.slice()
  const explicitOrder = skills.length > 0
  if (!explicitOrder) ordered.sort((left, right) => left.name.localeCompare(right.name))
  let remaining = maxTotalBytes
  const capped: SkillSnapshot[] = []
  for (const skill of ordered) {
    if (remaining <= 0) break
    if (skill.bytes <= remaining) {
      capped.push(skill)
      remaining -= skill.bytes
      continue
    }
    const content = capBytes(skill.content, remaining)
    capped.push({
      ...skill,
      content,
      bytes: byteLength(content),
      truncated: true,
      hash: hashText(content),
    })
    break
  }
  return capped
}

function capBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const encoder = new TextEncoder()
  const encoded = encoder.encode(text)
  if (encoded.byteLength <= maxBytes) return text
  const marker = `\n[truncated: capped at ${maxBytes} bytes]`
  const markerBytes = encoder.encode(marker).byteLength
  let output = ""
  let bytes = 0
  for (const char of text) {
    const charBytes = encoder.encode(char).byteLength
    if (bytes + charBytes + markerBytes > maxBytes) break
    output += char
    bytes += charBytes
  }
  return output + marker
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
