import { describe, expect, it } from 'vitest'

import {
  distanceToTrigger,
  formatDuration,
  formatPriceValue,
  renderWatcherBoardCard,
  requirementBar,
  watcherCandleCountdownLine,
  watcherPulseBar,
  watcherTimeframeSeconds,
  watcherTriggerProgress,
  watcherTriggerSide,
  watcherTriggerTarget,
  zoneBounds,
  type WatcherBoardInput,
  type WatcherBoardSpec,
} from './watcher-board.js'

const NOW = '2026-09-22T12:00:00.000Z'

function baseInput(overrides: Partial<WatcherBoardInput> = {}): WatcherBoardInput {
  return {
    watcherId: 'eurusd-short-setup-watch',
    workspaceId: 'chat-stable-maple-bridge',
    workspaceLabel: 'Maple Bridge',
    title: 'EURUSD short setup',
    running: true,
    pollable: true,
    pollSeconds: 30,
    spec: {
      pair: 'EURUSD',
      assetClass: 'forex',
      direction: 'SHORT',
      timeframe: '15m',
      rules: [{ type: 'price_breaks_level', side: 'below', level: 1.14 }],
      invalidationRules: [],
      managementRules: [],
    },
    state: {
      lastChecked: '2026-09-22T11:59:45.000Z',
      lastPrice: 1.14718,
      lastMarketTimestamp: '2026-09-22T11:59:40.000Z',
      pollCount: 112,
      errorCount: 0,
      lastError: null,
      terminal: false,
    },
    nowIso: NOW,
    ...overrides,
  }
}

describe('watcher board primitives', () => {
  it('parses timeframe labels', () => {
    expect(watcherTimeframeSeconds('15m')).toBe(900)
    expect(watcherTimeframeSeconds('4h')).toBe(14_400)
    expect(watcherTimeframeSeconds('1d')).toBe(86_400)
    expect(watcherTimeframeSeconds('bogus')).toBe(0)
  })

  it('formats durations compactly', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(90)).toBe('1m 30s')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(90000)).toBe('1d 1h')
  })

  it('trims trailing zeros from prices', () => {
    expect(formatPriceValue(1.14718)).toBe('1.14718')
    expect(formatPriceValue(110000)).toBe('110000')
    expect(formatPriceValue(null)).toBe('-')
  })

  it('never fully fills a requirement bar below 100', () => {
    expect(requirementBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱▱▱')
    expect(requirementBar(100)).toBe('▰▰▰▰▰▰▰▰▰▰▰▰')
    expect(requirementBar(99)).not.toBe('▰▰▰▰▰▰▰▰▰▰▰▰')
    expect(requirementBar(1)).toContain('▰')
  })
})

describe('watcher pulse bar', () => {
  it('reports a stopped poller', () => {
    const { icon, bar } = watcherPulseBar({ frame: 0, running: false, pollable: true, ageSeconds: 1, pollSeconds: 30 })
    expect(icon).toBe('🔴')
    expect(bar).toContain('poller stopped')
  })

  it('reports a live tick inside cadence', () => {
    const { bar } = watcherPulseBar({ frame: 0, running: true, pollable: true, ageSeconds: 5, pollSeconds: 30 })
    expect(bar).toContain('live')
  })

  it('escalates to delayed then stale', () => {
    expect(watcherPulseBar({ frame: 0, running: true, pollable: true, ageSeconds: 90, pollSeconds: 30 }).bar).toContain('delayed')
    expect(watcherPulseBar({ frame: 0, running: true, pollable: true, ageSeconds: 400, pollSeconds: 30 }).bar).toContain('stale')
  })

  it('does not claim liveness before the first tick', () => {
    const { bar } = watcherPulseBar({ frame: 0, running: true, pollable: true, ageSeconds: null, pollSeconds: 30 })
    expect(bar).toContain('waiting for first tick')
  })
})

describe('trigger geometry', () => {
  it('derives the target and side from the primary rule', () => {
    const input = baseInput()
    expect(watcherTriggerTarget(input.spec)).toEqual(['1.14', 'price below 1.14 on 15m'])
    expect(watcherTriggerSide(input.spec)).toBe('below')
  })

  it('reads an entry zone from any rule', () => {
    const zone = zoneBounds({ pair: 'X', rules: [{ type: 'price_enters_zone', low: 10, high: 12 }] })
    expect(zone).toEqual({ low: 10, high: 12 })
  })

  it('reports progress toward a below-level trigger', () => {
    const input = baseInput()
    const progress = watcherTriggerProgress(input.spec, input.state, 1.1405, '1.14', 'below')
    expect(progress.percent).toBeGreaterThan(0)
    expect(progress.percent).toBeLessThan(100)
    expect(progress.text).toContain('to breakdown')
    expect(progress.need).toContain('need -')
  })

  it('measures progress from the entry-zone edge when a zone exists', () => {
    const input = baseInput({
      spec: {
        pair: 'EURUSD',
        direction: 'SHORT',
        timeframe: '15m',
        rules: [
          { type: 'price_breaks_level', side: 'below', level: 1.14 },
          { type: 'price_enters_zone', low: 1.15, high: 1.155 },
        ],
        invalidationRules: [],
        managementRules: [],
      },
    })
    const atZone = watcherTriggerProgress(input.spec, input.state, 1.15, '1.14', 'below')
    const nearLevel = watcherTriggerProgress(input.spec, input.state, 1.142, '1.14', 'below')
    expect(atZone.percent).toBeLessThan(nearLevel.percent)
    expect(nearLevel.percent).toBeGreaterThan(50)
  })

  it('reports 100 once the level is breached', () => {
    const input = baseInput()
    const progress = watcherTriggerProgress(input.spec, input.state, 1.13, '1.14', 'below')
    expect(progress.percent).toBe(100)
    expect(progress.text).toBe('breakdown trigger reached')
  })

  it('describes the raw distance', () => {
    expect(distanceToTrigger(1.14718, '1.14', null, 'below')).toContain('above breakdown')
    expect(distanceToTrigger(1.13, '1.14', null, 'below')).toContain('below breakdown')
  })

  // Regression: a hyphenated zone target (`113-115.6`) is a RANGE, not a
  // number. `Number.parseFloat` used to read it as `113`, so a price merely
  // sitting above the zone's lower edge was reported as `trigger reached`.
  describe('zone targets', () => {
    const zoneSpec = (): WatcherBoardSpec => ({
      pair: 'SOLUSD',
      direction: 'LONG',
      timeframe: '1h',
      rules: [
        { type: 'price_enters_zone', low: 113, high: 115.6 },
        { type: 'price_breaks_level', side: 'above', level: 119.81 },
      ],
      invalidationRules: [{ type: 'price_breaks_level', side: 'below', level: 96.23 }],
      managementRules: [],
    })

    it('renders the zone as a hyphenated target', () => {
      expect(watcherTriggerTarget(zoneSpec())).toEqual(['113-115.6', 'price enters 113-115.6'])
    })

    it('does not claim the trigger when price is above the zone', () => {
      const progress = watcherTriggerProgress(zoneSpec(), {}, 117.9, '113-115.6', '')
      expect(progress.percent).toBeLessThan(100)
      expect(progress.text).toContain('back to entry zone')
      expect(progress.need).toContain('need -')
    })

    it('reports 100 only once price is inside the zone', () => {
      const progress = watcherTriggerProgress(zoneSpec(), {}, 114.2, '113-115.6', '')
      expect(progress.percent).toBe(100)
      expect(progress.text).toBe('entry zone reached')
    })

    it('measures distance to the nearest zone edge', () => {
      expect(distanceToTrigger(117.9, '113-115.6', { low: 113, high: 115.6 }, '')).toBe('2.3 above zone')
      expect(distanceToTrigger(110, '113-115.6', { low: 113, high: 115.6 }, '')).toBe('3 below zone')
      expect(distanceToTrigger(114.2, '113-115.6', { low: 113, high: 115.6 }, '')).toBe('inside target zone')
    })
  })
})

describe('candle triggers', () => {
  it('counts down to the next close', () => {
    const input = baseInput({
      spec: {
        pair: 'BTCUSDT',
        direction: 'LONG',
        timeframe: '1h',
        rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 110000 }],
        invalidationRules: [],
        managementRules: [],
      },
      state: { lastMarketTimestamp: '2026-09-22T12:04:40.000Z', lastPrice: 101000, pollCount: 3 },
    })
    const line = watcherCandleCountdownLine(input.spec, input.state, '2026-09-22T12:05:00.000Z')
    expect(line).toContain('closes in')
  })

  it('reports the close as due when the feed is older than the boundary', () => {
    const input = baseInput({
      spec: {
        pair: 'BTCUSDT',
        direction: 'LONG',
        timeframe: '1h',
        rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 110000 }],
        invalidationRules: [],
        managementRules: [],
      },
      state: { lastMarketTimestamp: '2026-09-22T11:30:00.000Z', lastPrice: 101000, pollCount: 3 },
    })
    expect(watcherCandleCountdownLine(input.spec, input.state, NOW)).toContain('due now')
  })

  it('returns no countdown for a non-candle watcher', () => {
    const input = baseInput()
    expect(watcherCandleCountdownLine(input.spec, input.state, NOW)).toBe('')
  })
})

describe('candle-close trigger progress', () => {
  const candleSpec = (side: 'above' | 'below', level: number): WatcherBoardSpec => ({
    pair: 'BTCUSDT',
    direction: side === 'above' ? 'LONG' : 'SHORT',
    timeframe: '1h',
    rules: [{ type: 'candle_close', timeframe: '1h', side, level }],
    invalidationRules: [],
    managementRules: [],
  })

  // The reported bug. Progress used the last CONFIRMED close, which for a fresh
  // 1h watcher can be far from the level — so a watcher whose price sat right on
  // the level rendered as a flat 0%.
  it('measures progress from the live price, not the stale confirmed close', () => {
    const progress = watcherTriggerProgress(
      candleSpec('above', 110_000),
      { lastConfirmedCandle: { timestamp: NOW, close: 101_000 } },
      109_500, '110000', 'above',
    )
    expect(progress.percent).toBeGreaterThan(0)
    expect(progress.text).toContain('to confirmed close')
    expect(progress.need).toContain('need +')
  })

  it('measures a below candle trigger from the live price too', () => {
    const progress = watcherTriggerProgress(
      candleSpec('below', 100_000),
      { lastConfirmedCandle: { timestamp: NOW, close: 109_000 } },
      100_400, '100000', 'below',
    )
    expect(progress.percent).toBeGreaterThan(0)
    expect(progress.text).toContain('to confirmed breakdown')
    expect(progress.need).toContain('need -')
  })

  // A confirmed close sitting almost ON the level is not a usable baseline: its
  // span is smaller than the remaining distance, so the old ratio clamped to a
  // flat 0% for the whole final approach. Proximity to the level must still
  // register, and must rise monotonically as price closes in.
  it('does not pin the bar at 0% when the last close sits on the level', () => {
    const spec = candleSpec('above', 110_000)
    const state = { lastConfirmedCandle: { timestamp: NOW, close: 109_990 } }

    const far = watcherTriggerProgress(spec, state, 109_900, '110000', 'above')
    const near = watcherTriggerProgress(spec, state, 109_990, '110000', 'above')

    expect(far.percent).toBeGreaterThan(0)
    expect(near.percent).toBeGreaterThan(far.percent)
    expect(near.percent).toBeLessThan(100)
  })

  // A live price beyond the level is a FORMING candle. It must never claim a
  // fire, because the candle can still close back inside.
  it('caps a forming candle beyond the level at 99%, for either side', () => {
    const above = watcherTriggerProgress(
      candleSpec('above', 110_000),
      { lastConfirmedCandle: { timestamp: NOW, close: 109_000 } },
      112_000, '110000', 'above',
    )
    expect(above.percent).toBe(99)
    expect(above.text).toBe('forming candle beyond trigger')
    expect(above.need).toBe('needs confirmed candle close')

    const below = watcherTriggerProgress(
      candleSpec('below', 100_000),
      { lastConfirmedCandle: { timestamp: NOW, close: 101_000 } },
      98_000, '100000', 'below',
    )
    expect(below.percent).toBe(99)
    expect(below.text).toBe('forming candle beyond trigger')
  })

  // 100% requires the CLOSE to be beyond the level — the only thing that can
  // actually fire this watcher.
  it('reaches 100% only when the confirmed candle closed beyond the level', () => {
    const progress = watcherTriggerProgress(
      candleSpec('above', 110_000),
      { lastConfirmedCandle: { timestamp: NOW, close: 111_500 } },
      111_600, '110000', 'above',
    )
    expect(progress.percent).toBe(100)
    expect(progress.text).toBe('confirmed candle trigger reached')
  })

  it('reaches 100% for a confirmed below close', () => {
    const progress = watcherTriggerProgress(
      candleSpec('below', 100_000),
      { lastConfirmedCandle: { timestamp: NOW, close: 98_500 } },
      98_400, '100000', 'below',
    )
    expect(progress.percent).toBe(100)
    expect(progress.text).toBe('confirmed candle trigger reached')
  })
})

describe('renderWatcherBoardCard', () => {
  it('renders a compact card and an expanded detail', () => {
    const card = renderWatcherBoardCard(baseInput(), 0)
    expect(card.watcherId).toBe('eurusd-short-setup-watch')
    expect(card.pair).toBe('EURUSD')
    expect(card.terminal).toBe(false)
    expect(card.card).toContain('EURUSD')
    expect(card.card).toContain('WATCHING')
    expect(card.card).toContain('tick `#112`')
    expect(card.detail).toContain('Trigger progress')
    expect(card.detail).toContain('Entry zone')
    expect(card.detail).toContain('Price location')
  })

  it('marks a terminal watcher and reports the live feed error', () => {
    const card = renderWatcherBoardCard(baseInput({
      pollable: false,
      state: { terminal: true, lastPrice: 1.13, errorCount: 3, lastError: 'market snapshot unavailable' },
    }), 0)
    expect(card.terminal).toBe(true)
    expect(card.card).toContain('FINISHED')
    expect(card.detail).toContain('TRIGGER HIT')
    expect(card.detail).toContain('market snapshot unavailable')
  })

  it('renders without state before the first tick', () => {
    const card = renderWatcherBoardCard(baseInput({ state: {}, pollable: true }), 0)
    expect(card.card).toContain('waiting for first tick')
    expect(card.progressPercent).toBe(0)
  })
})
