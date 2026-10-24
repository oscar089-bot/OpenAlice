import { TvFeedSupervisor } from '../src/domain/market-data/tv-feed/index.js'
import type { TvFeedConfig } from '../src/core/config.js'
import { logger } from '../src/workspaces/logger.js'
import WebSocket from 'ws'

const config: TvFeedConfig = {
  enabled: true,
  autoStart: true,
  url: 'ws://127.0.0.1:8092',
  assetClasses: ['crypto', 'forex'],
  staleMs: 10_000,
  subscribeTimeoutMs: 20_000,
}

const supervisor = new TvFeedSupervisor(config, logger.child({ scope: 'tv-closed' }))
supervisor.start()
await new Promise((r) => setTimeout(r, 6_000))

let closedSeen = 0
let formingSeen = 0

await new Promise<void>((resolve) => {
  const ws = new WebSocket(config.url)
  const done = () => { try { ws.close() } catch {} ; resolve() }
  const timer = setTimeout(done, 95_000)
  ws.on('open', () => {
    ws.send(JSON.stringify({ action: 'subscribe', symbol: 'BINANCE:BTCUSDT', timeframe: '1' }))
  })
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { type?: string; bar?: { closed?: boolean; time?: number } }
    if (msg.type !== 'bar' || !msg.bar) return
    if (msg.bar.closed === true) {
      closedSeen++
      console.log(`CLOSED bar at ${new Date((msg.bar.time ?? 0) * 1000).toISOString()}`)
      clearTimeout(timer)
      done()
    } else {
      formingSeen++
    }
  })
})

supervisor.stop()
console.log(`forming frames=${formingSeen} closed frames=${closedSeen}`)
console.log(closedSeen > 0 ? 'CLOSED BAR PASS' : 'CLOSED BAR FAIL')
process.exit(closedSeen > 0 ? 0 : 1)
