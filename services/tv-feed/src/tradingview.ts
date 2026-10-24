import { EventEmitter } from 'events';
import { config } from './config';
import type { Subscription } from './config';
import { logger, priceLogger } from './logger';
import { wsConnectsTotal, wsErrorsTotal, subscriptionsGauge } from './metrics';

// Import TradingView API from local vendor directory
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TradingViewAPI = require('../tradingview_vendor/main');

export interface Bar {
  symbol: string;
  timeframe: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // false/undefined while the candle is still forming (updates on every tick),
  // true exactly once when its period has ended and the values are final.
  closed?: boolean;
}

export class TradingViewClient extends EventEmitter {
  private client: any;
  private connected = false;
  private charts: Map<string, any> = new Map(); // Live chart sessions, keyed by symbol_timeframe
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectDelay = 5000; // 5 seconds base delay

  // Source of truth for what we *want* to be subscribed to. Unlike `charts`, this
  // survives socket drops, so it can drive restoration after a reconnect.
  private desiredSubscriptions: Map<string, Subscription> = new Map();

  // Set while we are deliberately tearing the socket down (close/fullReconnect/shutdown).
  // The vendor emits 'disconnected' for those too, so without this flag we would
  // reconnect in a loop against ourselves.
  private intentionalClose = false;

  // De-duplicates concurrent connect() calls (startup + health recovery can race).
  private connecting: Promise<void> | null = null;

  // Pending readiness timeouts, keyed by symbol_timeframe.
  private readyTimers: Map<string, NodeJS.Timeout> = new Map();

  // Most recent period timestamp seen per subscription. Used to detect the
  // moment a new candle starts, which is the only reliable signal that the
  // previous one is final.
  private lastPeriodTimes: Map<string, number> = new Map();

  // Latest snapshot of the still-forming candle per subscription. TradingView
  // mutates its own period object on every tick, so we must copy it to be able
  // to emit the final values when the period rolls over.
  private closedBars: Map<string, Bar> = new Map();

  // Last period timestamp already emitted as 'bar_closed' per subscription.
  // Prevents duplicates (rollover + catch-up can both notice the same candle).
  //
  // Deliberately NOT cleared on disconnect: the last emitted time is exactly the
  // watermark needed to detect which candles closed while we were offline.
  private lastClosedEmitted: Map<string, number> = new Map();

  // Subscriptions that reconnected and therefore need one scan of the freshly
  // re-delivered history to emit candles that closed during the outage.
  private pendingBackfill: Set<string> = new Set();

  constructor() {
    super();
  }

  async connect() {
    // Serialize concurrent connect attempts: startup and health recovery can both
    // call this, and creating two vendor clients would leak a socket.
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async doConnect() {
    try {
      // An explicit connect means we are no longer intentionally offline.
      this.intentionalClose = false;

      logger.info('Creating TradingView client...');
      
      // Create TradingView API client
      this.client = new TradingViewAPI.Client({
        // Use proxy if specified in config
        proxy: config.tvApi.proxy || undefined,
        // Set connection timeout
        timeout_ms: config.tvApi.timeoutMs
      });
      
      logger.info('TradingView client created successfully');
      
      if (!this.client) {
        throw new Error('Could not initialize TradingView client');
      }
      
      // Wire the vendor socket lifecycle. The vendor emits 'disconnected' from its
      // own socket 'close' handler, which also fires for deliberate teardown, so
      // handleVendorDisconnect() relies on the intentionalClose flag.
      if (typeof this.client.onDisconnected === 'function') {
        const vendorClient = this.client;
        this.client.onDisconnected(() => this.handleVendorDisconnect(vendorClient));
      }

      if (typeof this.client.onError === 'function') {
        this.client.onError((...args: any[]) => {
          logger.error('[DIAG] TradingView socket error: %o', args);
          wsErrorsTotal.inc();
          const first = args[0];
          this.emit('error', first instanceof Error ? first : new Error(String(first)));
        });
      }

      this.connected = true;
      this.reconnectAttempts = 0;
      wsConnectsTotal.inc();
      this.emit('connect');
      logger.info('[DIAG] TradingView connected. Will restore subscriptions if needed.');

      // Restore anything we wanted before the drop. Driven by desiredSubscriptions
      // rather than `charts`, because the chart objects from the dead session are gone.
      await this.restoreDesiredSubscriptions();
    } catch (err) {
      logger.error('Failed to connect TradingView WS: %s', (err as Error).message);
      wsErrorsTotal.inc();
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Restore every subscription we still want after a reconnect.
   * `charts` is cleared on disconnect, so this re-creates real sessions.
   */
  private async restoreDesiredSubscriptions(): Promise<void> {
    if (this.desiredSubscriptions.size === 0) {
      return;
    }

    const pending = Array.from(this.desiredSubscriptions.values());
    logger.info('[DIAG] Restoring %d desired subscription(s) after connect: %o', pending.length, pending);

    let restored = 0;
    for (const sub of pending) {
      // subscribe() re-populates desiredSubscriptions; that is idempotent.
      const ok = await this.subscribe(sub, 'reconnect');
      if (ok) restored++;
    }

    logger.info('[DIAG] Restored %d/%d desired subscription(s)', restored, pending.length);
    if (restored !== pending.length) {
      logger.error('[DIAG] Only %d/%d subscriptions restored after connect', restored, pending.length);
    }
  }

  /**
   * Handle a vendor socket drop.
   *
   * The vendor fires this for deliberate teardown too, so ignore events from a
   * superseded client instance and from intentional closes.
   */
  private handleVendorDisconnect(vendorClient: any): void {
    if (vendorClient !== this.client) {
      logger.info('[DIAG] Ignoring disconnect from superseded TradingView client');
      return;
    }

    if (this.intentionalClose) {
      logger.info('[DIAG] Ignoring expected TradingView disconnect (intentional close)');
      return;
    }

    if (!this.connected) {
      logger.info('[DIAG] Ignoring duplicate TradingView disconnect');
      return;
    }

    logger.warn('[DIAG] TradingView socket dropped unexpectedly, scheduling reconnect');
    this.connected = false;

    // Chart objects belong to the dead session; keeping them would make
    // subscribe() short-circuit on a stale key and silently do nothing.
    this.charts.clear();
    this.clearAllReadyTimers();
    // Drop partial-candle snapshots: a snapshot taken mid-candle would be
    // emitted later as a bogus "final" bar, which is worse than losing one.
    this.lastPeriodTimes.clear();
    this.closedBars.clear();
    // Keep lastClosedEmitted: it is the watermark for post-reconnect backfill.
    // Every still-wanted subscription must be re-checked against its history.
    for (const key of this.desiredSubscriptions.keys()) {
      this.pendingBackfill.add(key);
    }
    subscriptionsGauge.set(0);

    this.emit('disconnect');
    this.scheduleReconnect();
  }

  /**
   * Emit a bar as final, at most once per (subscription, period).
   * Rollover detection and recovery catch-up can both spot the same candle.
   */
  private emitClosedBar(key: string, bar: Bar): void {
    const already = this.lastClosedEmitted.get(key);
    if (already !== undefined && bar.time <= already) {
      return;
    }
    this.lastClosedEmitted.set(key, bar.time);
    this.emit('bar_closed', { ...bar, closed: true });
  }

  /**
   * Emit candles that ended while we were disconnected.
   *
   * A reconnect re-creates the series, so `charts` is empty and the vendor
   * replays history (100 bars by default). Any candle between the last one we
   * emitted and the currently forming candle ended during the outage and was
   * never delivered; without this the backend keeps a silent hole in its data.
   */
  private backfillClosedBars(key: string, symbol: string, timeframe: string, chart: any): void {
    if (!this.pendingBackfill.has(key)) return;
    this.pendingBackfill.delete(key);

    const watermark = this.lastClosedEmitted.get(key);
    const periods: any[] = chart.periods || [];
    if (periods.length === 0) return;

    // periods are sorted newest-first; the newest one is still forming.
    const formingTime = periods[0].time;

    if (watermark === undefined) {
      // First ever data for this subscription - history is not a gap.
      return;
    }

    const missed = periods
      .filter((p) => p && p.time > watermark && p.time < formingTime)
      .sort((a, b) => a.time - b.time);

    if (missed.length === 0) return;

    logger.info(
      '[DIAG] Backfilling %d closed bar(s) for %s/%s after reconnect',
      missed.length, symbol, timeframe
    );

    for (const p of missed) {
      this.emitClosedBar(key, {
        symbol,
        timeframe,
        time: p.time,
        open: p.open,
        high: p.max ?? p.high,
        low: p.min ?? p.low,
        close: p.close,
        volume: p.volume || 0,
      });
    }

    // If the oldest replayed candle is still newer than our watermark, the
    // outage outlasted the replayed window and some candles are unrecoverable.
    const oldest = periods[periods.length - 1];
    if (oldest && oldest.time > watermark) {
      logger.warn(
        '[DIAG] Reconnect gap for %s/%s exceeds the replayed history window; some candles could not be recovered',
        symbol, timeframe
      );
    }
  }

  /**
   * Arm a readiness timer for a subscription. Cleared as soon as the chart
   * reports the symbol loaded, produces data, or errors out.
   */
  private armReadyTimer(key: string, symbol: string, timeframe: string): void {
    this.clearReadyTimer(key);

    const timeoutMs = config.tvApi.readyTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return;

    const timer = setTimeout(() => {
      this.readyTimers.delete(key);
      // Only report if we still believe this chart is live.
      if (!this.charts.has(key)) return;
      logger.error(
        '[DIAG] Subscription %s/%s did not become ready within %dms (no symbol load, update or error)',
        symbol, timeframe, timeoutMs
      );
      this.emit('subscription_stalled', { symbol, timeframe });
    }, timeoutMs);

    // Do not keep the process alive purely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
    this.readyTimers.set(key, timer);
  }

  private clearReadyTimer(key: string): void {
    const timer = this.readyTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.readyTimers.delete(key);
    }
  }

  private clearAllReadyTimers(): void {
    for (const timer of this.readyTimers.values()) {
      clearTimeout(timer);
    }
    this.readyTimers.clear();
  }

  private scheduleReconnect() {
    // Never reconnect after an intentional shutdown/close.
    if (this.intentionalClose) {
      logger.info('[DIAG] Reconnect suppressed (intentional close)');
      return;
    }

    // Prevent multiple reconnect attempts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;

    const maxAttempts = config.tvApi.reconnectMaxAttempts;
    const maxDelayMs = config.tvApi.reconnectMaxDelayMs;
    const slowMode = maxAttempts > 0 && this.reconnectAttempts > maxAttempts;

    if (slowMode && this.reconnectAttempts === maxAttempts + 1) {
      // Enter slow-retry mode once instead of dying. Giving up permanently leaves
      // the process up but deaf forever, which is strictly worse than retrying
      // slowly: a multi-hour outage then recovers without human intervention.
      logger.error(
        'Reconnect attempts exceeded %d, continuing at the %dms ceiling (no permanent give-up)',
        maxAttempts, maxDelayMs
      );
      this.emit('max_reconnect_attempts');
    }

    // Exponential backoff with jitter to prevent thundering herd
    const delay = slowMode
      ? maxDelayMs
      : Math.min(
          this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1) * (1 + Math.random() * 0.2),
          maxDelayMs
        );

    logger.info(`[DIAG] Scheduling reconnect in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}${slowMode ? ', slow mode' : ''})`);

    this.reconnectTimeout = setTimeout(() => {
      logger.info('[DIAG] Reconnecting TradingView...');
      this.connect().catch(err => {
        logger.error('Reconnect failed:', err);
        this.scheduleReconnect();
      });
    }, delay);
  }

  // Subscribe to symbol/timeframe
  async subscribe(subscription: Subscription, reason: string = 'explicit'): Promise<boolean> {
    logger.info(`[DIAG] subscribe() called for %s/%s (%s). Current charts: %o`, subscription.symbol, subscription.timeframe, reason, Array.from(this.charts.keys()));
    if (!this.connected || !this.client) {
      logger.error('Cannot subscribe, client not connected');
      throw new Error('TradingView client not connected');
    }

    const { symbol, timeframe } = subscription;
    const key = `${symbol}_${timeframe}`;

    // If already subscribed, do nothing
    if (this.charts.has(key)) {
      // Keep the intent registry authoritative even on the idempotent path.
      this.desiredSubscriptions.set(key, { symbol, timeframe });
      logger.info(`[DIAG] Already subscribed to %s/%s (%s). Charts: %o`, symbol, timeframe, reason, Array.from(this.charts.keys()));
      return true;
    }

    try {
      logger.info(`[DIAG] Subscribing to %s/%s (%s)`, symbol, timeframe, reason);
      
      // Create separate chart for symbol/timeframe
      const chart = new this.client.Session.Chart();
      
      // Handle errors
      chart.onError((...err: any[]) => {
        logger.error('Chart error for %s/%s: %o', symbol, timeframe, err);
        this.clearReadyTimer(key);
        this.emit('chart_error', { symbol, timeframe, error: err });
        logger.error(`[DIAG] Chart error for %s/%s after %s: %o`, symbol, timeframe, reason, err);
      });
      
      // When symbol is loaded
      chart.onSymbolLoaded(() => {
        logger.info('Symbol loaded for %s/%s: %s', symbol, timeframe, chart.infos?.description || 'Unknown');
        this.clearReadyTimer(key);
        this.emit('symbol_loaded', { symbol, timeframe, description: chart.infos?.description });
      });
      
      // Handle data updates
      chart.onUpdate(() => {
        if (!chart.periods || !chart.periods[0]) return;

        // First real data also proves the subscription is alive.
        this.clearReadyTimer(key);

        // After a reconnect the vendor replays history for the re-created series.
        // Emit candles that closed while we were offline so the backend does not
        // silently end up with a hole in its series.
        this.backfillClosedBars(key, symbol, timeframe, chart);
        
        // Get last bar
        const lastBar = chart.periods[0];
        
        if (lastBar) {
          // Prepare bar for push
          const bar: Bar = {
            symbol,
            timeframe,
            time: lastBar.time,
            open: lastBar.open,
            high: lastBar.max || lastBar.high, // Support for different data formats
            low: lastBar.min || lastBar.low,   // Support for different data formats
            close: lastBar.close,
            volume: lastBar.volume || 0,
            // This is the still-forming candle; it changes on every tick.
            closed: false,
          };
          
          logger.debug('Got bar: %o', bar);
          
          if (config.debugPrices) {
            priceLogger.info(
              '[PRICE] %s/%s %s O:%s H:%s L:%s C:%s V:%s',
              bar.symbol, bar.timeframe, new Date(bar.time * 1000).toISOString(),
              bar.open.toFixed(5), bar.high.toFixed(5), bar.low.toFixed(5),
              bar.close.toFixed(5), bar.volume.toFixed(2)
            );
          }
          
          // Emit the forming candle on every tick so real-time consumers keep
          // their last price fresh. It is explicitly marked as not final.
          this.emit('bar', bar);

          // Detect rollover: a period with a NEWER timestamp means the previous
          // one is finished. TradingView never sends a "candle closed" packet,
          // so this transition is the only reliable close signal.
          const previousTime = this.lastPeriodTimes.get(key);
          if (previousTime !== undefined && bar.time > previousTime) {
            // Prefer the vendor's own finalized values for the candle that just
            // ended: periods[] now holds its true final OHLCV, which can differ
            // from our last tick snapshot (e.g. the final partial-second tick).
            const vendorFinal = (chart.periods || []).find(
              (p: any) => p && p.time === previousTime
            );
            if (vendorFinal) {
              this.emitClosedBar(key, {
                symbol,
                timeframe,
                time: vendorFinal.time,
                open: vendorFinal.open,
                high: vendorFinal.max ?? vendorFinal.high,
                low: vendorFinal.min ?? vendorFinal.low,
                close: vendorFinal.close,
                volume: vendorFinal.volume || 0,
              });
            } else {
              // Fall back to the last snapshot we took of the forming candle.
              const snapshot = this.closedBars.get(key);
              if (snapshot) {
                this.emitClosedBar(key, snapshot);
              }
            }
          }

          this.lastPeriodTimes.set(key, bar.time);
          // Snapshot now: the vendor mutates its period object in place, so
          // holding a reference would give us future tick values, not final ones.
          this.closedBars.set(key, { ...bar });
        }
      });
      
      // Set market
      chart.setMarket(symbol, {
        timeframe
      });
      
      // Save chart for this subscription
      this.charts.set(key, chart);
      // Record intent so a reconnect can rebuild this session.
      this.desiredSubscriptions.set(key, { symbol, timeframe });
      logger.info('[DIAG] charts after subscribe: %o', Array.from(this.charts.keys()));
      subscriptionsGauge.set(this.charts.size);
      logger.info(`[DIAG] Subscribed to %s/%s (%s). Charts now: %o`, symbol, timeframe, reason, Array.from(this.charts.keys()));
      this.emit('subscribed', subscription);

      // setMarket() only queues the request; it says nothing about the chart being
      // live. Arm a timer so a subscription that never becomes ready is surfaced
      // instead of silently sitting there until the (much longer) stale check.
      this.armReadyTimer(key, symbol, timeframe);

      return true;
    } catch (err) {
      logger.error('Failed to subscribe to %s/%s: %s', symbol, timeframe, (err as Error).message);
      this.emit('subscription_error', { subscription, error: err });
      logger.error(`[DIAG] Failed to subscribe to %s/%s after %s: %s`, symbol, timeframe, reason, (err as Error).message);
      return false;
    }
  }

  // Unsubscribe from symbol/timeframe
  async unsubscribe(symbol: string, timeframe: string): Promise<boolean> {
    const key = `${symbol}_${timeframe}`;
    logger.info(`[DIAG] unsubscribe() called for %s/%s. Current charts: %o`, symbol, timeframe, Array.from(this.charts.keys()));
    const chart = this.charts.get(key);

    if (!chart) {
      logger.warn('Cannot unsubscribe, subscription not found: %s/%s', symbol, timeframe);
      return false;
    }

    try {
      logger.info('Unsubscribing from TradingView: %s/%s', symbol, timeframe);
      if (typeof chart.delete === 'function') {
        chart.delete();
        logger.info('Chart.delete() called for %s/%s', symbol, timeframe);
      } else {
        logger.warn('Chart.delete() not a function for %s/%s', symbol, timeframe);
      }
      this.charts.delete(key);
      // The caller no longer wants this subscription, so stop restoring it.
      this.desiredSubscriptions.delete(key);
      this.clearReadyTimer(key);
      this.lastPeriodTimes.delete(key);
      this.closedBars.delete(key);
      this.lastClosedEmitted.delete(key);
      this.pendingBackfill.delete(key);
      logger.info('[DIAG] charts after unsubscribe: %o', Array.from(this.charts.keys()));
      subscriptionsGauge.set(this.charts.size);
      logger.info('Unsubscribed from %s/%s, %d subscriptions remain. Charts now: %o', symbol, timeframe, this.charts.size, Array.from(this.charts.keys()));
      if (this.charts.size === 0) {
        logger.info('All TradingView subscriptions removed, TradingView client is now idle');
      }
      this.emit('unsubscribed', { symbol, timeframe });
      return true;
    } catch (err) {
      logger.error('Error unsubscribing from %s/%s: %s', symbol, timeframe, (err as Error).message);
      return false;
    }
  }

  // Get list of active subscriptions.
  // Reads `desiredSubscriptions` rather than `charts`: charts are emptied while a
  // reconnect is in flight, but the intent to be subscribed never goes away.
  getSubscriptions(): Subscription[] {
    return Array.from(this.desiredSubscriptions.values());
  }

  // Update subscriptions (subscribe to new and unsubscribe from removed)
  async updateSubscriptions(subscriptions: Subscription[], reason: string = 'explicit'): Promise<void> {
    const currentSubs = this.getSubscriptions();
    const currentKeys = new Set(currentSubs.map(s => `${s.symbol}_${s.timeframe}`));
    const newKeys = new Set(subscriptions.map(s => `${s.symbol}_${s.timeframe}`));
    
    // Unsubscribe from those not in the new list
    const toRemove = currentSubs.filter(s => !newKeys.has(`${s.symbol}_${s.timeframe}`));
    for (const sub of toRemove) {
      await this.unsubscribe(sub.symbol, sub.timeframe);
    }
    
    // Subscribe to new ones
    const toAdd = subscriptions.filter(s => !currentKeys.has(`${s.symbol}_${s.timeframe}`));
    let restored = 0;
    for (const sub of toAdd) {
      const ok = await this.subscribe(sub, reason);
      if (ok) restored++;
    }
    
    logger.info(`[DIAG] updateSubscriptions(%s): removed %d, added %d, restored %d`, reason, toRemove.length, toAdd.length, restored);
    if (reason === 'reconnect' && restored === 0) {
      logger.error('[DIAG] No subscriptions restored after reconnect!');
    }
  }

  close() {
    // Mark this as deliberate before touching the socket: client.end() makes the
    // vendor emit 'disconnected', which must not trigger a reconnect.
    this.intentionalClose = true;

    // Cancel reconnect attempts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // Close all subscriptions
    for (const [key, chart] of this.charts.entries()) {
      try {
        if (typeof chart.delete === 'function') {
          chart.delete();
        }
      } catch (err) {
        logger.error('Error closing chart %s: %s', key, (err as Error).message);
      }
    }
    
    this.charts.clear();
    this.clearAllReadyTimers();
    this.lastPeriodTimes.clear();
    this.closedBars.clear();
    this.lastClosedEmitted.clear();
    subscriptionsGauge.set(0);
    
    // Close connection
    if (this.client && this.connected && typeof this.client.end === 'function') {
      try {
        this.client.end();
      } catch (err) {
        logger.error('Error disconnecting from TradingView: %s', (err as Error).message);
      }
    }
    
    this.connected = false;
    this.emit('disconnect');
    logger.info('TradingView client closed');
  }

  /**
   * Full reconnection with TradingView - disconnects, reconnects, and restores all subscriptions
   * This is a more aggressive reset than a plain reconnect and is used for severe issues.
   * Restoration is handled by connect(), which rebuilds from desiredSubscriptions.
   */
  public async fullReconnect(): Promise<boolean> {
    logger.warn('[DIAG] fullReconnect() called - performing complete TradingView reconnection');
    
    try {
      const subscriptionCount = this.getSubscriptions().length;
      if (subscriptionCount > 0) {
        logger.info('[DIAG] fullReconnect() - %d subscription(s) will be restored by connect()', subscriptionCount);
      }
      
      // Close current connection completely (marks the teardown as intentional)
      this.close();
      
      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Connect again - this also restores all desired subscriptions
      await this.connect();
      
      logger.info('[DIAG] fullReconnect() completed successfully');
      return true;
    } catch (err) {
      logger.error('[DIAG] fullReconnect() failed: %s', (err as Error).message);
      return false;
    }
  }

  /**
   * Check if the client is connected to TradingView
   */
  public isConnected(): boolean {
    return this.connected;
  }
} 