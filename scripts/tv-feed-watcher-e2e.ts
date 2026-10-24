import { TvFeedSupervisor, TvFeedClient } from '../src/domain/market-data/tv-feed/index.js'
import type { TvFeedConfig } from '../src/core/config.js'
import { logger } from '../src/workspaces/logger.js'
import { createWatchSnapshotProvider } from '../src/workspaces/watch/snapshot.js'
import { evaluateWatch, initialState } from '../src/workspaces/watch/evaluator.js'
import type { WatchSpec } from '../src/workspaces/watch/types.js'
import type { BarService } from '../src/domain/market-data/bars/types.js'

/**
 * End-to-end watcher acceptance against a REAL TradingView feed.
 *
 * This is the test that matters: it exercises the same supervisor, client,
 * snapshot provider and evaluator the live WatchLoop uses. The critical
 * assertion is that a 1m `candle_close` inside a 1h watcher receives 1m
 * candles and fires on a 1m close — not silently starved of data, and not
 * firing on the watcher's own 1h timeframe.
 */

const config: TvFeedConfig = {
  enabled: true,
  autoStart: true,
  url: 'ws://127.0.0.1:8095',
  bindHost: '127.0.0.1',
  assetClasses: ['crypto', 'forex'],
  staleMs: 15_000,
  subscribeTimeoutMs: 20_000,
}

const supervisor = new TvFeedSupervisor(config, logger.child({ scope: 'e2e-sup' }))
supervisor.start()
await new Promise((r) => setTimeout(r, 8_000))
console.log('feed running =', supervisor.running)

const client = new TvFeedClient(config, logger.child({ scope: 'e2e-client' }))
client.connect()

// History is intentionally empty: this proves the LIVE path alone can feed a
// candle_close rule, which is the whole point of the TV integration.
const emptyHistory: BarService = {
  searchBarSources: async () => [],
  getBars: async () => ({ bars: [], meta: {} as never }),
} as unknown as BarService

const provider = createWatchSnapshotProvider({
  barService: emptyHistory,
  logger: logger.child({ scope: 'e2e-snap' }),
  tvFeed: client,
  tvFeedAssetClasses: ['crypto'],
})

// A 1h watcher whose trigger is a 1m close. The level is set absurdly low so
// the very next 1m close breaches it — we are testing the plumbing, not edge.
const spec: WatchSpec = {
  pair: 'BTC-USDT',
  assetClass: 'crypto',
  direction: 'LONG',
  timeframe: '1h',
  rules: [
    { type: 'candle_close', timeframe: '1m', side: 'above', level: 1 },
  ],
  invalidationRules: [],
  managementRules: [],
} as WatchSpec

const state = initialState(new Date(Date.now() - 60_000).toISOString())

console.log('waiting for a live 1m close on a 1h watcher...')
const deadline = Date.now() + 4 * 60_000
let fired = false
let lastCandleTf: string | null = null

while (Date.now() < deadline && !fired) {
  const snapshot = await provider(spec)
  if (!snapshot) {
    console.log('  no snapshot yet, retrying')
    await new Promise((r) => setTimeout(r, 3_000))
    continue
  }

  const tfs = new Set((snapshot.candles ?? []).map((c) => c.timeframe))
  const confirmedRuleTf = (snapshot.candles ?? []).filter(
    (c) => c.timeframe === '1m' && c.confirmed === true,
  )
  console.log(
    `  price=${snapshot.price} intervals=[${[...tfs].join(',')}] ` +
    `confirmed1m=${confirmedRuleTf.length}`,
  )

  const result = evaluateWatch(spec, state, snapshot, new Date().toISOString())
  if (result.events.length > 0) {
    for (const event of result.events) {
      const data = (event as {
        data?: { timeframe?: string; currentCandle?: { timeframe?: string } }
      }).data
      lastCandleTf = data?.currentCandle?.timeframe ?? data?.timeframe ?? null
      console.log(
        `FIRED ${event.eventType} :: ${event.message} ` +
        `[eventTf=${data?.timeframe} candleTf=${data?.currentCandle?.timeframe}]`,
      )
    }
    fired = true
    break
  }

  await new Promise((r) => setTimeout(r, 5_000))
}

console.log('---')
console.log('fired =', fired)
console.log('candle timeframe that fired =', lastCandleTf)

const pass = fired && lastCandleTf === '1m'
console.log(pass ? 'WATCHER E2E PASS' : 'WATCHER E2E FAIL')

client.close()
supervisor.stop()
process.exit(pass ? 0 : 1)
