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
