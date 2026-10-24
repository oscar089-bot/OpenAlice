import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import type { TvFeedConfig } from '../../../core/config.js'
import type { Logger } from '../../../workspaces/logger.js'
import { TvFeedClient } from './client.js'

/** Silent logger: these specs assert behaviour, not log output. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  event: () => {},
  child: () => silentLogger,
} as unknown as Logger

const baseConfig: TvFeedConfig = {
  enabled: true,
  autoStart: false,
  url: '',
  bindHost: '127.0.0.1',
  assetClasses: ['crypto', 'forex'],
  staleMs: 5_000,
  subscribeTimeoutMs: 1_000,
}

/** Start a throwaway feed server that records subscriptions. */
async function startFeed(
  onSubscribe?: (ws: import('ws').WebSocket, symbol: string, timeframe: string) => void,
): Promise<{
  url: string
  subscribed: Array<{ symbol: string; timeframe: string }>
  /** Wait for the first client socket, then hand it back for raw sends. */
  firstSocket: () => Promise<import('ws').WebSocket>
  close: () => Promise<void>
}> {
  const wss = new WebSocketServer({ port: 0 })
  const subscribed: Array<{ symbol: string; timeframe: string }> = []
  const sockets = new Set<import('ws').WebSocket>()
  let resolveFirst: ((ws: import('ws').WebSocket) => void) | null = null

  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    resolveFirst?.(ws)
    resolveFirst = null
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { action?: string; symbol?: string; timeframe?: string }
      if (msg.action !== 'subscribe' || !msg.symbol || !msg.timeframe) return
      subscribed.push({ symbol: msg.symbol, timeframe: msg.timeframe })
      onSubscribe?.(ws, msg.symbol, msg.timeframe)
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: `ws://127.0.0.1:${port}`,
    subscribed,
    firstSocket: () => new Promise<import('ws').WebSocket>((resolve) => {
      const existing = [...sockets][0]
      if (existing) return resolve(existing)
      resolveFirst = resolve
    }),
    // `wss.close()` alone waits for every accepted socket to end, and the
    // client under test holds one open. Terminate them first so teardown is
    // deterministic instead of racing the test timeout.
    close: () => new Promise<void>((resolve) => {
      for (const ws of sockets) ws.terminate()
      wss.close(() => resolve())
    }),
  }
}

function bar(symbol: string, timeframe: string, close: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'bar',
    bar: {
      symbol,
      timeframe,
      time: 1_700_000_000,
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 10,
      closed: false,
      ...extra,
    },
  }
}

let active: TvFeedClient | null = null

afterEach(() => {
  active?.close()
  active = null
})

describe('TvFeedClient', () => {
  it('returns null when the interval is not representable', async () => {
    const feed = await startFeed()
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    expect(await client.getQuote('BINANCE:BTCUSDT', '3m')).toBeNull()
    await feed.close()
  })

  it('waits for the socket to open instead of failing the first call', async () => {
    const feed = await startFeed((ws, symbol, timeframe) => {
      ws.send(JSON.stringify(bar(symbol, timeframe, 42)))
    })
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    // No artificial delay: connect() was called but the handshake has not
    // necessarily completed. This used to return null.
    const quote = await client.getQuote('BINANCE:BTCUSDT', '1m')
    expect(quote?.close).toBe(42)
    await feed.close()
  })

  it('subscribes on demand and maps the Alice interval to a TV resolution', async () => {
    const feed = await startFeed((ws, symbol, timeframe) => {
      ws.send(JSON.stringify(bar(symbol, timeframe, 100)))
    })
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    await client.getQuote('BINANCE:ETHUSDT', '4h')
    expect(feed.subscribed).toContainEqual({ symbol: 'BINANCE:ETHUSDT', timeframe: '240' })
    await feed.close()
  })

  it('reports a quote as stale once it ages past staleMs', async () => {
    const feed = await startFeed((ws, symbol, timeframe) => {
      ws.send(JSON.stringify(bar(symbol, timeframe, 7)))
    })
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    expect((await client.getQuote('BINANCE:BTCUSDT', '1m'))?.close).toBe(7)
    // Same cached bar, evaluated well past the freshness window.
    const later = Date.now() + 60_000
    expect(await client.getQuote('BINANCE:BTCUSDT', '1m', later)).toBeNull()
    await feed.close()
  })

  it('ignores an out-of-order bar for an older candle', async () => {
    const feed = await startFeed()
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    const socket = await feed.firstSocket()
    socket.send(JSON.stringify(bar('BINANCE:BTCUSDT', '1', 10, { time: 1_700_000_060 })))
    socket.send(JSON.stringify(bar('BINANCE:BTCUSDT', '1', 99, { time: 1_700_000_000 })))

    // Give the client a moment to process both frames.
    await new Promise((r) => setTimeout(r, 100))
    const quote = await client.getQuote('BINANCE:BTCUSDT', '1m')
    expect(quote?.close).toBe(10)
    await feed.close()
  })

  // The regression that made candle_close unusable. On a period rollover the
  // service broadcasts the NEW forming candle first and the closed one right
  // after, so a single-slot cache discarded the close as "out of order".
  it('keeps a closed candle that arrives after the next forming candle', async () => {
    const feed = await startFeed()
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    const socket = await feed.firstSocket()
    // The new period starts...
    socket.send(JSON.stringify(bar('BINANCE:BTCUSDT', '1', 50, { time: 1_700_000_060 })))
    // ...then the previous period is finalised, with an OLDER timestamp.
    socket.send(JSON.stringify(bar('BINANCE:BTCUSDT', '1', 42, {
      time: 1_700_000_000,
      closed: true,
    })))

    await new Promise((r) => setTimeout(r, 100))
    const quote = await client.getQuote('BINANCE:BTCUSDT', '1m')

    // The live tail is still the new period.
    expect(quote?.close).toBe(50)
    expect(quote?.closed).toBe(false)
    // ...and the finalised candle survived alongside it.
    expect(quote?.lastClosed?.close).toBe(42)
    expect(quote?.lastClosed?.timeMs).toBe(1_700_000_000_000)
    await feed.close()
  })

  it('drops a closed candle that is already stale', async () => {
    const feed = await startFeed()
    const client = new TvFeedClient({ ...baseConfig, url: feed.url }, silentLogger)
    active = client
    client.connect()

    const socket = await feed.firstSocket()
    socket.send(JSON.stringify(bar('BINANCE:BTCUSDT', '1', 50, { time: 1_700_000_060 })))
    socket.send(JSON.stringify(bar('BINANCE:BTCUSDT', '1', 42, {
      time: 1_700_000_000,
      closed: true,
    })))

    await new Promise((r) => setTimeout(r, 100))
    // Evaluated well past the freshness window: an ancient close must not let a
    // candle_close rule fire on a period the operator already moved past.
    const later = Date.now() + 60_000
    const quote = await client.getQuote('BINANCE:BTCUSDT', '1m', later)
    expect(quote?.lastClosed).toBeUndefined()
    await feed.close()
  })

  it('returns null (never throws) when nothing is listening', async () => {
    const client = new TvFeedClient({ ...baseConfig, url: 'ws://127.0.0.1:1', subscribeTimeoutMs: 200 }, silentLogger)
    active = client
    client.connect()

    expect(await client.getQuote('BINANCE:BTCUSDT', '1m')).toBeNull()
  })
})
