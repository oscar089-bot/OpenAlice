/**
 * OKX Crypto Search Model.
 *
 * OKX has no free-text search endpoint, so this lists the SPOT instrument
 * catalogue (one unauthenticated call) and filters it locally. Symbols are
 * returned in OKX native form (`BTC-USDT`), which is exactly what the
 * historical fetcher consumes, so a search hit round-trips as a barId
 * `okx|BTC-USDT`.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { CryptoSearchQueryParamsSchema, CryptoSearchDataSchema } from '../../../standard-models/crypto-search.js'
import { amakeRequest } from '../../../core/provider/utils/helpers.js'

const OKX_BASE = 'https://www.okx.com/api/v5'

/** Envelope every OKX v5 endpoint returns. `code: "0"` means success. */
const okxEnvelope = z.object({
  code: z.string(),
  msg: z.string().optional().default(''),
  data: z.array(z.unknown()).optional().default([]),
})

const okxInstrument = z.object({
  instId: z.string(),
  baseCcy: z.string().optional().default(''),
  quoteCcy: z.string().optional().default(''),
  state: z.string().optional().default(''),
}).passthrough()

export const OkxCryptoSearchQueryParamsSchema = CryptoSearchQueryParamsSchema
export type OkxCryptoSearchQueryParams = z.infer<typeof OkxCryptoSearchQueryParamsSchema>

export const OkxCryptoSearchDataSchema = CryptoSearchDataSchema.extend({
  exchange: z.string().nullable().default('OKX').describe('The exchange the crypto trades on.'),
}).passthrough()
export type OkxCryptoSearchData = z.infer<typeof OkxCryptoSearchDataSchema>

/** Cache the instrument catalogue briefly: it changes rarely and is large. */
let catalogueCache: { at: number; rows: Array<{ instId: string; base: string; quote: string }> } | null = null
const CATALOGUE_TTL_MS = 5 * 60_000

async function loadCatalogue(): Promise<Array<{ instId: string; base: string; quote: string }>> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.rows
  const payload = await amakeRequest(`${OKX_BASE}/public/instruments?instType=SPOT`)
  const parsed = okxEnvelope.parse(payload)
  const rows = parsed.data
    .map((row) => okxInstrument.safeParse(row))
    .filter((r): r is z.SafeParseSuccess<z.infer<typeof okxInstrument>> => r.success)
    .map((r) => r.data)
    .filter((i) => i.state === '' || i.state === 'live')
    .map((i) => ({ instId: i.instId, base: i.baseCcy, quote: i.quoteCcy }))
  catalogueCache = { at: Date.now(), rows }
  return rows
}

export class OkxCryptoSearchFetcher extends Fetcher {
  // OKX public market data needs no API key.
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): OkxCryptoSearchQueryParams {
    return OkxCryptoSearchQueryParamsSchema.parse(params)
  }

  static override async extractData(
    query: OkxCryptoSearchQueryParams,
  ): Promise<Record<string, unknown>[]> {
    if (!query.query) return []
    const needle = query.query.trim().toUpperCase().replace(/[/\s_-]/g, '')
    if (!needle) return []

    const catalogue = await loadCatalogue()
    const hits: Record<string, unknown>[] = []
    for (const inst of catalogue) {
      const flat = inst.instId.replace('-', '').toUpperCase()
      // Match either the full pair (BTCUSDT) or the base asset (BTC).
      if (!flat.includes(needle) && !inst.base.toUpperCase().includes(needle)) continue
      // Prefer USDT-quoted pairs first: they are the liquid venue for a symbol.
      hits.push({
        symbol: inst.instId,
        name: `${inst.base} / ${inst.quote}`,
        exchange: 'OKX',
        _rank: inst.quote === 'USDT' ? 0 : 1,
      })
    }

    hits.sort((a, b) => (a._rank as number) - (b._rank as number))
    // A broad query (e.g. "USD") must not return the whole exchange.
    return hits.slice(0, 50).map(({ _rank, ...rest }) => rest)
  }

  static override transformData(
    _query: OkxCryptoSearchQueryParams,
    data: Record<string, unknown>[],
  ): OkxCryptoSearchData[] {
    return data.map((d) => OkxCryptoSearchDataSchema.parse(d))
  }
}
