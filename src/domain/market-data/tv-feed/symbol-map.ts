import type { AssetClass } from '../aggregate-search.js'

/**
 * Translate an Alice symbol into a TradingView ticker.
 *
 * Two namespaces collide here and must not be conflated:
 *
 *   Alice / OKX      BASE-QUOTE   SOL-USDT, BTC-USDT
 *   Alice / yfinance BASE-USD     SOL-USD
 *   TradingView      EXCHANGE:TICKER  BINANCE:SOLUSDT, FX:EURUSD
 *
 * TradingView crypto tickers concatenate the pair with no separator and are
 * venue-scoped; forex uses the `FX:` (or `OANDA:`) venue with the 6-letter
 * pair. Getting this wrong makes the subscription silently never produce data,
 * so every form a watcher may author is normalized here rather than at the
 * call site.
 */

/** Timeframes Alice uses → TradingView resolution strings. */
const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
  '1w': 'W',
}

/** Is this interval representable on the live feed? */
export function tvTimeframe(interval: string): string | null {
  return TIMEFRAME_MAP[interval.trim().toLowerCase()] ?? null
}

/** Inverse map, for describing a feed bar in Alice terms. */
export function aliceTimeframe(tvResolution: string): string | null {
  for (const [alice, tv] of Object.entries(TIMEFRAME_MAP)) {
    if (tv === tvResolution) return alice
  }
  return null
}

/** Strip a `source|` prefix if the caller passed a barId. */
function bareSymbol(symbol: string): string {
  const idx = symbol.indexOf('|')
  return (idx >= 0 ? symbol.slice(idx + 1) : symbol).trim()
}

/**
 * Crypto → `BINANCE:BASEQUOTE`.
 *
 * Accepts `SOL`, `SOLUSDT`, `SOL/USDT`, `SOL-USDT`, `SOL-USD`, `SOLUSD`.
 * `USD` is widened to `USDT` because the venue quotes USDT pairs — the same
 * widening the OKX path performs, so both venues describe one market.
 */
export function cryptoTvTicker(symbol: string): string | null {
  const raw = bareSymbol(symbol).toUpperCase().replace(/[/_\s]/g, '-')
  if (!raw) return null
  // Derivatives (`BTC/USDT:USDT`) are a different instrument class.
  if (raw.includes(':')) return null

  let base: string
  let quote: string

  if (raw.includes('-')) {
    const parts = raw.split('-')
    if (parts.length !== 2) return null
    ;[base, quote] = parts
  } else {
    const quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'USD']
    const found = quotes.find((q) => raw.endsWith(q) && raw.length > q.length)
    if (found) {
      base = raw.slice(0, -found.length)
      quote = found
    } else {
      base = raw
      quote = 'USDT'
    }
  }

  if (!base || !quote) return null
  // A venue ticker has no separator: SOL-USDT -> SOLUSDT.
  const normalizedQuote = quote === 'USD' ? 'USDT' : quote
  return `BINANCE:${base}${normalizedQuote}`
}

/**
 * Forex → `FX:EURUSD`.
 *
 * Accepts `EURUSD`, `EUR/USD`, `EURUSD=X`, `EUR-USD`.
 */
export function forexTvTicker(symbol: string): string | null {
  const raw = bareSymbol(symbol).toUpperCase().replace(/[/_\s-]/g, '')
  const pair = raw.endsWith('=X') ? raw.slice(0, -2) : raw
  if (!/^[A-Z]{6}$/.test(pair)) return null
  return `FX:${pair}`
}

/**
 * Resolve an authored symbol to a TradingView ticker for one asset class.
 *
 * Returns null when the class is not served by the live feed (equity,
 * commodity, index) or the symbol cannot be expressed as a TV ticker. A null
 * result is NOT an error: the caller falls back to the federated bar layer.
 */
export function toTvTicker(symbol: string, assetClass: AssetClass): string | null {
  switch (assetClass) {
    case 'crypto': return cryptoTvTicker(symbol)
    case 'currency': return forexTvTicker(symbol)
    default: return null
  }
}

/** Inverse: a TV ticker back to an Alice-native symbol, for logging/display. */
export function fromTvTicker(ticker: string): { symbol: string; assetClass: AssetClass } | null {
  const idx = ticker.indexOf(':')
  if (idx <= 0) return null
  const venue = ticker.slice(0, idx).toUpperCase()
  const native = ticker.slice(idx + 1).toUpperCase()
  if (venue === 'FX' || venue === 'OANDA' || venue === 'FX_IDC') {
    return { symbol: native, assetClass: 'currency' }
  }
  if (/^[A-Z0-9]+$/.test(native)) {
    return { symbol: native, assetClass: 'crypto' }
  }
  return null
}
