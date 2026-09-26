import { describe, expect, it } from 'vitest'

import type { IssueRecord } from '../issues/declaration.js'
import type { WorkspaceMeta } from '../workspace-registry.js'

import { toBoardItem, toBoardSpec } from './board.js'
import { emptyWatchState, type WatchSpec } from './types.js'

const NOW_ISO = '2026-09-21T12:00:00.000Z'

function spec(overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    pair: 'BTC-USDT',
    assetClass: 'crypto',
    direction: 'LONG',
    timeframe: '1h',
    rules: [{ type: 'candle_close', side: 'above', level: 110_000, timeframe: '1h' }],
    invalidationRules: [],
    managementRules: [],
    ...overrides,
  }
}

const workspace = { id: 'ws', tag: 'ws', dir: '/tmp/ws' } as WorkspaceMeta
const issue = { id: 'btc-watch', title: 'BTC reclaim', status: 'todo' } as IssueRecord

function item(input: { spec?: WatchSpec; running?: boolean } = {}) {
  const resolved = input.spec ?? spec()
  return toBoardItem({
    workspace,
    issue,
    spec: resolved,
    state: emptyWatchState(NOW_ISO),
    running: input.running ?? true,
    pollSeconds: 5,
    nowIso: NOW_ISO,
  })
}

describe('toBoardItem presentation meta', () => {
  // The bug this covers: the renderer already read `meta.grade` /
  // `meta.setupPhase`, but nothing ever populated them, so a model that graded
  // its watcher saw `not graded` on the card and had no way to know why.
  it('projects the authored grade, phase, and next step', () => {
    const built = item({
      spec: spec({
        meta: { grade: 'A+', phase: 'reclaim', nextStep: 'Re-check volume before re-arming.' },
      }),
    })
    expect(built?.meta).toMatchObject({
      grade: 'A+',
      setupPhase: 'reclaim',
      nextStep: 'Re-check volume before re-arming.',
    })
  })

  // `meta.phase` maps onto the renderer's `setupPhase`; `rating` is the numeric
  // alternative the renderer prefers over `grade` when both are set.
  it('accepts a numeric rating as well as a letter grade', () => {
    const built = item({ spec: spec({ meta: { rating: 9 } }) })
    expect(built?.meta).toMatchObject({ rating: 9 })
  })

  // Position stop/targets still reach the card. They are a different source
  // from the authored meta and must not be lost by the meta merge.
  it('keeps stop and targets from the frozen position', () => {
    const built = item({
      spec: spec({
        rules: [],
        position: { side: 'LONG', entry: 100, stop: 95, targets: [120] },
        managementRules: [{ type: 'r_multiple_reached', multiple: 2 }],
        meta: { grade: 'A' },
      }),
    })
    expect(built?.meta).toMatchObject({ grade: 'A', stopLoss: 95, targets: [120] })
  })

  it('omits meta entirely when nothing was authored', () => {
    expect(item()?.meta).toBeUndefined()
  })
})

describe('toBoardSpec', () => {
  // `waitingTrigger` is prose the model wrote. Without it the card fell back to
  // the raw rule type (`candle_close`), which reads like a debug dump.
  it('carries the authored trigger prose and invalidation conditions', () => {
    const projected = toBoardSpec(spec({
      meta: {
        waitingTrigger: 'BTC closes a 1h candle above 110k',
        invalidationConditions: ['BTC loses 98k on a 1h close'],
      },
    }))
    expect(projected.waitingTrigger).toBe('BTC closes a 1h candle above 110k')
    expect(projected.invalidationConditions).toEqual(['BTC loses 98k on a 1h close'])
  })

  it('omits the prose fields when the model did not write them', () => {
    const projected = toBoardSpec(spec())
    expect(projected.waitingTrigger).toBeUndefined()
    expect(projected.invalidationConditions).toBeUndefined()
  })
})