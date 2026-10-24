import { TvFeedClient } from '../src/domain/market-data/tv-feed/index.js'
import type { TvFeedConfig } from '../src/core/config.js'
import { logger } from '../src/workspaces/logger.js'

const config: TvFeedConfig = {
  enabled: true,
  url: process.env['TV_URL'] ?? 'ws://127.0.0.1:8081',
  assetClasses: ['crypto', 'forex'],
  staleMs: 10_000,
  subscribeTimeoutMs: 15_000,
}

const client = new TvFeedClient(config, logger.child({ scope: 'tv-smoke' }))
client.connect()

const cases: Array<{ ticker: string; interval: string }> = [
  { ticker: 'BINANCE:BTCUSDT', interval: '1m' },
  { ticker: 'BINANCE:ETHUSDT', interval: '5m' },
  { ticker: 'FX:EURUSD', interval: '1m' },
]

let failures = 0
for (const c of cases) {
  const quote = await client.getQuote(c.ticker, c.interval)
  if (!quote) {
    console.log(`FAIL ${c.ticker} ${c.interval} -> no quote`)
    failures++
  } else {
    console.log(
      `OK   ${c.ticker} ${c.interval} close=${quote.close} ` +
      `barTime=${new Date(quote.timeMs).toISOString()} closed=${quote.closed}`,
    )
  }
}

client.close()
console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
