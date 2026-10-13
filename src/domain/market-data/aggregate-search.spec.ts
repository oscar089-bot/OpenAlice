import { describe, expect, it, vi } from 'vitest'

import { aggregateSymbolSearch, type MarketSearchDeps } from './aggregate-search.js'

function deps(): MarketSearchDeps {
  return {
    symbolIndex: {
      search: vi.fn(() => [
        { symbol: 'UNRELATED1', name: 'Unrelated One', source: 'sec' },
        { symbol: 'UNRELATED2', name: 'Unrelated Two', source: 'sec' },
        { symbol: 'UNRELATED3', name: 'Unrelated Three', source: 'sec' },
      ]),
    } as never,
    equityVendors: ['yfinance'],
    equityClient: { search: vi.fn(async () => []) } as never,
    cryptoClient: { search: vi.fn(async () => []) } as never,
    currencyClient: {
      search: vi.fn(async () => [
        { symbol: 'EURUSD', name: 'Euro / U.S. Dollar' },
        { symbol: 'EURUSDX', name: 'Euro Index' },
      ]),
    } as never,
    commodityCatalog: { search: vi.fn(() => []) } as never,
  }
}

describe('aggregateSymbolSearch limits', () => {
  it('ranks the full union, then enforces one global result limit', async () => {
    const searchDeps = deps()
    const results = await aggregateSymbolSearch(searchDeps, 'EURUSD', 2)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ symbol: 'EURUSD', assetClass: 'currency' })
    expect(searchDeps.symbolIndex.search).toHaveBeenCalledWith('EURUSD', 2)
    expect(searchDeps.commodityCatalog.search).toHaveBeenCalledWith('EURUSD', 2)
  })
})


it('retains USD-base and cross-currency pairs in discovery', async () => {
  const d = deps()
  vi.mocked(d.currencyClient.search).mockResolvedValue([{ symbol: 'USDJPY' }, { symbol: 'EURGBP' }])
  const results = await aggregateSymbolSearch(d, 'USDJPY', 20)
  expect(results.filter(r => r.assetClass === 'currency').map(r => r.symbol)).toEqual(['USDJPY', 'EURGBP'])
})

// Crypto federation: yfinance knows Yahoo tickers (SOL-USD -> SOLUSD) while an
// exchange vendor like OKX returns native ids (SOL-USDT). Both must survive as
// distinct, vendor-attributed candidates so getBars routes back to the source
// that actually serves the symbol the user asked for.
describe('aggregateSymbolSearch crypto federation', () => {
  it('fans crypto search across every enabled vendor and keeps both namespaces', async () => {
    const d = deps()
    d.cryptoVendors = ['yfinance', 'okx']
    vi.mocked(d.cryptoClient.search).mockImplementation(async (params: Record<string, unknown>) => {
      const p = String(params['provider'] ?? '')
      if (p === 'okx') return [{ symbol: 'SOL-USDT', name: 'SOL / USDT' }] as never
      return [{ symbol: 'SOLUSD', name: 'Solana USD' }] as never
    })

    const results = await aggregateSymbolSearch(d, 'SOL', 20)
    const crypto = results.filter((r) => r.assetClass === 'crypto')

    expect(crypto.map((r) => `${r.sourceId}|${r.symbol}`).sort()).toEqual([
      'okx|SOL-USDT',
      'yfinance|SOLUSD',
    ])
  })

  it('defaults to yfinance alone when cryptoVendors is not configured', async () => {
    const d = deps()
    vi.mocked(d.cryptoClient.search).mockResolvedValue([{ symbol: 'SOLUSD' }] as never)

    await aggregateSymbolSearch(d, 'SOL', 20)

    expect(d.cryptoClient.search).toHaveBeenCalledTimes(1)
    expect(d.cryptoClient.search).toHaveBeenCalledWith({ query: 'SOL', provider: 'yfinance' })
  })
})
