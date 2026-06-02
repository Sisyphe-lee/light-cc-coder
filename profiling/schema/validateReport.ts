// Tiny, dependency-free validator for the subset of JSON Schema used by
// profile-report.schema.json: type (incl. ["x","null"]), const, integer,
// properties, required, items, and additionalProperties:false. It is enough to
// assert that a produced report conforms to the published contract without
// pulling a full JSON Schema engine into the repo.

type Schema = Record<string, unknown>

export function validateAgainstSchema(value: unknown, schema: Schema, path = "$"): string[] {
  const errors: string[] = []

  if ("const" in schema) {
    if (value !== schema.const) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
    return errors
  }

  const types = normalizeTypes(schema.type)
  if (types.length > 0 && !matchesType(value, types)) {
    errors.push(`${path}: expected type ${types.join("|")}, got ${describe(value)}`)
    return errors
  }

  if (types.includes("object") && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {}
    const required = (schema.required as string[] | undefined) ?? []
    for (const key of required) {
      if (!(key in record)) errors.push(`${path}.${key}: missing required property`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}.${key}: unexpected property`)
      }
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in record) errors.push(...validateAgainstSchema(record[key], propSchema, `${path}.${key}`))
    }
  }

  if (types.includes("array") && Array.isArray(value) && schema.items) {
    const itemSchema = schema.items as Schema
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, itemSchema, `${path}[${index}]`))
    })
  }

  return errors
}

function normalizeTypes(type: unknown): string[] {
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string")
  return []
}

function matchesType(value: unknown, types: string[]): boolean {
  return types.some((type) => matchesSingleType(value, type))
}

function matchesSingleType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "array":
      return Array.isArray(value)
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
    default:
      return false
  }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
