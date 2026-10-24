import { TvFeedSupervisor, TvFeedClient } from '../src/domain/market-data/tv-feed/index.js'
import type { TvFeedConfig } from '../src/core/config.js'
import { logger } from '../src/workspaces/logger.js'

const config: TvFeedConfig = {
  enabled: true,
  autoStart: true,
  url: 'ws://127.0.0.1:8091',
  assetClasses: ['crypto', 'forex'],
  staleMs: 10_000,
  subscribeTimeoutMs: 20_000,
}

const supervisor = new TvFeedSupervisor(config, logger.child({ scope: 'tv-sup' }))
supervisor.start()
console.log('supervisor.start() called, running =', supervisor.running)

// Give the child time to boot, then connect exactly as Alice does.
await new Promise((r) => setTimeout(r, 8_000))
console.log('after wait, running =', supervisor.running)

const client = new TvFeedClient(config, logger.child({ scope: 'tv-client' }))
client.connect()

let failures = 0
for (const [ticker, interval] of [['BINANCE:BTCUSDT', '1m'], ['FX:EURUSD', '1m']] as const) {
  const quote = await client.getQuote(ticker, interval)
  if (quote) {
    console.log(`OK ${ticker} ${interval} close=${quote.close} closed=${quote.closed}`)
  } else {
    console.log(`FAIL ${ticker} ${interval}`)
    failures++
  }
}

client.close()
supervisor.stop()
console.log(failures === 0 ? 'SUPERVISOR SMOKE PASS' : 'SUPERVISOR SMOKE FAIL')
process.exit(failures === 0 ? 0 : 1)
