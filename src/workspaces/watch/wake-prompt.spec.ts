import { describe, it, expect } from 'vitest'

import { buildWatchAlert, buildWatchWakePrompt } from './wake-prompt.js'
import type { WatchEvent, WatchSnapshot, WatchSpec } from './types.js'

const SNAPSHOT: WatchSnapshot = {
  pair: 'BTC-USDT',
  assetClass: 'crypto',
  price: 101_240,
  timestamp: '2026-09-21T14:32:00.000Z',
  timeframe: '1h',
  candles: [],
}

function spec(overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    pair: 'BTC-USDT',
    assetClass: 'crypto',
    direction: 'LONG',
    timeframe: '1h',
    rules: [{ type: 'candle_close', timeframe: '1h', side: 'below', level: 100_000 }],
    invalidationRules: [],
    managementRules: [],
    ...overrides,
  }
}

function event(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    watcherId: 'btc-watch',
    eventType: 'TRIGGER_HIT',
    conditionKey: 'TRIGGER_HIT:candle_close:1h:below:100000',
    message: 'BTC-USDT 1h candle closed below 100000.',
    price: 101_240,
    at: '2026-09-21T14:32:00.000Z',
    ...overrides,
  }
}

const ISSUE = {
  id: 'btc-watch',
  title: 'BTC reclaim watch',
  what: 'Re-check the thesis against the new candle and tell me what changed.',
}

describe('buildWatchWakePrompt', () => {
  it('includes the Issue plan verbatim', () => {
    const prompt = buildWatchWakePrompt(ISSUE, spec(), [event()], SNAPSHOT, { terminal: false })
    expect(prompt).toContain('Re-check the thesis against the new candle and tell me what changed.')
  })

  it('names the Issue id and title so the Session knows its subject', () => {
    const prompt = buildWatchWakePrompt(ISSUE, spec(), [event()], SNAPSHOT, { terminal: false })
    expect(prompt).toContain('btc-watch')
    expect(prompt).toContain('BTC reclaim watch')
  })

  it('reports the fired rule, price, and observation time', () => {
    const prompt = buildWatchWakePrompt(ISSUE, spec(), [event()], SNAPSHOT, { terminal: false })
    expect(prompt).toContain('101240')
    expect(prompt).toContain('2026-09-21T14:32:00.000Z')
    expect(prompt).toContain('candle closed below 100000')
  })

  it('reports every event in one prompt', () => {
    const prompt = buildWatchWakePrompt(
      ISSUE,
      spec(),
      [event(), event({ eventType: 'MANAGEMENT_ALERT', message: '2R reached.' })],
      SNAPSHOT,
      { terminal: false },
    )
    expect(prompt).toContain('candle closed below 100000')
    expect(prompt).toContain('2R reached.')
  })

  it('includes the frozen position context when present', () => {
    const prompt = buildWatchWakePrompt(
      ISSUE,
      spec({ position: { side: 'LONG', entry: 95_000, stop: 92_000, targets: [110_000] } }),
      [event()],
      SNAPSHOT,
      { terminal: false },
    )
    expect(prompt).toContain('LONG')
    expect(prompt).toContain('95000')
    expect(prompt).toContain('92000')
    expect(prompt).toContain('110000')
  })

  it('tells the Session to re-arm for the next phase', () => {
    const prompt = buildWatchWakePrompt(ISSUE, spec(), [event()], SNAPSHOT, { terminal: false })
    expect(prompt).toMatch(/re-arm|rewrite this Issue/i)
  })

  it('marks a terminal watcher as finished and not re-firing', () => {
    const prompt = buildWatchWakePrompt(
      ISSUE,
      spec(),
      [event({ eventType: 'INVALIDATED' })],
      SNAPSHOT,
      { terminal: true },
    )
    expect(prompt).toMatch(/terminal state/i)
  })

  it('never instructs the Session to place an order', () => {
    const prompt = buildWatchWakePrompt(ISSUE, spec(), [event()], SNAPSHOT, { terminal: false })
    expect(prompt).toContain('Do not place orders')
  })

  it('tolerates a missing price without printing null', () => {
    const prompt = buildWatchWakePrompt(
      ISSUE,
      spec(),
      [event({ price: null })],
      { ...SNAPSHOT, price: Number.NaN },
      { terminal: false },
    )
    expect(prompt).not.toContain('null')
    expect(prompt).toContain('-')
  })
})

describe('buildWatchAlert', () => {
  it('names the Issue and the pair', () => {
    const alert = buildWatchAlert(ISSUE, spec(), [event()], SNAPSHOT)
    expect(alert).toContain('BTC reclaim watch')
    expect(alert).toContain('btc-watch')
    expect(alert).toContain('BTC-USDT')
  })

  it('lists each fired event', () => {
    const alert = buildWatchAlert(ISSUE, spec(), [event(), event({ message: 'Second.' })], SNAPSHOT)
    expect(alert).toContain('candle closed below 100000')
    expect(alert).toContain('Second.')
  })

  it('is short enough for a chat notification', () => {
    const alert = buildWatchAlert(ISSUE, spec(), [event()], SNAPSHOT)
    expect(alert.length).toBeLessThan(600)
  })
})