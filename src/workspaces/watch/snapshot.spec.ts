/**
 * Watch snapshot provider — the seam that turns an authored `watch:` spec into a
 * federated bar request.
 *
 * Regression focus: the model authored `pair: "yfinance|SOLUSD"` (a barId copied
 * from `market search-bars`) and the provider passed it through as a bare symbol,
 * so the vendor looked up a ticker literally named `yfinance|SOLUSD` and answered
 * "No data found, symbol may be delisted". These tests pin the accepted forms and
 * the crypto routing so that cannot happen again.
 */
import { describe, expect, it, vi } from 'vitest'

import type { BarService } from '../../domain/market-data/bars/types.js'
import type { Logger } from '../logger.js'

import {
  createWatchSnapshotProvider,
  normalizeCryptoNative,
  normalizeCryptoYahoo,
  resolveWatchRef,
} from './snapshot.js'
import type { WatchSpec } from './types.js'

function silentLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLogger() } as unknown as Logger
}

function spec(overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    pair: 'SOL-USDT',
    assetClass: 'crypto',
    direction: '',
    timeframe: '15m',
    rules: [],
    invalidationRules: [],
    managementRules: [],
    ...overrides,
  }
}

describe('normalizeCryptoNative', () => {
  it('maps every authored spelling onto an OKX BASE-QUOTE instrument', () => {
    expect(normalizeCryptoNative('SOL')).toBe('SOL-USDT')
    expect(normalizeCryptoNative('solusdt')).toBe('SOL-USDT')
    expect(normalizeCryptoNative('SOL/USDT')).toBe('SOL-USDT')
    expect(normalizeCryptoNative('SOL_USDT')).toBe('SOL-USDT')
    expect(normalizeCryptoNative('SOL-USDT')).toBe('SOL-USDT')
  })

  it('widens a Yahoo-style trailing USD to the tradable USDT pair', () => {
    // `SOL-USD` is not an OKX spot instrument; `SOL-USDT` is.
    expect(normalizeCryptoNative('SOL-USD')).toBe('SOL-USDT')
    expect(normalizeCryptoNative('SOLUSD')).toBe('SOL-USDT')
  })

  it('preserves a non-USD quote', () => {
    expect(normalizeCryptoNative('BTC-USDC')).toBe('BTC-USDC')
    expect(normalizeCryptoNative('ETH-BTC')).toBe('ETH-BTC')
  })
})

describe('normalizeCryptoYahoo', () => {
  // Yahoo quotes crypto as BASE-USD, the OPPOSITE widening from OKX's BASE-USDT.
  it('maps every authored spelling onto a Yahoo BASE-USD ticker', () => {
    expect(normalizeCryptoYahoo('SOL')).toBe('SOL-USD')
    expect(normalizeCryptoYahoo('solusd')).toBe('SOL-USD')
    expect(normalizeCryptoYahoo('SOL/USD')).toBe('SOL-USD')
    expect(normalizeCryptoYahoo('SOL_USD')).toBe('SOL-USD')
    expect(normalizeCryptoYahoo('SOL-USD')).toBe('SOL-USD')
  })

  it('narrows an exchange USDT pair to the Yahoo USD ticker', () => {
    // The reverse of normalizeCryptoNative: the same underlying pair, named
    // for the venue that is actually being asked.
    expect(normalizeCryptoYahoo('SOL-USDT')).toBe('SOL-USD')
    expect(normalizeCryptoYahoo('SOLUSDT')).toBe('SOL-USD')
  })

  it('preserves a non-dollar quote', () => {
    expect(normalizeCryptoYahoo('BTC-USDC')).toBe('BTC-USDC')
    expect(normalizeCryptoYahoo('ETH-BTC')).toBe('ETH-BTC')
  })
})

describe('resolveWatchRef', () => {
  it('turns a bare crypto symbol into an OKX barId', () => {
    expect(resolveWatchRef(spec({ pair: 'SOL' }))).toEqual({
      barId: 'okx|SOL-USDT',
      assetClass: 'crypto',
    })
  })

  it('honors an explicit yfinance venue for crypto on the Yahoo namespace', () => {
    // The capability this test pins: a crypto watcher CAN be priced from
    // yfinance. Yahoo uses BASE-USD, so the source is kept and the symbol is
    // normalized to that venue rather than retargeted to OKX.
    expect(resolveWatchRef(spec({ pair: 'yfinance|SOLUSD' }))).toEqual({
      barId: 'yfinance|SOL-USD',
      assetClass: 'crypto',
    })
    expect(resolveWatchRef(spec({ pair: 'yfinance|SOL-USD' }))).toEqual({
      barId: 'yfinance|SOL-USD',
      assetClass: 'crypto',
    })
    expect(resolveWatchRef(spec({ pair: 'yfinance|SOL-USDT' }))).toEqual({
      barId: 'yfinance|SOL-USD',
      assetClass: 'crypto',
    })
  })

  it('honors an explicit non-yfinance venue (a broker barId)', () => {
    expect(resolveWatchRef(spec({ pair: 'bybit-main|ETH/USDT:USDT' }))).toEqual({
      barId: 'bybit-main|ETH/USDT:USDT',
      assetClass: 'crypto',
    })
  })

  it('leaves forex on the Yahoo spot form', () => {
    expect(resolveWatchRef(spec({ pair: 'EURUSD=X', assetClass: 'forex' }))).toEqual({
      symbol: 'EURUSD=X',
      assetClass: 'currency',
    })
  })

  it('keeps an explicit source for a non-crypto class', () => {
    expect(resolveWatchRef(spec({ pair: 'eastmoney|1.600519', assetClass: 'equity' }))).toEqual({
      barId: 'eastmoney|1.600519',
      assetClass: 'equity',
    })
  })
})

describe('createWatchSnapshotProvider', () => {
  it('requests the resolved OKX barId for a bare crypto symbol', async () => {
    const getBars = vi.fn(async () => ({
      bars: [{ date: '2026-09-28T16:45:00.000Z', open: 1, high: 1, low: 1, close: 119.15, volume: 10 }],
    }))
    const provider = createWatchSnapshotProvider({
      barService: { getBars } as unknown as BarService,
      logger: silentLogger(),
      now: () => Date.UTC(2026, 8, 28, 16, 50, 0),
    })

    const snapshot = await provider(spec({ pair: 'SOL' }))

    expect(getBars).toHaveBeenCalledWith(
      { barId: 'okx|SOL-USDT', assetClass: 'crypto' },
      { interval: '15m', count: 5 },
    )
    expect(snapshot?.price).toBe(119.15)
    expect(snapshot?.pair).toBe('SOL')
  })

  it('prices a crypto watcher from yfinance when the author pinned it', async () => {
    const getBars = vi.fn(async () => ({
      bars: [{ date: '2026-09-28T16:45:00.000Z', open: 1, high: 1, low: 1, close: 119.15, volume: 10 }],
    }))
    const provider = createWatchSnapshotProvider({
      barService: { getBars } as unknown as BarService,
      logger: silentLogger(),
      now: () => Date.UTC(2026, 8, 28, 16, 50, 0),
    })

    await provider(spec({ pair: 'yfinance|SOLUSD' }))

    // The source is KEPT and the symbol lands on Yahoo's namespace. Before
    // this, the source was silently rewritten to OKX and the author's choice
    // was discarded.
    expect(getBars).toHaveBeenCalledWith(
      { barId: 'yfinance|SOL-USD', assetClass: 'crypto' },
      { interval: '15m', count: 5 },
    )
  })

  it('returns null and logs the resolved barId when the fetch fails', async () => {
    const warn = vi.fn()
    const logger = { ...silentLogger(), warn } as unknown as Logger
    const provider = createWatchSnapshotProvider({
      barService: {
        getBars: vi.fn(async () => {
          throw new Error('No data found, symbol may be delisted')
        }),
      } as unknown as BarService,
      logger,
    })

    await expect(provider(spec({ pair: 'yfinance|SOLUSD' }))).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      'watch.snapshot_failed',
      expect.objectContaining({ pair: 'yfinance|SOLUSD', barId: 'yfinance|SOL-USD' }),
    )
  })

  it('returns null on an empty result rather than throwing', async () => {
    const provider = createWatchSnapshotProvider({
      barService: { getBars: vi.fn(async () => ({ bars: [] })) } as unknown as BarService,
      logger: silentLogger(),
    })
    await expect(provider(spec())).resolves.toBeNull()
  })
})
