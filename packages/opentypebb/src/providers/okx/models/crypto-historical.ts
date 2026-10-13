/**
 * OKX Crypto Historical Price Model.
 *
 * OKX candles are keyless and REST-only. Two properties of the upstream API
 * shape this fetcher and are easy to get wrong:
 *
 *   1. Rows come back NEWEST-FIRST, and each row is a positional array, not an
 *      object. Index 8 is the confirmation flag: `1` = closed candle, `0` =
 *      still forming. Only confirmed rows are emitted, so the newest returned
 *      bar can never be a half-built candle.
 *   2. There is no start/end param. History is walked backwards 300 rows at a
 *      time using `after` = the oldest timestamp fetched so far.
 *
 * Symbols are OKX-native (`BTC-USDT`), which is what crypto search returns, so
 * a `okx|BTC-USDT` barId round-trips without translation.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { CryptoHistoricalQueryParamsSchema, CryptoHistoricalDataSchema } from '../../../standard-models/crypto-historical.js'
import { amakeRequest } from '../../../core/provider/utils/helpers.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'

const OKX_BASE = 'https://www.okx.com/api/v5'

/** OKX caps a candle page at 300 rows. */
const MAX_PER_PAGE = 300

/** Alice bar interval -> OKX `bar` value. OKX uses `H`/`D`/`W` for the
 *  non-minute units, which is the opposite casing from our own intervals. */
const OKX_BAR: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
  '1w': '1W',
}

/** Page budget per interval: a `1m` window is far denser than a weekly one. */
function maxPagesFor(interval: string): number {
  if (interval === '1m' || interval === '5m') return 200
  if (interval === '15m' || interval === '30m') return 50
  return 20
}

const okxEnvelope = z.object({
  code: z.string(),
  msg: z.string().optional().default(''),
  data: z.array(z.array(z.string())).optional().default([]),
})

export const OkxCryptoHistoricalQueryParamsSchema = CryptoHistoricalQueryParamsSchema.extend({
  interval: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']).default('1d'),
})
export type OkxCryptoHistoricalQueryParams = z.infer<typeof OkxCryptoHistoricalQueryParamsSchema>

export const OkxCryptoHistoricalDataSchema = CryptoHistoricalDataSchema
export type OkxCryptoHistoricalData = z.infer<typeof OkxCryptoHistoricalDataSchema>

interface OkxCandle {
  // Index signature so a candle satisfies the fetcher pipeline's
  // `Record<string, unknown>` contract without a cast.
  [key: string]: unknown
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Normalize a user symbol to OKX's `BASE-QUOTE` form. */
function toOkxInstId(raw: string): string {
  const s = raw.trim().toUpperCase()
  if (s.includes('-')) return s
  // BTCUSDT -> BTC-USDT. Only split when the quote tail is a known one;
  // guessing otherwise would mangle legitimately dash-less tickers.
  for (const quote of ['USDT', 'USDC', 'USD', 'BTC', 'ETH']) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return `${s.slice(0, -quote.length)}-${quote}`
    }
  }
  return s
}

async function fetchCandles(instId: string, bar: string, interval: string, startMs: number): Promise<OkxCandle[]> {
  const out: OkxCandle[] = []
  let after: string | undefined
  const maxPages = maxPagesFor(interval)

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ instId, bar, limit: String(MAX_PER_PAGE) })
    if (after) params.set('after', after)
    const payload = await amakeRequest(`${OKX_BASE}/market/candles?${params.toString()}`)
    const parsed = okxEnvelope.parse(payload)
    if (parsed.code !== '0' || parsed.data.length === 0) break

    // [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
    const confirmed = parsed.data.filter((row) => row[8] === '1')
    let oldest = Number.POSITIVE_INFINITY
    for (const row of confirmed) {
      const ts = Number(row[0])
      if (!Number.isFinite(ts)) continue
      oldest = Math.min(oldest, ts)
      const open = Number(row[1])
      const high = Number(row[2])
      const low = Number(row[3])
      const close = Number(row[4])
      const volume = Number(row[5])
      if (![open, high, low, close].every(Number.isFinite)) continue
      out.push({
        date: new Date(ts).toISOString(),
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      })
    }

    // Stop once the oldest fetched candle is at or before the requested start,
    // or the venue returned a short page (end of available history).
    if (!Number.isFinite(oldest) || oldest <= startMs || parsed.data.length < MAX_PER_PAGE) break
    after = String(oldest)
  }

  // API order is newest-first; bars are consumed oldest-first.
  return out.reverse()
}

export class OkxCryptoHistoricalFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): OkxCryptoHistoricalQueryParams {
    const now = new Date()
    if (!params.start_date) {
      const oneYearAgo = new Date(now)
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
      params.start_date = oneYearAgo.toISOString().slice(0, 10)
    }
    if (!params.end_date) params.end_date = now.toISOString().slice(0, 10)
    return OkxCryptoHistoricalQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: OkxCryptoHistoricalQueryParams,
  ): Promise<Record<string, unknown>[]> {
    const bar = OKX_BAR[query.interval] ?? '1D'
    const startMs = Date.parse(`${query.start_date}T00:00:00Z`)
    const endMs = Date.parse(`${query.end_date}T23:59:59Z`)
    const tickers = query.symbol.split(',').map((s) => s.trim()).filter(Boolean)

    const all: Record<string, unknown>[] = []
    const failures: unknown[] = []
    const results = await Promise.allSettled(
      tickers.map((symbol) => fetchCandles(toOkxInstId(symbol), bar, query.interval, startMs)),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value)
      else failures.push(r.reason)
    }

    if (all.length === 0) {
      // Surface the real cause (network/venue error) instead of a bare "no data".
      if (failures.length === results.length && failures.length > 0) throw failures[0]
      throw new EmptyDataError('OKX returned no crypto historical data for the requested window')
    }

    return all.filter((row) => {
      const ts = Date.parse(String(row.date))
      return Number.isFinite(ts) && ts >= startMs && ts <= endMs
    })
  }

  static override transformData(
    _query: OkxCryptoHistoricalQueryParams,
    data: Record<string, unknown>[],
  ): OkxCryptoHistoricalData[] {
    return data.map((d) => OkxCryptoHistoricalDataSchema.parse(d))
  }
}
