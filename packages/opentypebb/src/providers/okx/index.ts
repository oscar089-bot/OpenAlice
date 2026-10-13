/**
 * OKX Provider Module.
 *
 * Keyless spot crypto market data. OKX's public v5 market endpoints need no
 * API key, so this provider declares no credentials and every fetcher runs
 * `requireCredentials = false`.
 *
 * It declares `vendorMeta`, which is what opts it into the user-facing vendor
 * picker (`alice market vendors`) and lets `searchBars` return `okx|BTC-USDT`
 * candidates alongside yfinance.
 */

import { Provider } from '../../core/provider/abstract/provider.js'
import { OkxCryptoSearchFetcher } from './models/crypto-search.js'
import { OkxCryptoHistoricalFetcher } from './models/crypto-historical.js'

export const okxProvider = new Provider({
  name: 'okx',
  website: 'https://www.okx.com',
  description:
    'OKX is a global crypto exchange whose public v5 market-data API serves ' +
    'spot candles without an API key.',
  vendorMeta: {
    coverage: 'Crypto spot pairs listed on OKX (BTC-USDT, ETH-USDT, SOL-USDT, …).',
    howToUse:
      'Symbols are OKX instrument IDs: BASE-QUOTE with a hyphen (BTC-USDT, SOL-USDT). ' +
      'Search accepts a pair (BTCUSDT), a base asset (SOL), or an OKX id (SOL-USDT) and ' +
      'returns USDT-quoted pairs first. This is the keyless source for exchange-native ' +
      'crypto symbols with real exchange volume; yfinance uses Yahoo tickers (SOL-USD) ' +
      'instead, which are a different symbol namespace.',
  },
  fetcherDict: {
    CryptoSearch: OkxCryptoSearchFetcher,
    CryptoHistorical: OkxCryptoHistoricalFetcher,
  },
})
