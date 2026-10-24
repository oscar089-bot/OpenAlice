import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore, type IMemoryStore } from '../../core/memory-store.js'
import { createMemoryRoutes } from './memory.js'

let root: string
let store: IMemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openalice-memroute-'))
  store = createMemoryStore({ root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function json(body: unknown, method = 'GET'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
  }
}

describe('memory routes', () => {
  it('lists the rule and entries', async () => {
    await store.save({ title: 'A lesson', content: 'body', type: 'feedback' })
    const app = createMemoryRoutes({ memoryStore: store })
    const response = await app.request('/')
    expect(response.status).toBe(200)
    const payload = await response.json() as { rule: string; entries: { title: string }[] }
    expect(payload.rule).toContain('Operating Rules')
    expect(payload.entries.map((entry) => entry.title)).toEqual(['A lesson'])
  })

  it('exposes the rule separately and allows replacing it', async () => {
    const app = createMemoryRoutes({ memoryStore: store })

    const read = await app.request('/rule')
    expect((await read.json() as { rule: string }).rule).toContain('Discipline')

    const write = await app.request('/rule', json({ rule: '# Custom\n' }, 'PUT'))
    expect(write.status).toBe(200)
    expect(await store.rule()).toBe('# Custom\n')
  })

  it('rejects an empty rule replacement', async () => {
    const app = createMemoryRoutes({ memoryStore: store })
    const response = await app.request('/rule', json({ rule: '   ' }, 'PUT'))
    expect(response.status).toBe(400)
    expect(await store.rule()).toContain('Operating Rules')
  })

  it('creates, patches and deletes an entry', async () => {
    const app = createMemoryRoutes({ memoryStore: store })

    const created = await app.request('/', json({ title: 'Editable', content: 'v1' }, 'POST'))
    expect(created.status).toBe(200)
    const { id } = await created.json() as { id: string }

    const patched = await app.request(`/${id}`, json({ body: 'v2' }, 'PATCH'))
    expect(patched.status).toBe(200)
    expect((await store.get(id))?.body).toContain('v2')

    const removed = await app.request(`/${id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await store.list()).toHaveLength(0)
  })

  it('returns 404 for an unknown entry', async () => {
    const app = createMemoryRoutes({ memoryStore: store })
    expect((await app.request('/missing', json({ body: 'x' }, 'PATCH'))).status).toBe(404)
    expect((await app.request('/missing', { method: 'DELETE' })).status).toBe(404)
  })

  it('filters through the search endpoint', async () => {
    await store.save({ title: 'EURUSD trap', content: 'confirm first', type: 'feedback' })
    await store.save({ title: 'BTC timing', content: 'wait for the close', type: 'feedback' })
    const app = createMemoryRoutes({ memoryStore: store })

    const response = await app.request('/search?q=eurusd')
    const payload = await response.json() as { entries: { title: string }[] }
    expect(payload.entries.map((entry) => entry.title)).toEqual(['EURUSD trap'])
  })

  it('rejects a malformed create body', async () => {
    const app = createMemoryRoutes({ memoryStore: store })
    const response = await app.request('/', json({ title: '' }, 'POST'))
    expect(response.status).toBe(400)
  })
})