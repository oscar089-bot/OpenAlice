import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { ISSUES_DIR_REL } from '../issues/declaration.js'
import {
  WATCH_SIDECAR_SUFFIX,
  deleteWatchRecord,
  listWatchRecordIds,
  readWatchRecord,
  writeWatchRecord,
} from './store.js'
import { emptyWatchState, type WatchEvent } from './types.js'

const NOW = '2026-09-21T12:00:00.000Z'

let wsDir: string

beforeEach(async () => {
  wsDir = await mkdtemp(join(tmpdir(), 'watch-store-'))
})

afterEach(async () => {
  await rm(wsDir, { recursive: true, force: true })
})

describe('watch store', () => {
  it('returns null when no record exists', async () => {
    expect(await readWatchRecord(wsDir, 'missing', NOW)).toBeNull()
  })

  it('round-trips state and events', async () => {
    const state = { ...emptyWatchState(NOW), lastPrice: 105, pollCount: 3 }
    const events: WatchEvent[] = [{
      watcherId: 'my-watch',
      eventType: 'TRIGGER_HIT',
      conditionKey: 'TRIGGER_HIT:price_breaks_level:above:100',
      message: 'broke 100',
      price: 105,
      at: NOW,
    }]
    await writeWatchRecord(wsDir, 'my-watch', state, events)
    const read = await readWatchRecord(wsDir, 'my-watch', NOW)
    expect(read).not.toBeNull()
    expect(read!.state.lastPrice).toBe(105)
    expect(read!.state.pollCount).toBe(3)
    expect(read!.events).toHaveLength(1)
    expect(read!.events[0].conditionKey).toContain('price_breaks_level')
  })

  it('persists fired conditions so a restart cannot re-fire', async () => {
    const key = 'TRIGGER_HIT:price_breaks_level:above:100'
    const state = { ...emptyWatchState(NOW), firedConditions: { [key]: NOW } }
    await writeWatchRecord(wsDir, 'my-watch', state, [])
    const read = await readWatchRecord(wsDir, 'my-watch', NOW)
    expect(read!.state.firedConditions[key]).toBe(NOW)
  })

  it('preserves candle bookkeeping across a restart', async () => {
    const candle = { timestamp: NOW, open: 1, high: 2, low: 0.5, close: 1.5, timeframe: '1h' }
    const state = { ...emptyWatchState(NOW), lastConfirmedCandle: candle }
    await writeWatchRecord(wsDir, 'my-watch', state, [])
    const read = await readWatchRecord(wsDir, 'my-watch', NOW)
    expect(read!.state.lastConfirmedCandle?.close).toBe(1.5)
  })

  it('truncates a corrupt record to a safe default instead of throwing', async () => {
    const dir = join(wsDir, ISSUES_DIR_REL)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `broken${WATCH_SIDECAR_SUFFIX}`), '{ not json', 'utf8')
    expect(await readWatchRecord(wsDir, 'broken', NOW)).toBeNull()
  })

  it('recovers usable state from a partially valid record', async () => {
    const dir = join(wsDir, ISSUES_DIR_REL)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `partial${WATCH_SIDECAR_SUFFIX}`)
    await writeFile(path, JSON.stringify({
      version: 1,
      state: { lastPrice: 42, firedConditions: { a: NOW, bad: 7 } },
      events: 'not-an-array',
    }), 'utf8')
    const read = await readWatchRecord(wsDir, 'partial', NOW)
    expect(read!.state.lastPrice).toBe(42)
    expect(read!.state.firedConditions).toEqual({ a: NOW })
    expect(read!.events).toEqual([])
  })

  it('caps the retained event log', async () => {
    const events: WatchEvent[] = Array.from({ length: 260 }, (_, i) => ({
      watcherId: 'w',
      eventType: 'TRIGGER_HIT' as const,
      conditionKey: `c${i}`,
      message: `m${i}`,
      price: i,
      at: NOW,
    }))
    await writeWatchRecord(wsDir, 'w', emptyWatchState(NOW), events)
    const read = await readWatchRecord(wsDir, 'w', NOW)
    expect(read!.events.length).toBeLessThanOrEqual(200)
    // Keeps the newest, drops the oldest.
    expect(read!.events[read!.events.length - 1].conditionKey).toBe('c259')
  })

  it('lists persisted watcher ids', async () => {
    await writeWatchRecord(wsDir, 'alpha', emptyWatchState(NOW), [])
    await writeWatchRecord(wsDir, 'beta', emptyWatchState(NOW), [])
    expect(await listWatchRecordIds(wsDir)).toEqual(['alpha', 'beta'])
  })

  it('lists nothing when the issues dir is absent', async () => {
    expect(await listWatchRecordIds(join(wsDir, 'nope'))).toEqual([])
  })

  it('deletes a record, tolerating a missing file', async () => {
    await writeWatchRecord(wsDir, 'gone', emptyWatchState(NOW), [])
    await deleteWatchRecord(wsDir, 'gone')
    expect(await readWatchRecord(wsDir, 'gone', NOW)).toBeNull()
    await expect(deleteWatchRecord(wsDir, 'gone')).resolves.toBeUndefined()
  })

  it('leaves no tmp file behind after a write', async () => {
    await writeWatchRecord(wsDir, 'clean', emptyWatchState(NOW), [])
    const entries = await readdir(join(wsDir, ISSUES_DIR_REL))
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
