import { describe, it, expect } from 'vitest'

import {
  DEFAULT_EVALUATOR_CONFIG,
  evaluateWatch,
  initialState,
  primaryCandleTimeframe,
  ruleConditionKey,
  timeframeSeconds,
} from './evaluator.js'
import type { WatchCandle, WatchSnapshot, WatchSpec, WatchState } from './types.js'

const NOW = '2026-09-21T12:00:00.000Z'
const ARMED = '2026-09-21T11:00:00.000Z'

function spec(overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    pair: 'BTC-USDT',
    assetClass: 'crypto',
    direction: 'LONG',
    timeframe: '1h',
    rules: [],
    invalidationRules: [],
    managementRules: [],
    ...overrides,
  }
}

function snapshot(price: number, candles: WatchCandle[] = [], timeframe = '1h'): WatchSnapshot {
  return { pair: 'BTC-USDT', assetClass: 'crypto', price, timestamp: NOW, timeframe, candles }
}

function state(overrides: Partial<WatchState> = {}): WatchState {
  return { ...initialState(ARMED), ...overrides }
}

function candle(close: number, timestamp: string, timeframe = '1h', confirmed = true): WatchCandle {
  return { timestamp, open: close, high: close, low: close, close, timeframe, confirmed }
}

describe('timeframeSeconds', () => {
  it('parses minute, hour, and day labels', () => {
    expect(timeframeSeconds('1m')).toBe(60)
    expect(timeframeSeconds('15m')).toBe(900)
    expect(timeframeSeconds('4h')).toBe(14_400)
    expect(timeframeSeconds('1d')).toBe(86_400)
  })

  it('accepts common aliases', () => {
    expect(timeframeSeconds('15min')).toBe(900)
    expect(timeframeSeconds('1hour')).toBe(3600)
    expect(timeframeSeconds('daily')).toBe(86_400)
  })

  it('returns 0 for unknown or empty labels', () => {
    expect(timeframeSeconds('')).toBe(0)
    expect(timeframeSeconds('banana')).toBe(0)
    expect(timeframeSeconds('0m')).toBe(0)
  })
})

describe('ruleConditionKey', () => {
  it('prefers an explicit id', () => {
    expect(ruleConditionKey('TRIGGER_HIT', { type: 'price_breaks_level', id: 'breakout' }, 0))
      .toBe('TRIGGER_HIT:breakout')
  })

  it('derives a stable key from a level rule', () => {
    const a = ruleConditionKey('TRIGGER_HIT', { type: 'price_breaks_level', side: 'above', level: 100 }, 0)
    const b = ruleConditionKey('TRIGGER_HIT', { type: 'price_breaks_level', side: 'above', level: 100 }, 7)
    expect(a).toBe(b)
  })

  it('distinguishes candle rules by timeframe and side', () => {
    const key = ruleConditionKey('TRIGGER_HIT', { type: 'candle_close', timeframe: '4h', side: 'below', level: 90 }, 0)
    expect(key).toBe('TRIGGER_HIT:candle_close:4h:below:90')
  })
})

describe('primaryCandleTimeframe', () => {
  it('prefers the first candle_close rule timeframe', () => {
    const s = spec({ timeframe: '1h', rules: [{ type: 'candle_close', timeframe: '4h', side: 'above', level: 1 }] })
    expect(primaryCandleTimeframe(s, snapshot(100))).toBe('4h')
  })

  it('falls back to the spec timeframe', () => {
    expect(primaryCandleTimeframe(spec(), snapshot(100))).toBe('1h')
  })
})

describe('price_breaks_level', () => {
  it('fires when price is at or beyond the level', () => {
    const s = spec({ rules: [{ type: 'price_breaks_level', side: 'above', level: 100 }] })
    const result = evaluateWatch(s, state(), snapshot(105), NOW)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventType).toBe('TRIGGER_HIT')
  })

  it('does not fire below the level', () => {
    const s = spec({ rules: [{ type: 'price_breaks_level', side: 'above', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(99), NOW).events).toHaveLength(0)
  })

  it('defaults the side from a LONG setup to above', () => {
    const s = spec({ direction: 'LONG', rules: [{ type: 'price_breaks_level', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(101), NOW).events).toHaveLength(1)
  })

  it('defaults the side from a SHORT setup to below', () => {
    const s = spec({ direction: 'SHORT', rules: [{ type: 'price_breaks_level', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(99), NOW).events).toHaveLength(1)
  })
})

describe('price_crosses_level', () => {
  it('fires only on the transition across the level', () => {
    const s = spec({ rules: [{ type: 'price_crosses_level', side: 'above', level: 100 }] })
    const armed = state({ lastPrice: 99 })
    expect(evaluateWatch(s, armed, snapshot(101), NOW).events).toHaveLength(1)
  })

  it('does not fire when already above before the tick', () => {
    const s = spec({ rules: [{ type: 'price_crosses_level', side: 'above', level: 100 }] })
    const armed = state({ lastPrice: 101 })
    expect(evaluateWatch(s, armed, snapshot(102), NOW).events).toHaveLength(0)
  })

  it('does not fire without a previous price', () => {
    const s = spec({ rules: [{ type: 'price_crosses_level', side: 'above', level: 100 }] })
    expect(evaluateWatch(s, state({ lastPrice: null }), snapshot(101), NOW).events).toHaveLength(0)
  })
})

describe('price_enters_zone', () => {
  it('fires inside the zone', () => {
    const s = spec({ rules: [{ type: 'price_enters_zone', low: 95, high: 105 }] })
    expect(evaluateWatch(s, state(), snapshot(100), NOW).events).toHaveLength(1)
  })

  it('does not fire outside the zone', () => {
    const s = spec({ rules: [{ type: 'price_enters_zone', low: 95, high: 105 }] })
    expect(evaluateWatch(s, state(), snapshot(110), NOW).events).toHaveLength(0)
  })

  it('normalizes an inverted zone', () => {
    const s = spec({ rules: [{ type: 'price_enters_zone', low: 105, high: 95 }] })
    expect(evaluateWatch(s, state(), snapshot(100), NOW).events).toHaveLength(1)
  })
})

describe('price_approaches_zone', () => {
  it('fires within the default fractional threshold', () => {
    // 0.2% of 100 = 0.2 -> within 0.2 of the zone edge at 95
    const s = spec({ rules: [{ type: 'price_approaches_zone', low: 95, high: 105 }] })
    expect(evaluateWatch(s, state(), snapshot(94.9), NOW).events).toHaveLength(1)
  })

  it('does not fire beyond the threshold', () => {
    const s = spec({ rules: [{ type: 'price_approaches_zone', low: 95, high: 105 }] })
    expect(evaluateWatch(s, state(), snapshot(90), NOW).events).toHaveLength(0)
  })

  it('honours an absolute threshold override', () => {
    const s = spec({ rules: [{ type: 'price_approaches_zone', low: 95, high: 105, threshold: 10 }] })
    expect(evaluateWatch(s, state(), snapshot(85), NOW).events).toHaveLength(1)
  })
})

describe('candle_close', () => {
  it('fires on a confirmed candle closing beyond the level', () => {
    // Armed at 11:00; a 1h candle opening at 11:00 closes at 12:00 (> armed).
    const candles = [candle(101, '2026-09-21T11:00:00.000Z')]
    const s = spec({ rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 100 }] })
    const result = evaluateWatch(s, state(), snapshot(101, candles), NOW)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].conditionKey).toContain('candle_close')
  })

  it('reports the previous close alongside the firing candle', () => {
    const candles = [
      candle(99, '2026-09-21T11:00:00.000Z'),
      candle(101, '2026-09-21T12:00:00.000Z'),
    ]
    const s = spec({ rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 100 }] })
    const result = evaluateWatch(s, state(), snapshot(101, candles), NOW)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].data?.previousClose).toBe(99)
    expect(result.events[0].data?.currentClose).toBe(101)
  })

  it('ignores unconfirmed candles', () => {
    const candles = [candle(101, '2026-09-21T10:00:00.000Z', '1h', false)]
    const s = spec({ rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(101, candles), NOW).events).toHaveLength(0)
  })

  it('ignores candles that closed at or before the arming time', () => {
    // Armed at 11:00; a 1h candle opening at 09:00 closes at 10:00 -> too old.
    const candles = [candle(101, '2026-09-21T09:00:00.000Z')]
    const s = spec({ rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(101, candles), NOW).events).toHaveLength(0)
  })

  it('evaluates a candle that closed after arming', () => {
    const candles = [candle(101, '2026-09-21T11:00:00.000Z')]
    const s = spec({ rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(101, candles), NOW).events).toHaveLength(1)
  })

  it('filters candles by the rule timeframe', () => {
    const candles = [
      candle(101, '2026-09-21T11:00:00.000Z', '15m'),
    ]
    const s = spec({ rules: [{ type: 'candle_close', timeframe: '1h', side: 'above', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(101, candles), NOW).events).toHaveLength(0)
  })
})

describe('invalidation', () => {
  it('fires terminal INVALIDATED and stops', () => {
    const s = spec({ invalidationRules: [{ type: 'price_breaks_level', side: 'below', level: 90 }] })
    const result = evaluateWatch(s, state(), snapshot(89), NOW)
    expect(result.terminal).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventType).toBe('INVALIDATED')
  })

  it('takes precedence over a simultaneous trigger', () => {
    const s = spec({
      rules: [{ type: 'price_breaks_level', side: 'above', level: 80 }],
      invalidationRules: [{ type: 'price_breaks_level', side: 'below', level: 90 }],
    })
    const result = evaluateWatch(s, state(), snapshot(89), NOW)
    expect(result.events[0].eventType).toBe('INVALIDATED')
  })
})

describe('expiry', () => {
  it('fires EXPIRED once past the expiry time', () => {
    const s = spec({ expiry: '2026-09-21T11:30:00.000Z' })
    const result = evaluateWatch(s, state(), snapshot(100), NOW)
    expect(result.terminal).toBe(true)
    expect(result.events[0].eventType).toBe('EXPIRED')
  })

  it('does not fire before the expiry time', () => {
    const s = spec({ expiry: '2026-09-21T13:00:00.000Z' })
    expect(evaluateWatch(s, state(), snapshot(100), NOW).events).toHaveLength(0)
  })
})

describe('management rules', () => {
  it('fires an R-multiple alert from the stored position', () => {
    const s = spec({
      position: { side: 'LONG', entry: 100, stop: 95 },
      managementRules: [{ type: 'r_multiple_reached', multiple: 2 }],
    })
    // risk = 5, 2R = +10 -> price 110
    const result = evaluateWatch(s, state(), snapshot(110), NOW)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventType).toBe('MANAGEMENT_ALERT')
  })

  it('does not fire an R-multiple below the threshold', () => {
    const s = spec({
      position: { side: 'LONG', entry: 100, stop: 95 },
      managementRules: [{ type: 'r_multiple_reached', multiple: 2 }],
    })
    expect(evaluateWatch(s, state(), snapshot(105), NOW).events).toHaveLength(0)
  })

  it('fires an unrealized P&L alert', () => {
    const s = spec({
      position: { side: 'LONG', entry: 100 },
      managementRules: [{ type: 'unrealized_pnl_pct', op: 'below', pct: -5 }],
    })
    expect(evaluateWatch(s, state(), snapshot(94), NOW).events).toHaveLength(1)
  })

  it('does not fire management rules without a position block', () => {
    const s = spec({ managementRules: [{ type: 'unrealized_pnl_pct', op: 'below', pct: -5 }] })
    expect(evaluateWatch(s, state(), snapshot(94), NOW).events).toHaveLength(0)
  })
})

describe('anti-spam', () => {
  it('does not fire the same condition twice', () => {
    const s = spec({ rules: [{ type: 'price_breaks_level', side: 'above', level: 100 }] })
    const first = evaluateWatch(s, state(), snapshot(105), NOW)
    expect(first.events).toHaveLength(1)
    const second = evaluateWatch(s, first.state, snapshot(106), '2026-09-21T12:01:00.000Z')
    expect(second.events).toHaveLength(0)
  })

  it('records the condition in firedConditions', () => {
    const s = spec({ rules: [{ type: 'price_breaks_level', side: 'above', level: 100 }] })
    const result = evaluateWatch(s, state(), snapshot(105), NOW)
    const key = result.events[0].conditionKey
    expect(result.state.firedConditions[key]).toBe(NOW)
  })

  it('honours the cooldown for a distinct rule on the same watcher', () => {
    const s = spec({
      rules: [
        { type: 'price_breaks_level', side: 'above', level: 100 },
        { type: 'price_enters_zone', low: 104, high: 106 },
      ],
    })
    const first = evaluateWatch(s, state(), snapshot(105), NOW)
    expect(first.events).toHaveLength(1)
    const second = evaluateWatch(s, first.state, snapshot(105), '2026-09-21T12:05:00.000Z')
    expect(second.events).toHaveLength(0)
  })
})

describe('state bookkeeping', () => {
  it('records the last price and timestamps', () => {
    const result = evaluateWatch(spec(), state(), snapshot(123), NOW)
    expect(result.state.lastPrice).toBe(123)
    expect(result.state.lastChecked).toBe(NOW)
    expect(result.state.pollCount).toBe(1)
  })

  it('tracks confirmed candles', () => {
    const candles = [
      candle(99, '2026-09-21T09:00:00.000Z'),
      candle(101, '2026-09-21T11:00:00.000Z'),
    ]
    const result = evaluateWatch(spec(), state(), snapshot(101, candles), NOW)
    expect(result.state.lastConfirmedCandle?.close).toBe(101)
    expect(result.state.previousConfirmedCandle?.close).toBe(99)
  })

  it('does not mutate the input state', () => {
    const input = state()
    evaluateWatch(spec({ rules: [{ type: 'price_breaks_level', side: 'above', level: 100 }] }), input, snapshot(105), NOW)
    expect(input.pollCount).toBe(0)
    expect(input.alertedConditions).toEqual({})
  })

  it('uses the default cooldown', () => {
    expect(DEFAULT_EVALUATOR_CONFIG.cooldownSeconds).toBe(900)
  })
})

// Regression: a watcher must not fire when its rules are unusable rather than throw.
describe('malformed rules', () => {
  it('ignores a level rule with no level', () => {
    const s = spec({ rules: [{ type: 'price_breaks_level', side: 'above' }] })
    expect(evaluateWatch(s, state(), snapshot(105), NOW).events).toHaveLength(0)
  })

  it('ignores a zone rule with missing bounds', () => {
    const s = spec({ rules: [{ type: 'price_enters_zone', low: 95 }] })
    expect(evaluateWatch(s, state(), snapshot(100), NOW).events).toHaveLength(0)
  })

  it('ignores a rule with no resolvable side', () => {
    const s = spec({ direction: '', rules: [{ type: 'price_breaks_level', level: 100 }] })
    expect(evaluateWatch(s, state(), snapshot(105), NOW).events).toHaveLength(0)
  })
})
