import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

export type JsonRecord = Record<string, unknown>

export type JsonReadResult =
  | { ok: true; path: string; value: unknown }
  | { ok: false; path: string; error: string }

export async function readJsonFile(path: string): Promise<JsonReadResult> {
  if (!existsSync(path)) return { ok: false, path, error: "missing" }
  try {
    return { ok: true, path, value: JSON.parse(await readFile(path, "utf8")) as unknown }
  } catch (error) {
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readJsonlFile(path: string): Promise<JsonRecord[]> {
  if (!existsSync(path)) return []
  const text = await readFile(path, "utf8")
  const rows: JsonRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      if (record) rows.push(record)
    } catch {
      continue
    }
  }
  return rows
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) ? (value as JsonRecord) : undefined
}

export function recordValue(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return asRecord(record?.[key])
}

export function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => Boolean(item)) : []
}

export function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function stringValue(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

export function numberValue(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function booleanValue(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === "boolean" ? value : undefined
}

export function nullableString(record: JsonRecord | undefined, key: string): string | null {
  return stringValue(record, key) ?? null
}

export function nullableNumber(record: JsonRecord | undefined, key: string): number | null {
  return numberValue(record, key) ?? null
}

export function nullableBoolean(record: JsonRecord | undefined, key: string): boolean | null {
  return booleanValue(record, key) ?? null
}

export function sumNullable(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return numbers.length === 0 ? null : round(numbers.reduce((total, value) => total + value, 0))
}

export function avgNullable(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return numbers.length === 0 ? null : round(numbers.reduce((total, value) => total + value, 0) / numbers.length)
}

export function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (typeof numerator !== "number" || typeof denominator !== "number" || denominator <= 0) return null
  return round(numerator / denominator)
}

export function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return round((numerator / denominator) * 100)
}

export function percentile(values: Array<number | null | undefined>, quantile: number): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b)
  if (numbers.length === 0) return null
  if (numbers.length === 1) return round(numbers[0])
  const index = (numbers.length - 1) * quantile
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return round(numbers[lower])
  const weight = index - lower
  return round(numbers[lower] * (1 - weight) + numbers[upper] * weight)
}

export function maxNullable(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return numbers.length === 0 ? null : Math.max(...numbers)
}

export function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort()
}

export function firstString(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null
}

export function normalizePathKey(path: string): string {
  return path.replaceAll("\\", "/")
}
