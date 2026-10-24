import dotenv from 'dotenv';
import { type HealthMonitorConfig } from './health';

dotenv.config();

export interface Subscription {
  symbol: string;
  timeframe: string;
}

export interface Config {
  tvApi: {
    proxy: string | null;
    timeoutMs: number;
    // How long to wait for a chart to actually become ready (symbol loaded /
    // first update) before treating the subscription as stalled.
    readyTimeoutMs: number;
    // Reconnect backoff ceiling. Retries never stop, they just settle at this
    // delay, so a long outage recovers on its own instead of needing a restart.
    reconnectMaxDelayMs: number;
    // Attempts before switching to slow-retry mode. 0 disables the switch and
    // keeps pure exponential backoff up to the ceiling.
    reconnectMaxAttempts: number;
  };
  subscriptions: Subscription[];
  backend: {
    endpoint: string;
    apiKey: string;
    retry: {
      // Total attempts per bar (not "retries after the first").
      attempts: number;
      // Delay between attempts.
      backoffMs: number;
      // Max bars waiting to be pushed; oldest are dropped when full.
      queueLimit: number;
      // Only send final (closed) bars to the backend. Ticks of the still-forming
      // candle are broadcast over WebSocket but not POSTed, so the backend never
      // has to reconcile multiple versions of the same (symbol, timeframe, time).
      closedBarsOnly: boolean;
    };
  };
  metrics: {
    port: number;
  };
  log: {
    level: string;
    file: string;
  };
  websocket: {
    port: number;
    /** Explicit bind address. Loopback by default: the feed is unauthenticated. */
    host: string;
    enabled: boolean;
  };
  debugPrices: boolean;
  pricesLogFile: string;
  health: HealthMonitorConfig;
}

// Default configuration values for health monitoring
const DEFAULT_HEALTH_CONFIG = {
  checkIntervalMs: 60000, // Check every minute
  staleThresholdMultiplier: 3, // Consider stale after 3x the expected interval
  autoRecoveryEnabled: true, // Try to recover automatically
  maxRecoveryAttempts: 3, // Max 3 recovery attempts per subscription
  fullReconnectThreshold: 3, // Number of stale subscriptions that triggers a full reconnect
  fullReconnectCooldownMs: 600000, // 10 minutes between full reconnects
  apiPort: 8082, // Health API port
};

function parseSubscriptions(): Subscription[] {
  const raw = process.env.SUBSCRIPTIONS;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('SUBSCRIPTIONS must be valid JSON');
  }
}

function normalizeTimeframe(sub: Subscription): Subscription {
  let { timeframe } = sub;
  
  // TradingView API specifics: '1m' -> '1', '1h' -> '60', etc.
  if (timeframe.endsWith('m')) {
    timeframe = timeframe.replace('m', '');
  } else if (timeframe.endsWith('h')) {
    timeframe = (parseInt(timeframe) * 60).toString();
  } else if (timeframe === '1d' || timeframe === 'd') {
    timeframe = 'D';
  } else if (timeframe === '1w' || timeframe === 'w') {
    timeframe = 'W';
  } else if (timeframe === '1M' || timeframe === 'M') {
    timeframe = 'M';
  }
  
  return { ...sub, timeframe };
}

// Parse health monitor config from environment variables
export function getHealthMonitorConfig(): HealthMonitorConfig {
  return {
    checkIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '') || DEFAULT_HEALTH_CONFIG.checkIntervalMs,
    staleThresholdMultiplier: parseFloat(process.env.HEALTH_STALE_THRESHOLD_MULTIPLIER || '') || DEFAULT_HEALTH_CONFIG.staleThresholdMultiplier,
    autoRecoveryEnabled: process.env.HEALTH_AUTO_RECOVERY_ENABLED !== 'false',
    maxRecoveryAttempts: parseInt(process.env.HEALTH_MAX_RECOVERY_ATTEMPTS || '') || DEFAULT_HEALTH_CONFIG.maxRecoveryAttempts,
    fullReconnectThreshold: parseInt(process.env.HEALTH_FULL_RECONNECT_THRESHOLD || '') || DEFAULT_HEALTH_CONFIG.fullReconnectThreshold,
    fullReconnectCooldownMs: parseInt(process.env.HEALTH_FULL_RECONNECT_COOLDOWN_MS || '') || DEFAULT_HEALTH_CONFIG.fullReconnectCooldownMs,
    apiPort: parseInt(process.env.HEALTH_API_PORT || '') || DEFAULT_HEALTH_CONFIG.apiPort,
  };
}

export const config: Config = {
  tvApi: {
    proxy: process.env.TV_API_PROXY || null,
    timeoutMs: Number(process.env.TV_API_TIMEOUT_MS) || 10000,
    readyTimeoutMs: Number(process.env.TV_API_READY_TIMEOUT_MS) || 30000,
    reconnectMaxDelayMs: Number(process.env.TV_API_RECONNECT_MAX_DELAY_MS) || 60000,
    reconnectMaxAttempts: Number(process.env.TV_API_RECONNECT_MAX_ATTEMPTS) || 10,
  },
  subscriptions: parseSubscriptions().map(normalizeTimeframe),
  backend: {
    endpoint: process.env.BACKEND_ENDPOINT || '',
    apiKey: process.env.BACKEND_API_KEY || '',
    retry: {
      attempts: Number(process.env.BACKEND_RETRY_ATTEMPTS) || 3,
      backoffMs: Number(process.env.BACKEND_RETRY_BACKOFF_MS) || 1000,
      queueLimit: Number(process.env.BACKEND_QUEUE_LIMIT) || 1000,
      closedBarsOnly: process.env.BACKEND_CLOSED_BARS_ONLY !== 'false',
    },
  },
  metrics: {
    port: Number(process.env.METRICS_PORT) || 9100,
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/tv-fetcher.log',
  },
  websocket: {
    port: Number(process.env.WEBSOCKET_PORT) || 8081,
    // Explicit bind address. The default is loopback: this service is
    // UNAUTHENTICATED, so exposing it must be a deliberate act. Set
    // WEBSOCKET_HOST=0.0.0.0 only behind a firewall / private network.
    host: process.env.WEBSOCKET_HOST || '127.0.0.1',
    enabled: process.env.WEBSOCKET_ENABLED !== 'false',
  },
  debugPrices: process.env.DEBUG_PRICES === 'true',
  pricesLogFile: process.env.PRICES_LOG_FILE || './logs/prices.log',
  health: getHealthMonitorConfig(),
}; 