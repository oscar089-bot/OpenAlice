import { describe, expect, it } from 'vitest'

import { watchSpecSchema } from './schema.js'

/**
 * A plain `z.object` silently STRIPS unknown keys. Before `meta` existed, a
 * model that wrote `grade` / `phase` into its watch block got `{ ok: true }`
 * back and the board showed nothing — the keys were parsed and discarded.
 * These tests exist so that class of bug cannot return silently.
 */
describe('watchSpecSchema meta', () => {
  const base = {
    pair: 'BTC-USDT',
    timeframe: '1h',
    rules: [{ type: 'candle_close', side: 'above', level: 110_000, timeframe: '1h' }],
  }

  it('keeps the presentation meta block through a parse', () => {
    const parsed = watchSpecSchema.parse({
      ...base,
      meta: {
        grade: 'A+',
        phase: 'reclaim',
        nextStep: 'Re-check volume.',
        waitingTrigger: 'BTC closes a 1h candle above 110k',
        invalidationConditions: ['BTC loses 98k on a 1h close'],
      },
    })
    expect(parsed.meta).toEqual({
      grade: 'A+',
      phase: 'reclaim',
      nextStep: 'Re-check volume.',
      waitingTrigger: 'BTC closes a 1h candle above 110k',
      invalidationConditions: ['BTC loses 98k on a 1h close'],
    })
  })

  it('accepts a numeric rating', () => {
    expect(watchSpecSchema.parse({ ...base, meta: { rating: 9 } }).meta?.rating).toBe(9)
  })

  it('leaves meta absent when the model did not write one', () => {
    expect(watchSpecSchema.parse(base).meta).toBeUndefined()
  })
})

/**
 * The pair guard.
 *
 * Crypto has TWO priceable venues, so every authored spelling is now valid —
 * bare symbols and `okx|…` route to the exchange feed, while an explicit
 * `yfinance|…` is honored on Yahoo's namespace. This guard used to REJECT
 * `yfinance|SOLUSD` because the resolver silently retargeted it to OKX, which
 * discarded the author's intent and made yfinance unreachable for crypto.
 */
describe('watchSpecSchema pair guard', () => {
  const base = {
    timeframe: '15m',
    rules: [{ type: 'candle_close', side: 'above', level: 200, timeframe: '15m' }],
  }

  it('accepts an explicit yfinance crypto pair', () => {
    // The form that used to be rejected. Both venues are legitimate now.
    expect(watchSpecSchema.safeParse({ ...base, pair: 'yfinance|SOLUSD' }).success).toBe(true)
    expect(watchSpecSchema.safeParse({ ...base, pair: 'yfinance|SOL-USD' }).success).toBe(true)
  })

  it('accepts every spelling that normalizes to a venue-native pair', () => {
    for (const pair of ['SOL', 'SOLUSDT', 'sol/usdt', 'SOL-USD', 'SOL-USDT']) {
      expect(watchSpecSchema.safeParse({ ...base, pair }).success, pair).toBe(true)
    }
  })

  it('accepts an explicit crypto venue', () => {
    expect(watchSpecSchema.safeParse({ ...base, pair: 'okx|SOL-USDT' }).success).toBe(true)
    expect(watchSpecSchema.safeParse({ ...base, pair: 'bybit-main|ETH/USDT:USDT' }).success).toBe(true)
  })

  it('rejects a barId for forex and explains the spot form', () => {
    const result = watchSpecSchema.safeParse({
      ...base,
      pair: 'yfinance|EURUSD=X',
      assetClass: 'forex',
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.find((i) => i.path.join('.') === 'pair')?.message).toContain('EURUSD')
  })

  it('rejects a non-pair forex symbol', () => {
    const result = watchSpecSchema.safeParse({ ...base, pair: 'EUR', assetClass: 'forex' })
    expect(result.success).toBe(false)
  })

  it('accepts forex spot forms', () => {
    for (const pair of ['EURUSD', 'EUR/USD', 'EURUSD=X']) {
      expect(watchSpecSchema.safeParse({ ...base, pair, assetClass: 'forex' }).success, pair).toBe(true)
    }
  })

  it('leaves an equity source barId alone', () => {
    expect(
      watchSpecSchema.safeParse({ ...base, pair: 'eastmoney|1.600519', assetClass: 'equity' }).success,
    ).toBe(true)
  })
})
