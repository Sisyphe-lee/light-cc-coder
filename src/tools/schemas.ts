export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: unknown[]
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
}

export type OpenAiToolSchema = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}
