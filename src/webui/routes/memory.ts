/**
 * Memory HTTP route — the Settings → Memory read/edit surface.
 *
 *   GET    /            entries + the pinned rule
 *   GET    /rule        RULE.md text
 *   PUT    /rule        replace RULE.md (owner edit; never model-editable)
 *   GET    /search?q=   filtered entries
 *   POST   /            create/overwrite an entry by title+type
 *   PATCH  /:id         edit title/description/body
 *   DELETE /:id         remove an entry
 *
 * The agent writes through the `memory_*` MCP tools, not this route; this is
 * the human surface. Same split as `entities.ts`, which is read-only for the
 * same reason.
 */

import { Hono } from 'hono'
import { z } from 'zod'

import type { IMemoryStore } from '../../core/memory-store.js'

export interface MemoryRoutesDeps {
  memoryStore: IMemoryStore
}

const saveSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  description: z.string().max(300).optional(),
})

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(300).optional(),
  body: z.string().min(1).optional(),
})

export function createMemoryRoutes(deps: MemoryRoutesDeps) {
  const app = new Hono()

  app.get('/', async (c) => {
    const [entries, rule] = await Promise.all([
      deps.memoryStore.list(),
      deps.memoryStore.rule(),
    ])
    return c.json({
      rule,
      entries: entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        type: entry.type,
        body: entry.body,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    })
  })

  app.get('/rule', async (c) => {
    return c.json({ rule: await deps.memoryStore.rule() })
  })

  app.put('/rule', async (c) => {
    const body = await c.req.json().catch(() => null) as { rule?: unknown } | null
    const rule = typeof body?.rule === 'string' ? body.rule : ''
    if (!rule.trim()) return c.json({ error: 'rule must not be empty' }, 400)
    // RULE.md is the standing operating contract. It is deliberately editable
    // by the human only; no memory_* tool can reach it.
    await deps.memoryStore.writeRule(rule)
    return c.json({ ok: true })
  })

  app.get('/search', async (c) => {
    const query = c.req.query('q') ?? ''
    const entries = await deps.memoryStore.search(query)
    return c.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        type: entry.type,
        body: entry.body,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    })
  })

  app.post('/', async (c) => {
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    const entry = await deps.memoryStore.save({
      title: parsed.data.title,
      content: parsed.data.content,
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
    })
    return c.json({ ok: true, id: entry.id })
  })

  app.patch('/:id', async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    const updated = await deps.memoryStore.update(c.req.param('id'), parsed.data)
    if (!updated) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true, id: updated.id })
  })

  app.delete('/:id', async (c) => {
    const removed = await deps.memoryStore.remove(c.req.param('id'))
    if (!removed) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  return app
}
