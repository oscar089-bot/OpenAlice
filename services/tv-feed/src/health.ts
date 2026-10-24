import { logger } from './logger';
import { EventEmitter } from 'events';
import { TradingViewClient } from './tradingview';
import { type Bar } from './tradingview';
import { type Subscription } from './config';
import { 
  staleSubscriptionsGauge, 
  recoveryAttemptsTotal, 
  successfulRecoveriesTotal, 
  failedRecoveriesTotal,
  fullReconnectsTotal,
  lastDataReceivedGauge
} from './metrics';

/**
 * Configuration for the TradingView health monitor
 */
export interface HealthMonitorConfig {
  // How often to check for stale subscriptions (in milliseconds)
  checkIntervalMs: number;
  
  // How long a subscription can go without data before being considered stale (in milliseconds)
  // This is a multiplier applied to the timeframe's expected interval
  staleThresholdMultiplier: number;
  
  // Whether to automatically attempt recovery of stale subscriptions
  autoRecoveryEnabled: boolean;
  
  // Maximum number of recovery attempts before giving up
  maxRecoveryAttempts: number;
  
  // Number of stale subscriptions that triggers a full reconnect
  fullReconnectThreshold: number;
  
  // Cooldown period between full reconnects (in milliseconds)
  fullReconnectCooldownMs: number;
  
  // Port for the health API
  apiPort: number;
}

// Default configuration values - NOTE: These are just for type checking.
// The actual defaults are in config.ts to avoid circular dependencies.
const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 60000, // Check every minute
  staleThresholdMultiplier: 3, // Consider stale after 3x the expected interval
  autoRecoveryEnabled: true, // Try to recover automatically
  maxRecoveryAttempts: 3, // Max 3 recovery attempts per subscription
  fullReconnectThreshold: 3, // Number of stale subscriptions that triggers a full reconnect
  fullReconnectCooldownMs: 600000, // 10 minutes between full reconnects
  apiPort: 8082, // Health API port
};

/**
 * Converts a timeframe string to milliseconds
 */
function timeframeToMs(timeframe: string): number {
  // Convert TradingView timeframe to milliseconds
  if (timeframe === 'D') return 24 * 60 * 60 * 1000; // 1 day
  if (timeframe === 'W') return 7 * 24 * 60 * 60 * 1000; // 1 week
  if (timeframe === 'M') return 30 * 24 * 60 * 60 * 1000; // ~1 month
  
  // Minutes (1, 5, 15, 30, 60, 120, 240, etc.)
  return parseInt(timeframe) * 60 * 1000;
}

/**
 * Health monitor for TradingView data flow
 * 
 * Monitors subscriptions for data flow and attempts recovery when needed
 */
export class TradingViewHealthMonitor extends EventEmitter {
  private tvClient: TradingViewClient;
  private config: HealthMonitorConfig;
  
  // Track the last time a bar was received for each subscription
  private lastBarTimestamps: Map<string, number> = new Map();
  
  // Track recovery attempts for each subscription
  private recoveryAttempts: Map<string, number> = new Map();
  
  // Timer for health checks
  private checkTimer: NodeJS.Timeout | null = null;
  
  // Track the last time a full reconnect was performed
  private lastFullReconnectTime: number = 0;
  
  // Stored bound handlers so stop() can detach exactly ours without disturbing
  // listeners other modules registered on the shared TradingView client.
  private readonly onBarHandler = this.onBar.bind(this);
  private readonly onSubscribedHandler = this.onSubscribed.bind(this);
  private readonly onUnsubscribedHandler = this.onUnsubscribed.bind(this);
  private readonly onConnectHandler = this.onConnect.bind(this);
  private readonly onDisconnectHandler = this.onDisconnect.bind(this);
  private readonly onStalledHandler = this.onSubscriptionStalled.bind(this);

  constructor(tvClient: TradingViewClient, config: HealthMonitorConfig = DEFAULT_CONFIG) {
    super();
    this.tvClient = tvClient;
    this.config = config;

    // Subscribe to TradingView events
    this.tvClient.on('bar', this.onBarHandler);
    this.tvClient.on('subscribed', this.onSubscribedHandler);
    this.tvClient.on('unsubscribed', this.onUnsubscribedHandler);
    this.tvClient.on('connect', this.onConnectHandler);
    this.tvClient.on('disconnect', this.onDisconnectHandler);
    this.tvClient.on('subscription_stalled', this.onStalledHandler);
    
    // Start health checks
    this.startHealthChecks();
    
    logger.info('[HEALTH] TradingView health monitor initialized with config: %o', this.config);
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
    
    this.checkTimer = setInterval(
      () => this.checkSubscriptionHealth(),
      this.config.checkIntervalMs
    );
    
    logger.info('[HEALTH] Started periodic health checks every %dms', this.config.checkIntervalMs);
  }

  /**
   * Stop health checks
   */
  public stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    
    // Cleanup our own listeners only. removeAllListeners() would also detach the
    // pushBar handler registered in main.ts on the same shared client.
    this.tvClient.off('bar', this.onBarHandler);
    this.tvClient.off('subscribed', this.onSubscribedHandler);
    this.tvClient.off('unsubscribed', this.onUnsubscribedHandler);
    this.tvClient.off('connect', this.onConnectHandler);
    this.tvClient.off('disconnect', this.onDisconnectHandler);
    this.tvClient.off('subscription_stalled', this.onStalledHandler);
    
    logger.info('[HEALTH] Health monitor stopped');
  }

  /**
   * Handle a subscription that was created but never became ready.
   * Treat it as stale immediately rather than waiting out the timeframe multiplier.
   */
  private onSubscriptionStalled(subscription: Subscription): void {
    const { symbol, timeframe } = subscription;
    const key = `${symbol}_${timeframe}`;

    logger.warn('[HEALTH] Subscription %s/%s stalled before becoming ready, attempting recovery', symbol, timeframe);

    if (!this.config.autoRecoveryEnabled) {
      this.emit('subscription_stalled', subscription);
      return;
    }

    this.attemptRecovery(subscription).catch((err) => {
      logger.error('[HEALTH] Recovery after stall failed for %s/%s: %s', symbol, timeframe, (err as Error).message);
    });

    // Mark it as needing attention in the gauge until data arrives.
    this.lastBarTimestamps.set(key, Date.now());
  }

  /**
   * Handle new bar event
   */
  private onBar(bar: Bar): void {
    const key = `${bar.symbol}_${bar.timeframe}`;
    const now = Date.now();
    this.lastBarTimestamps.set(key, now);
    this.recoveryAttempts.delete(key); // Reset recovery attempts on successful data
    logger.debug('[HEALTH] Received bar for %s/%s, updated last bar timestamp', bar.symbol, bar.timeframe);
    
    // Update metrics
    lastDataReceivedGauge.labels(bar.symbol, bar.timeframe).set(0);
  }

  /**
   * Handle subscription event
   */
  private onSubscribed(subscription: Subscription): void {
    const key = `${subscription.symbol}_${subscription.timeframe}`;
    this.lastBarTimestamps.set(key, Date.now()); // Initialize with current time
    logger.info('[HEALTH] New subscription to %s/%s, initialized health tracking', subscription.symbol, subscription.timeframe);
  }

  /**
   * Handle unsubscription event
   */
  private onUnsubscribed({ symbol, timeframe }: { symbol: string, timeframe: string }): void {
    const key = `${symbol}_${timeframe}`;
    this.lastBarTimestamps.delete(key);
    this.recoveryAttempts.delete(key);
    logger.info('[HEALTH] Removed health tracking for unsubscribed %s/%s', symbol, timeframe);
  }

  /**
   * Handle TradingView connection event
   */
  private onConnect(): void {
    logger.info('[HEALTH] TradingView connected, resetting health tracking');
    // Reset all timestamps on reconnect
    for (const key of this.lastBarTimestamps.keys()) {
      this.lastBarTimestamps.set(key, Date.now());
    }
    // Reset all recovery attempts
    this.recoveryAttempts.clear();
  }

  /**
   * Handle TradingView disconnection event
   */
  private onDisconnect(): void {
    logger.warn('[HEALTH] TradingView disconnected, pausing health tracking');
    // We don't clear the timestamps here, as we want to preserve the last known times
    // The reconnection will be handled by the TradingViewClient
  }

  /**
   * Check the health of all active subscriptions
   */
  private async checkSubscriptionHealth(): Promise<void> {
    const now = Date.now();
    const subscriptions = this.tvClient.getSubscriptions();
    
    if (subscriptions.length === 0) {
      staleSubscriptionsGauge.set(0);
      return; // Nothing to check
    }
    
    logger.debug('[HEALTH] Checking health of %d subscriptions', subscriptions.length);
    
    let staleCount = 0;
    let recoveryCount = 0;
    const staleSubscriptions: Subscription[] = [];
    
    for (const sub of subscriptions) {
      const key = `${sub.symbol}_${sub.timeframe}`;
      const lastTimestamp = this.lastBarTimestamps.get(key);
      
      if (!lastTimestamp) {
        logger.warn('[HEALTH] No timestamp for %s/%s, initializing', sub.symbol, sub.timeframe);
        this.lastBarTimestamps.set(key, now);
        lastDataReceivedGauge.labels(sub.symbol, sub.timeframe).set(0);
        continue;
      }
      
      const expectedIntervalMs = timeframeToMs(sub.timeframe);
      const staleThresholdMs = expectedIntervalMs * this.config.staleThresholdMultiplier;
      const timeSinceLastBar = now - lastTimestamp;
      
      // Update metrics for time since last data
      lastDataReceivedGauge.labels(sub.symbol, sub.timeframe).set(timeSinceLastBar / 1000);
      
      if (timeSinceLastBar > staleThresholdMs) {
        staleCount++;
        staleSubscriptions.push(sub);
        const minutes = Math.floor(timeSinceLastBar / 60000);
        const seconds = Math.floor((timeSinceLastBar % 60000) / 1000);
        logger.warn(
          '[HEALTH] Stale subscription detected for %s/%s - no data for %dm %ds (threshold: %ds)',
          sub.symbol, sub.timeframe, minutes, seconds, staleThresholdMs / 1000
        );
      }
    }
    
    // Update metrics
    staleSubscriptionsGauge.set(staleCount);
    
    if (staleCount > 0) {
      // Check if we need to do a full reconnect
      const shouldFullReconnect = 
        this.config.autoRecoveryEnabled && 
        staleCount >= this.config.fullReconnectThreshold &&
        now - this.lastFullReconnectTime > this.config.fullReconnectCooldownMs;
      
      if (shouldFullReconnect) {
        logger.warn(
          '[HEALTH] %d stale subscriptions exceeds threshold (%d), performing full reconnect',
          staleCount, this.config.fullReconnectThreshold
        );
        await this.performFullReconnect();
        this.lastFullReconnectTime = now;
      } else if (this.config.autoRecoveryEnabled) {
        // Only do individual recovery if we're not doing a full reconnect
        for (const sub of staleSubscriptions) {
          await this.attemptRecovery(sub);
          recoveryCount++;
        }
        
        logger.warn(
          '[HEALTH] Found %d stale subscriptions out of %d total, attempted recovery for %d',
          staleCount, subscriptions.length, recoveryCount
        );
      } else {
        logger.warn(
          '[HEALTH] Found %d stale subscriptions out of %d total, but auto-recovery is disabled',
          staleCount, subscriptions.length
        );
      }
      
      this.emit('stale_subscriptions', {
        total: subscriptions.length,
        stale: staleCount,
        recovered: recoveryCount,
        fullReconnect: shouldFullReconnect
      });
    } else {
      logger.debug('[HEALTH] All %d subscriptions are healthy', subscriptions.length);
    }
  }

  /**
   * Attempt to recover a stale subscription
   */
  private async attemptRecovery(subscription: Subscription): Promise<boolean> {
    const { symbol, timeframe } = subscription;
    const key = `${symbol}_${timeframe}`;
    
    // Get current recovery attempts, defaulting to 0 if not present
    const attempts = this.recoveryAttempts.get(key) || 0;
    
    if (attempts >= this.config.maxRecoveryAttempts) {
      logger.error(
        '[HEALTH] Max recovery attempts (%d) reached for %s/%s, giving up',
        this.config.maxRecoveryAttempts, symbol, timeframe
      );
      this.emit('max_recovery_attempts', subscription);
      return false;
    }
    
    // Increment attempts
    this.recoveryAttempts.set(key, attempts + 1);
    recoveryAttemptsTotal.inc();
    
    logger.info(
      '[HEALTH] Attempting recovery for %s/%s (attempt %d/%d)',
      symbol, timeframe, attempts + 1, this.config.maxRecoveryAttempts
    );
    
    try {
      // Try to unsubscribe and resubscribe
      await this.tvClient.unsubscribe(symbol, timeframe);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Give it a moment
      const success = await this.tvClient.subscribe(subscription, 'health_recovery');
      
      if (success) {
        logger.info('[HEALTH] Successfully resubscribed to %s/%s', symbol, timeframe);
        this.lastBarTimestamps.set(key, Date.now()); // Reset the timestamp
        this.emit('recovery_success', subscription);
        successfulRecoveriesTotal.inc();
        return true;
      } else {
        logger.error('[HEALTH] Failed to resubscribe to %s/%s', symbol, timeframe);
        this.emit('recovery_failure', subscription);
        failedRecoveriesTotal.inc();
        return false;
      }
    } catch (err) {
      logger.error(
        '[HEALTH] Error during recovery for %s/%s: %s',
        symbol, timeframe, (err as Error).message
      );
      this.emit('recovery_error', { subscription, error: err });
      failedRecoveriesTotal.inc();
      return false;
    }
  }

  /**
   * Perform a full reconnection to TradingView
   */
  private async performFullReconnect(): Promise<boolean> {
    logger.warn('[HEALTH] Performing full TradingView reconnect due to multiple stale subscriptions');
    fullReconnectsTotal.inc();
    
    try {
      // Use the fullReconnect method in TradingViewClient
      if (typeof this.tvClient.fullReconnect === 'function') {
        const success = await this.tvClient.fullReconnect();
        
        if (success) {
          logger.info('[HEALTH] Full TradingView reconnect successful');
          
          // Reset all timestamps and recovery attempts
          const now = Date.now();
          for (const key of this.lastBarTimestamps.keys()) {
            this.lastBarTimestamps.set(key, now);
          }
          this.recoveryAttempts.clear();
          
          this.emit('full_reconnect_success');
          return true;
        } else {
          logger.error('[HEALTH] Full TradingView reconnect failed');
          this.emit('full_reconnect_failure');
          return false;
        }
      } else {
        logger.error('[HEALTH] fullReconnect method not available on TradingViewClient');
        return false;
      }
    } catch (err) {
      logger.error('[HEALTH] Error during full TradingView reconnect: %s', (err as Error).message);
      this.emit('full_reconnect_error', err);
      return false;
    }
  }
} 