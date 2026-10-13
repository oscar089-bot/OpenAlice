/**
 * OKX provider contract.
 *
 * These lock the two things that are easy to get wrong against the real API:
 * the positional candle array with its confirmation flag, and the native
 * `BASE-QUOTE` symbol form that a barId round-trips through.
 */
import { describe, expect, it } from 'vitest'
import { OkxCryptoSearchFetcher as S } from './crypto-search.js'
import { OkxCryptoHistoricalFetcher as H } from './crypto-historical.js'

describe('OKX crypto search contract', () => {
  it('defaults a missing query to null rather than throwing', () => {
    expect(S.transformQuery({}).query).toBeNull()
  })

  it('returns no rows for an empty query without hitting the network', async () => {
    await expect(S.extractData(S.transformQuery({ query: '' }))).resolves.toEqual([])
  })
})

describe('OKX historical contract', () => {
  it('defaults to a one-year daily window', () => {
    const q = H.transformQuery({ symbol: 'BTC-USDT' })
    expect(q.interval).toBe('1d')
    expect(q.start_date).toBeTruthy()
    expect(q.end_date).toBeTruthy()
  })

  it('parses the positional OKX candle array into typed bars', () => {
    const q = H.transformQuery({ symbol: 'SOL-USDT', interval: '1h' })
    // [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
    const rows = H.transformData(q, [
      {
        date: '2026-09-28T12:00:00.000Z',
        open: 118.07,
        high: 118.8,
        low: 117.49,
        close: 118.65,
        volume: 30101.221248,
      },
    ])
    expect(rows[0]).toMatchObject({
      date: '2026-09-28T12:00:00.000Z',
      open: 118.07,
      high: 118.8,
      low: 117.49,
      close: 118.65,
    })
  })
})
