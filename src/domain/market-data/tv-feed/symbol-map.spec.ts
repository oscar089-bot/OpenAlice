import { describe, expect, it } from 'vitest'

import { cryptoTvTicker, forexTvTicker, toTvTicker, tvTimeframe, aliceTimeframe } from './symbol-map.js'

describe('tv-feed symbol map', () => {
  describe('cryptoTvTicker', () => {
    it('widens every authored crypto spelling to BINANCE:BASEQUOTE', () => {
      for (const input of ['SOL', 'SOLUSDT', 'SOL/USDT', 'SOL-USDT', 'SOLUSD', 'SOL-USD']) {
        expect(cryptoTvTicker(input)).toBe('BINANCE:SOLUSDT')
      }
    })

    it('preserves a non-dollar quote', () => {
      expect(cryptoTvTicker('BTC-USDC')).toBe('BINANCE:BTCUSDC')
      expect(cryptoTvTicker('ETH-BTC')).toBe('BINANCE:ETHBTC')
    })

    it('strips a source| prefix, so a barId is accepted', () => {
      expect(cryptoTvTicker('okx|SOL-USDT')).toBe('BINANCE:SOLUSDT')
    })

    it('rejects derivatives, which are a different instrument class', () => {
      expect(cryptoTvTicker('BTC/USDT:USDT')).toBeNull()
    })
  })

  describe('forexTvTicker', () => {
    it('accepts every authored forex spelling', () => {
      for (const input of ['EURUSD', 'EUR/USD', 'EURUSD=X', 'eur-usd']) {
        expect(forexTvTicker(input)).toBe('FX:EURUSD')
      }
    })

    it('rejects anything that is not a six-letter pair', () => {
      expect(forexTvTicker('EUR')).toBeNull()
      expect(forexTvTicker('EURUSDX')).toBeNull()
      expect(forexTvTicker('AAPL')).toBeNull()
    })
  })

  describe('toTvTicker', () => {
    it('only serves the two enabled asset classes', () => {
      expect(toTvTicker('SOLUSDT', 'crypto')).toBe('BINANCE:SOLUSDT')
      expect(toTvTicker('EURUSD', 'currency')).toBe('FX:EURUSD')
      expect(toTvTicker('AAPL', 'equity')).toBeNull()
      expect(toTvTicker('GC=F', 'commodity')).toBeNull()
    })
  })

  describe('timeframes', () => {
    it('maps Alice intervals to TradingView resolutions and back', () => {
      expect(tvTimeframe('1m')).toBe('1')
      expect(tvTimeframe('1h')).toBe('60')
      expect(tvTimeframe('4h')).toBe('240')
      expect(tvTimeframe('1d')).toBe('D')
      expect(aliceTimeframe('240')).toBe('4h')
    })

    it('returns null for an interval the feed cannot express', () => {
      expect(tvTimeframe('3m')).toBeNull()
      expect(tvTimeframe('2w')).toBeNull()
    })
  })
})
