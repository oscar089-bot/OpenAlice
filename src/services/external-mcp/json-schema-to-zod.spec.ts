import { describe, expect, it } from 'vitest'

import { jsonSchemaToZod } from './json-schema-to-zod.js'

describe('jsonSchemaToZod', () => {
  it('accepts an empty or malformed schema, so a tool stays registerable', () => {
    for (const input of [undefined, null, 42, 'nope', {}]) {
      const schema = jsonSchemaToZod(input)
      expect(schema.safeParse({ anything: true }).success).toBe(true)
    }
  })

  it('marks fields required vs optional from `required`', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['symbol'],
    })

    expect(schema.safeParse({ symbol: 'EURUSD' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ symbol: 'EURUSD', limit: 'not-a-number' }).success).toBe(false)
  })

  it('converts enums, numbers, booleans, arrays and nested objects', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        mode: { enum: ['fast', 'slow'] },
        price: { type: 'number' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: ['mode', 'price', 'enabled', 'tags', 'nested'],
    })

    const ok = schema.safeParse({
      mode: 'fast',
      price: 1.5,
      enabled: true,
      tags: ['a'],
      nested: { id: 'x' },
    })
    expect(ok.success).toBe(true)

    // A value outside the enum is rejected.
    expect(schema.safeParse({
      mode: 'warp', price: 1, enabled: true, tags: [], nested: { id: 'x' },
    }).success).toBe(false)
  })

  it('keeps unknown extra properties instead of stripping them', () => {
    // A remote server may read a field its listTools schema did not advertise.
    const schema = jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } } })
    const parsed = schema.safeParse({ a: 'x', extra: 1 })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual({ a: 'x', extra: 1 })
  })

  it('treats a properties-bearing node with no `type` as an object', () => {
    const schema = jsonSchemaToZod({ properties: { a: { type: 'number' } }, required: ['a'] })
    expect(schema.safeParse({ a: 1 }).success).toBe(true)
    expect(schema.safeParse({ a: 'x' }).success).toBe(false)
  })
})
