import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { ISSUES_DIR_REL } from '../issues/declaration.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'

import {
  WatchLoop,
  collectWatches,
  nextBackoffMs,
  specFingerprint,
  type WatchFire,
  type WatchLoopDeps,
} from './loop.js'
import { readWatchRecord, writeWatchRecord } from './store.js'
import type { WatchSnapshot, WatchSpec } from './types.js'

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)
const NOW_ISO = new Date(NOW).toISOString()

function silentLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLogger() } as unknown as Logger
}

function registryFor(dirs: { id: string; dir: string }[]): WorkspaceRegistry {
  const metas: WorkspaceMeta[] = dirs.map((d) => ({ id: d.id, tag: d.id, dir: d.dir })) as WorkspaceMeta[]
  return {
    list: () => metas,
    get: (id: string) => metas.find((m) => m.id === id),
  } as unknown as WorkspaceRegistry
}

function issueFile(spec: WatchSpec | null, body = 'Plan: re-check the thesis.'): string {
  const lines = ['---', 'title: BTC watch', 'assignee: "@resume-owner"']
  if (spec) lines.push(`watch: ${JSON.stringify(spec)}`)
  lines.push('---', '', body, '')
  return lines.join('\n')
}

const SPEC: WatchSpec = {
  pair: 'BTC-USDT',
  assetClass: 'crypto',
  direction: 'LONG',
  timeframe: '1h',
  rules: [{ type: 'price_breaks_level', side: 'above', level: 100 }],
  invalidationRules: [],
  managementRules: [],
}

let root: string
let wsDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watch-loop-'))
  wsDir = join(root, 'ws')
  await mkdir(join(wsDir, ISSUES_DIR_REL), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeIssue(id: string, spec: WatchSpec | null): Promise<void> {
  await writeFile(join(wsDir, ISSUES_DIR_REL, `${id}.md`), issueFile(spec), 'utf8')
}

function snapshot(price: number): WatchSnapshot {
  return { pair: 'BTC-USDT', assetClass: 'crypto', price, timestamp: NOW_ISO, timeframe: '1h', candles: [] }
}

function makeLoop(
  overrides: Partial<WatchLoopDeps> = {},
  fires: WatchFire[] = [],
): WatchLoop {
  return new WatchLoop({
    registry: registryFor([{ id: 'ws', dir: wsDir }]),
    snapshot: async () => snapshot(105),
    onFire: async (fire) => { fires.push(fire) },
    logger: silentLogger(),
    now: () => NOW,
    ...overrides,
  })
}

describe('specFingerprint', () => {
  it('is stable for an identical spec', () => {
    expect(specFingerprint(SPEC)).toBe(specFingerprint({ ...SPEC }))
  })

  it('changes when a rule changes', () => {
    const changed = { ...SPEC, rules: [{ type: 'price_breaks_level' as const, side: 'above' as const, level: 200 }] }
    expect(specFingerprint(changed)).not.toBe(specFingerprint(SPEC))
  })

  it('changes when the pair changes', () => {
    expect(specFingerprint({ ...SPEC, pair: 'ETH-USDT' })).not.toBe(specFingerprint(SPEC))
  })

  // Meta is presentation only. If it counted, a model that fixed a typo in its
  // grade would reset fired-condition history and replay an alert the operator
  // had already seen.
  it('ignores the presentation meta block', () => {
    const graded = {
      ...SPEC,
      meta: { grade: 'A+', phase: 'reclaim', nextStep: 'Re-check volume.' },
    }
    expect(specFingerprint(graded)).toBe(specFingerprint(SPEC))
  })
})

describe('collectWatches', () => {
  it('finds issues carrying a watch', async () => {
    await writeIssue('armed', SPEC)
    await writeIssue('plain', null)
    const found = await collectWatches(registryFor([{ id: 'ws', dir: wsDir }]))
    expect(found.map((w) => w.issue.id)).toEqual(['armed'])
  })

  it('ignores a workspace with no issues dir', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'watch-none-'))
    const found = await collectWatches(registryFor([{ id: 'none', dir: empty }]))
    expect(found).toEqual([])
    await rm(empty, { recursive: true, force: true })
  })
})

describe('WatchLoop', () => {
  it('does not fire while the condition is false', async () => {
    await writeIssue('armed', SPEC)
    const fires: WatchFire[] = []
    const loop = makeLoop({ snapshot: async () => snapshot(99) }, fires)
    await loop.tick()
    expect(fires).toHaveLength(0)
  })

  it('fires once when the condition becomes true', async () => {
    await writeIssue('armed', SPEC)
    const fires: WatchFire[] = []
    const loop = makeLoop({ snapshot: async () => snapshot(105) }, fires)
    await loop.tick()
    expect(fires).toHaveLength(1)
    expect(fires[0].issue.id).toBe('armed')
    expect(fires[0].events[0].eventType).toBe('TRIGGER_HIT')
    expect(fires[0].snapshot.price).toBe(105)
  })

  it('does not fire the same condition on the next tick', async () => {
    await writeIssue('armed', SPEC)
    const fires: WatchFire[] = []
    const loop = makeLoop({ snapshot: async () => snapshot(105) }, fires)
    await loop.tick()
    await loop.tick()
    expect(fires).toHaveLength(1)
  })

  it('does not fire again after a restart (state is persisted)', async () => {
    await writeIssue('armed', SPEC)
    const first: WatchFire[] = []
    await makeLoop({ snapshot: async () => snapshot(105) }, first).tick()
    expect(first).toHaveLength(1)
    const second: WatchFire[] = []
    await makeLoop({ snapshot: async () => snapshot(106) }, second).tick()
    expect(second).toHaveLength(0)
  })

  it('fetches each distinct pair once per tick', async () => {
    await writeIssue('a', SPEC)
    await writeIssue('b', { ...SPEC, rules: [{ type: 'price_breaks_level', side: 'above', level: 101 }] })
    const provider = vi.fn(async () => snapshot(105))
    const loop = makeLoop({ snapshot: provider })
    await loop.tick()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('fetches separately for different pairs', async () => {
    await writeIssue('a', SPEC)
    await writeIssue('b', { ...SPEC, pair: 'ETH-USDT' })
    const provider = vi.fn(async () => snapshot(105))
    await makeLoop({ snapshot: provider }).tick()
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('skips the fetch while a persisted backoff is still in effect', async () => {
    await writeIssue('armed', SPEC)
    const provider = vi.fn(async () => snapshot(105))
    // Three consecutive failures cross the free-retry window and persist a
    // backoff deadline.
    for (let i = 0; i < 3; i++) await makeLoop({ snapshot: async () => null }).tick()
    const record = await readWatchRecord(wsDir, 'armed', NOW_ISO)
    expect(record?.state.backoffUntil).not.toBeNull()
    // A restart must NOT reset the backoff into a retry storm.
    await makeLoop({ snapshot: provider }).tick()
    expect(provider).not.toHaveBeenCalled()
  })

  it('clears the failure streak after a successful fetch', async () => {
    await writeIssue('armed', SPEC)
    let clock = NOW
    for (let i = 0; i < 3; i++) {
      await makeLoop({ snapshot: async () => null, now: () => clock }).tick()
    }
    // Advance past the persisted backoff so the next pass actually fetches.
    clock = NOW + 10 * 60_000
    await makeLoop({ snapshot: async () => snapshot(99), now: () => clock }).tick()
    const record = await readWatchRecord(wsDir, 'armed', NOW_ISO)
    expect(record?.state.errorCount).toBe(0)
    expect(record?.state.backoffUntil).toBeNull()
    expect(record?.state.lastError).toBeNull()
  })

  it('keeps watching across a restart when the condition is not yet true', async () => {
    await writeIssue('armed', SPEC)
    await makeLoop({ snapshot: async () => snapshot(99) }).tick()
    const fires: WatchFire[] = []
    await makeLoop({ snapshot: async () => snapshot(105) }, fires).tick()
    expect(fires).toHaveLength(1)
  })
})

describe('nextBackoffMs', () => {
  it('does not back off within the free-retry window', () => {
    expect(nextBackoffMs(1)).toBeNull()
    expect(nextBackoffMs(2)).toBeNull()
  })

  it('backs off at the base delay after the free window', () => {
    expect(nextBackoffMs(3, 1000, 100_000)).toBe(1000)
  })

  it('doubles per consecutive failure', () => {
    expect(nextBackoffMs(4, 1000, 100_000)).toBe(2000)
    expect(nextBackoffMs(5, 1000, 100_000)).toBe(4000)
  })

  it('clamps at the maximum', () => {
    expect(nextBackoffMs(50, 1000, 5000)).toBe(5000)
  })
})

describe('watch loop board publishing', () => {
  it('publishes one board item per watched issue', async () => {
    await writeIssue('armed', SPEC)
    const boards: import('@traderalice/connector-protocol').WatcherBoardItem[][] = []
    await makeLoop({ onBoard: async (items) => { boards.push(items) } }).tick()
    expect(boards).toHaveLength(1)
    const [items] = boards
    expect(items).toHaveLength(1)
    expect(items[0].watcherId).toBe('armed')
    expect(items[0].spec.pair).toBe('BTC-USDT')
    expect(items[0].running).toBe(true)
    expect(items[0].pollable).toBe(true)
    expect(items[0].pollSeconds).toBe(5)
    // The board reflects the state the tick just persisted, not the pre-tick
    // shape: one poll has happened and the price is the fetched price.
    expect(items[0].state.pollCount).toBe(1)
    expect(items[0].state.lastPrice).toBe(105)
  })

  it('publishes an empty board when no issue is watched', async () => {
    await writeIssue('plain', null)
    const boards: import('@traderalice/connector-protocol').WatcherBoardItem[][] = []
    await makeLoop({ onBoard: async (items) => { boards.push(items) } }).tick()
    expect(boards).toEqual([[]])
  })

  it('does not publish when no board callback is wired', async () => {
    await writeIssue('armed', SPEC)
    // No onBoard: the loop still evaluates, and nothing throws.
    await expect(makeLoop().tick()).resolves.toBeUndefined()
  })

  it('isolates a board failure from evaluation', async () => {
    await writeIssue('armed', SPEC)
    const fires: WatchFire[] = []
    await expect(
      makeLoop({
        snapshot: async () => snapshot(105),
        onBoard: async () => { throw new Error('connector down') },
      }, fires).tick(),
    ).resolves.toBeUndefined()
    // The condition still fired despite the board transport throwing.
    expect(fires).toHaveLength(1)
  })

  it('keeps a terminal watcher visible on the board', async () => {
    await writeIssue('armed', SPEC)
    const now = NOW_ISO
    await writeWatchRecord(wsDir, 'armed', {
      armedAt: now,
      specFingerprint: specFingerprint(SPEC),
      lastChecked: now,
      lastPrice: 90,
      lastMarketTimestamp: now,
      lastConfirmedCandle: null,
      previousConfirmedCandle: null,
      lastEvent: 'INVALIDATED',
      terminal: true,
      alertedConditions: {},
      firedConditions: {},
      cooldownUntil: null,
      backoffUntil: null,
      pollCount: 5,
      errorCount: 0,
      lastError: null,
    }, [])
    const boards: import('@traderalice/connector-protocol').WatcherBoardItem[][] = []
    await makeLoop({ onBoard: async (items) => { boards.push(items) } }).tick()
    expect(boards).toHaveLength(1)
    expect(boards[0]).toHaveLength(1)
    expect(boards[0][0].state.terminal).toBe(true)
    expect(boards[0][0].pollable).toBe(false)
  })
})
