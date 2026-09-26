import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_PENDING_DELIVERIES,
  PENDING_DELIVERY_TTL_MS,
  loadPendingDeliveries,
  retryDelayMs,
  savePendingDeliveries,
  type PendingDeliveryEntry,
} from './pending-delivery-store.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pending-delivery-'))
  path = join(dir, 'pending.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function entry(key: string, overrides: Partial<PendingDeliveryEntry> = {}): PendingDeliveryEntry {
  return {
    key,
    connectorId: 'telegram',
    kind: 'notification',
    payload: { id: key },
    attempts: 1,
    firstFailedAt: 1_000,
    nextAttemptAt: 6_000,
    ...overrides,
  }
}

describe('pending delivery store', () => {
  it('round-trips queued retries', async () => {
    await savePendingDeliveries([entry('a'), entry('b')], path)
    const loaded = await loadPendingDeliveries(path, 2_000)
    expect(loaded.map((item) => item.key)).toEqual(['a', 'b'])
    expect(loaded[0]?.connectorId).toBe('telegram')
    expect(loaded[0]?.payload).toEqual({ id: 'a' })
  })

  it('treats a missing file as an empty queue', async () => {
    expect(await loadPendingDeliveries(join(dir, 'absent.json'))).toEqual([])
  })

  it('treats a corrupt or unsealed file as an empty queue', async () => {
    // A plain object is not a sealed envelope, so it must not be trusted. A
    // bad retry file must never stop the Connector Service from starting.
    await writeFile(path, JSON.stringify({ version: 1, entries: [entry('x')] }), 'utf8')
    expect(await loadPendingDeliveries(path)).toEqual([])
    await writeFile(path, 'not json at all', 'utf8')
    expect(await loadPendingDeliveries(path)).toEqual([])
  })

  it('drops entries past their TTL so a long downtime cannot replay stale alerts', async () => {
    const fresh = entry('fresh', { firstFailedAt: 1_000 })
    const stale = entry('stale', { firstFailedAt: 1_000 })
    await savePendingDeliveries([fresh, stale], path)
    // `fresh` is within the window; `stale` is far beyond it.
    const loaded = await loadPendingDeliveries(path, 1_000 + PENDING_DELIVERY_TTL_MS + 1)
    expect(loaded).toEqual([])
    const justInside = await loadPendingDeliveries(path, 1_000 + PENDING_DELIVERY_TTL_MS - 1)
    expect(justInside.map((item) => item.key)).toEqual(['fresh', 'stale'])
  })

  it('caps the queue so a dead transport cannot grow the file forever', async () => {
    const many = Array.from({ length: MAX_PENDING_DELIVERIES + 20 }, (_, index) => entry(`k-${index}`))
    await savePendingDeliveries(many, path)
    const loaded = await loadPendingDeliveries(path, 2_000)
    expect(loaded).toHaveLength(MAX_PENDING_DELIVERIES)
    // The NEWEST survive: a stale flood is worse than losing the tail.
    expect(loaded.at(-1)?.key).toBe(`k-${MAX_PENDING_DELIVERIES + 19}`)
  })

  it('backs off exponentially and then stops growing', () => {
    expect(retryDelayMs(1)).toBe(10_000)
    expect(retryDelayMs(2)).toBe(20_000)
    expect(retryDelayMs(3)).toBe(40_000)
    // Capped, so a long-lived entry does not schedule an absurd delay.
    expect(retryDelayMs(9)).toBe(160_000)
    expect(retryDelayMs(50)).toBe(160_000)
  })
})
