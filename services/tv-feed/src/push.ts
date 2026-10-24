import axios from 'axios';
import { config } from './config';
import { logger } from './logger';
import { barsPushedTotal, barsDroppedTotal, httpPushLatency, pushQueueDepth } from './metrics';
import type { Bar } from './tradingview';
import type { WebSocketServer } from './websocket';
import { TradingViewClient } from './tradingview';

// Optional WebSocket server
let wsServer: WebSocketServer | null = null;

// TradingViewClient singleton
let tvClient: TradingViewClient | null = null;

// Bars waiting to be POSTed to the backend, oldest first.
// A single worker drains it, so ordering is preserved and the number of
// concurrent HTTP requests is bounded at one regardless of backend latency.
const pushQueue: Bar[] = [];
let workerRunning = false;

// Set WebSocket server
export function setWebSocketServer(server: WebSocketServer) {
  wsServer = server;
  logger.info('WebSocket server set for push service');
}

export function setTradingViewClient(client: TradingViewClient) {
  tvClient = client;
  logger.info('TradingView client set for push service');
}

export function getTradingViewClient(): TradingViewClient | null {
  return tvClient;
}

// Function to push a bar to API and WebSocket clients
//
// WebSocket broadcast happens synchronously (it is cheap and must stay real-time).
// HTTP delivery is enqueued and drained by a single worker so that a slow backend
// cannot build up unbounded concurrent requests, and so ordering is preserved.
export async function pushBar(bar: Bar) {
  // If WebSocket server is set, broadcast bar to clients
  if (wsServer) {
    wsServer.broadcastBar(bar);
  }

  // By default only final bars go to the backend: a tick describes the still
  // forming candle, and posting every tick would send many progressively
  // updated versions of the same (symbol, timeframe, time) row.
  if (config.backend.retry.closedBarsOnly) {
    return;
  }

  enqueueBackendPush(bar);
}

// Push a final (closed) bar to the backend and to WebSocket clients.
//
// The last tick a client saw for this candle carried `closed: false`, so
// rebroadcasting here is REQUIRED: it is the only frame that tells a consumer
// the candle is final. Without it a rule like "fire on candle close" can never
// evaluate a confirmed bar from the live feed.
export async function pushClosedBar(bar: Bar) {
  if (wsServer) {
    wsServer.broadcastBar({ ...bar, closed: true });
  }
  enqueueBackendPush(bar);
}

function enqueueBackendPush(bar: Bar): void {
  // If backend endpoint is not configured, do not push via HTTP
  if (!config.backend.endpoint) {
    return;
  }

  const limit = Math.max(1, config.backend.retry.queueLimit);
  if (pushQueue.length >= limit) {
    // Backend cannot keep up: shed the oldest bar rather than growing forever.
    pushQueue.shift();
    barsDroppedTotal.inc();
    logger.warn('Push queue full (%d), dropped oldest bar', limit);
  }

  pushQueue.push(bar);
  pushQueueDepth.set(pushQueue.length);
  void drainPushQueue();
}

// Single worker: processes one bar at a time, in order.
async function drainPushQueue(): Promise<void> {
  if (workerRunning) {
    return;
  }

  workerRunning = true;
  try {
    while (pushQueue.length > 0 && config.backend.endpoint) {
      const bar = pushQueue.shift() as Bar;
      pushQueueDepth.set(pushQueue.length);
      await pushBarWithRetry(bar);
    }
  } finally {
    workerRunning = false;
    pushQueueDepth.set(pushQueue.length);
  }
}

async function pushBarWithRetry(bar: Bar): Promise<void> {
  const payload = {
    symbol: bar.symbol,
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    timeframe: bar.timeframe,
    // true for a final bar, false while the candle is still forming.
    closed: bar.closed === true,
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': config.backend.apiKey,
  };

  const maxAttempts = Math.max(1, config.backend.retry.attempts);
  const backoffMs = Math.max(0, config.backend.retry.backoffMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const end = httpPushLatency.startTimer();
    try {
      await axios.post(config.backend.endpoint, payload, { headers });
      barsPushedTotal.inc();
      logger.debug('Pushed bar: %o', payload);
      end();
      return;
    } catch (err) {
      end();
      logger.error('Failed to push bar (attempt %d/%d): %s', attempt, maxAttempts, (err as Error).message);
      if (attempt < maxAttempts && backoffMs > 0) {
        await new Promise(res => setTimeout(res, backoffMs));
      }
    }
  }

  logger.error('Giving up on pushing bar after %d attempts', maxAttempts);
} 