/**
 * Minimal JSON Schema → Zod converter for external MCP tools.
 *
 * The MCP SDK's client returns each remote tool's `inputSchema` as plain JSON
 * Schema, while everything inside Alice (ToolCenter, the AI SDK, our own MCP
 * re-export) expects Zod. Rather than declaring external tools with no
 * parameters, translate the subset MCP servers actually emit.
 *
 * Deliberately permissive: an unknown keyword is IGNORED, never thrown. A
 * vaguely-typed remote tool is still usable; a converter that throws would make
 * the whole server unregisterable.
 */

import { z } from 'zod'

/** JSON Schema node as emitted by an MCP server's tool list. */
type JsonSchemaNode = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  default?: unknown
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  additionalProperties?: boolean | JsonSchemaNode
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

function convertNode(node: JsonSchemaNode | undefined): z.ZodTypeAny {
  if (!node || typeof node !== 'object') return z.unknown()

  // Enumerations are the most common constrained form; check before `type`.
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.filter((v): v is string => typeof v === 'string')
    if (values.length === node.enum.length) {
      const base = values.length === 1 ? z.literal(values[0]!) : z.enum(values as [string, ...string[]])
      return withDescription(base, node.description)
    }
    return withDescription(z.unknown(), node.description)
  }

  // A union of alternatives: accept the first that parses.
  const alternatives = node.anyOf ?? node.oneOf
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    const members = alternatives.map((alt) => convertNode(alt))
    if (members.length === 1) return withDescription(members[0]!, node.description)
    const [first, ...rest] = members
    const union = rest.reduce<z.ZodTypeAny>((acc, next) => z.union([acc, next]), first!)
    return withDescription(union, node.description)
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type

  switch (type) {
    case 'string': {
      let s: z.ZodTypeAny = z.string()
      if (typeof node.minLength === 'number') s = (s as z.ZodString).min(node.minLength)
      if (typeof node.maxLength === 'number') s = (s as z.ZodString).max(node.maxLength)
      return withDescription(s, node.description)
    }
    case 'number': {
      let n: z.ZodTypeAny = z.number()
      if (typeof node.minimum === 'number') n = (n as z.ZodNumber).min(node.minimum)
      if (typeof node.maximum === 'number') n = (n as z.ZodNumber).max(node.maximum)
      return withDescription(n, node.description)
    }
    case 'integer': {
      let n: z.ZodTypeAny = z.number().int()
      if (typeof node.minimum === 'number') n = (n as z.ZodNumber).min(node.minimum)
      if (typeof node.maximum === 'number') n = (n as z.ZodNumber).max(node.maximum)
      return withDescription(n, node.description)
    }
    case 'boolean':
      return withDescription(z.boolean(), node.description)
    case 'array':
      return withDescription(z.array(convertNode(node.items)), node.description)
    case 'null':
      return withDescription(z.null(), node.description)
    case 'object':
      return withDescription(convertObject(node), node.description)
    default:
      // No `type` at all (some servers omit it): treat a properties-bearing
      // node as an object, otherwise accept anything.
      if (node.properties) return withDescription(convertObject(node), node.description)
      return withDescription(z.unknown(), node.description)
  }
}

function convertObject(node: JsonSchemaNode): z.ZodTypeAny {
  const properties = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, child] of Object.entries(properties)) {
    const converted = convertNode(child)
    shape[key] = required.has(key) ? converted : converted.optional()
  }
  // `.passthrough()` keeps forward-compatible extra fields from being stripped:
  // a remote server may read a field its listTools schema did not advertise.
  return z.object(shape).passthrough()
}

function withDescription(schema: z.ZodTypeAny, description: string | undefined): z.ZodTypeAny {
  if (!description) return schema
  try {
    return schema.describe(description)
  } catch {
    return schema
  }
}

/**
 * Convert an MCP tool's JSON Schema into a Zod object schema.
 *
 * Always returns an object schema, because every MCP tool takes an argument
 * object. A malformed or absent schema becomes an empty (passthrough) object so
 * the tool is still callable.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodObject<z.ZodRawShape> {
  if (!schema || typeof schema !== 'object') {
    return z.object({}).passthrough() as z.ZodObject<z.ZodRawShape>
  }
  const node = schema as JsonSchemaNode
  const converted = node.properties || node.type === 'object'
    ? convertObject(node)
    : z.object({}).passthrough()
  return converted as z.ZodObject<z.ZodRawShape>
}
