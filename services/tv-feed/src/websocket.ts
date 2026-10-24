import WebSocket from 'ws';
import http from 'http';
import { EventEmitter } from 'events';
import { config } from './config';
import { logger } from './logger';
import { type Subscription } from './config';
import { type Bar } from './tradingview';

// WebSocket message types
export enum MessageType {
  SUBSCRIBE = 'subscribe',
  UNSUBSCRIBE = 'unsubscribe',
  LIST = 'list',
  BAR = 'bar',
  ERROR = 'error',
  INFO = 'info',
  SUBSCRIBE_MANY = 'subscribe_many',
  UNSUBSCRIBE_MANY = 'unsubscribe_many',
}

// Client request type
export interface WSRequest {
  action: MessageType | string;
  symbol?: string;
  timeframe?: string;
  requestId?: string;
  pairs?: { symbol: string; timeframe: string }[];
}

// Server response type
export interface WSResponse {
  type: MessageType | string;
  requestId?: string;
  success?: boolean;
  message?: string;
  symbol?: string;
  timeframe?: string;
  subscriptions?: Subscription[];
  bar?: Bar;
  error?: string;
}

/**
 * Parse a subscription key back into its parts.
 *
 * Keys are built as `${symbol}_${timeframe}`. Timeframes never contain an
 * underscore ('1', '60', 'D', 'W', 'M'), but symbols can, so split on the last
 * one instead of the first.
 */
function parseSubscriptionKey(key: string): { symbol: string; timeframe: string } {
  const idx = key.lastIndexOf('_');
  if (idx === -1) {
    return { symbol: key, timeframe: '' };
  }
  return { symbol: key.slice(0, idx), timeframe: key.slice(idx + 1) };
}

export class WebSocketServer extends EventEmitter {
  private wss: WebSocket.Server;
  private clients: Set<WebSocket> = new Set();
  private activeSubscriptions: Map<string, Subscription> = new Map();

  // New structures for per-client subscription tracking
  private clientSubscriptions: Map<WebSocket, Set<string>> = new Map();
  private subscriptionClients: Map<string, Set<WebSocket>> = new Map();

  // Subscriptions originating from the config (SUBSCRIPTIONS). These are owned by the
  // service, not by any client, and must survive clients connecting and disconnecting.
  private persistentSubscriptions: Set<string> = new Set();

  // Persistent subscriptions a given client explicitly opted out of. Without this,
  // the "Unsubscribed (service-wide subscription kept alive)" reply would be a lie:
  // persistent bars are broadcast to every client, including the one that just left.
  private declinedPersistent: Map<WebSocket, Set<string>> = new Map();

  constructor(server?: http.Server) {
    super();
    
    // Create WebSocket server
    const port = config.websocket?.port || 8081;
    const host = config.websocket?.host || '127.0.0.1';
    
    if (server) {
      // Use existing HTTP server
      this.wss = new WebSocket.Server({ server });
      logger.info(`WebSocket server attached to existing HTTP server`);
    } else {
      // Create new WebSocket server. `host` is explicit rather than omitted:
      // omitting it binds every interface, which silently exposes an
      // unauthenticated feed to the network.
      this.wss = new WebSocket.Server({ port, host });
      logger.info(`WebSocket server started on ${host}:${port}`);
    }

    // Register config subscriptions as persistent so they are visible in `list`
    // and are never torn down because of client churn.
    for (const sub of config.subscriptions) {
      const key = `${sub.symbol}_${sub.timeframe}`;
      this.activeSubscriptions.set(key, sub);
      this.persistentSubscriptions.add(key);
      logger.info('[DIAG] Registered persistent subscription %s/%s from config', sub.symbol, sub.timeframe);
    }

    // Handle new connections
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    // Handle server errors
    this.wss.on('error', (error) => {
      logger.error(`WebSocket server error: ${error.message}`);
    });
  }

  // Handle new connection
  private handleConnection(ws: WebSocket) {
    logger.info('New WebSocket client connected');
    this.clients.add(ws);
    this.clientSubscriptions.set(ws, new Set());

    // Send welcome message
    this.sendMessage(ws, {
      type: MessageType.INFO,
      success: true,
      message: 'Connected to TradingView WebSocket Server'
    });

    // Handle messages from client
    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message) as WSRequest;
        this.handleMessage(ws, data);
      } catch (error) {
        logger.error(`Failed to parse WebSocket message: ${error.message}`);
        this.sendMessage(ws, {
          type: MessageType.ERROR,
          success: false,
          message: 'Invalid JSON message'
        });
      }
    });

    // Handle disconnection
    ws.on('close', async () => {
      logger.info('[DIAG] ws.on(close) triggered. activeSubscriptions: %d', this.activeSubscriptions.size);
      this.clients.delete(ws);
      // Detach this client from every subscription it held. Persistent subscriptions
      // are left intact; client-only ones are torn down when nobody else wants them.
      const subs = this.clientSubscriptions.get(ws);
      if (subs) {
        for (const key of Array.from(subs)) {
          const { symbol, timeframe } = parseSubscriptionKey(key);
          this.detachClient(ws, symbol, timeframe);
        }
      }
      this.clientSubscriptions.delete(ws);
      this.declinedPersistent.delete(ws);
      logger.info(
        '[DIAG] clients.size after delete: %d. Active subscriptions: %o. Persistent: %o',
        this.clients.size, Array.from(this.activeSubscriptions.keys()), Array.from(this.persistentSubscriptions)
      );
      if (this.clients.size === 0) {
        logger.info(
          '[DIAG] No WebSocket clients left; keeping %d persistent subscription(s) alive',
          this.persistentSubscriptions.size
        );
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error(`WebSocket client error: ${error.message}`);
    });
  }

  // Handle incoming messages
  private handleMessage(ws: WebSocket, data: WSRequest) {
    logger.info(`Received WebSocket message: ${JSON.stringify(data)}`);

    switch (data.action) {
      case MessageType.SUBSCRIBE:
        this.handleSubscribe(ws, data);
        break;
      
      case MessageType.UNSUBSCRIBE:
        this.handleUnsubscribe(ws, data);
        break;
      
      case MessageType.LIST:
        this.handleList(ws, data);
        break;
      
      case MessageType.SUBSCRIBE_MANY:
        this.handleSubscribeMany(ws, data);
        break;
      
      case MessageType.UNSUBSCRIBE_MANY:
        this.handleUnsubscribeMany(ws, data);
        break;
      
      default:
        this.sendMessage(ws, {
          type: MessageType.ERROR,
          requestId: data.requestId,
          success: false,
          message: `Unknown action: ${data.action}`
        });
    }
  }

  // Handle subscription request
  private handleSubscribe(ws: WebSocket, data: WSRequest) {
    if (!data.symbol || !data.timeframe) {
      return this.sendMessage(ws, {
        type: MessageType.ERROR,
        requestId: data.requestId,
        success: false,
        message: 'Symbol and timeframe are required for subscription'
      });
    }

    const key = `${data.symbol}_${data.timeframe}`;
    const clientSubs = this.clientSubscriptions.get(ws);

    // Already subscribed by this client - just confirm
    if (clientSubs && clientSubs.has(key)) {
      return this.sendMessage(ws, {
        type: MessageType.SUBSCRIBE,
        requestId: data.requestId,
        success: true,
        message: 'Already subscribed',
        symbol: data.symbol,
        timeframe: data.timeframe
      });
    }

    const created = this.attachClient(ws, data.symbol, data.timeframe);

    this.sendMessage(ws, {
      type: MessageType.SUBSCRIBE,
      requestId: data.requestId,
      success: true,
      message: created ? 'Subscription created' : 'Subscribed (shared)',
      symbol: data.symbol,
      timeframe: data.timeframe
    });
  }

  // Handle unsubscription request
  private handleUnsubscribe(ws: WebSocket, data: WSRequest) {
    if (!data.symbol || !data.timeframe) {
      return this.sendMessage(ws, {
        type: MessageType.ERROR,
        requestId: data.requestId,
        success: false,
        message: 'Symbol and timeframe are required for unsubscription'
      });
    }

    const key = `${data.symbol}_${data.timeframe}`;
    const clientSubs = this.clientSubscriptions.get(ws);
    const wasAttached = !!clientSubs && clientSubs.has(key);
    const isPersistent = this.persistentSubscriptions.has(key);

    // A client can only drop what it asked for, unless the subscription is
    // service-wide - in that case it may simply stop receiving it.
    if (!wasAttached && !isPersistent) {
      return this.sendMessage(ws, {
        type: MessageType.UNSUBSCRIBE,
        requestId: data.requestId,
        success: false,
        message: 'Subscription not found for this client',
        symbol: data.symbol,
        timeframe: data.timeframe
      });
    }

    this.detachClient(ws, data.symbol, data.timeframe);

    this.sendMessage(ws, {
      type: MessageType.UNSUBSCRIBE,
      requestId: data.requestId,
      success: true,
      message: isPersistent
        ? 'Unsubscribed (service-wide subscription kept alive)'
        : 'Unsubscribed successfully',
      symbol: data.symbol,
      timeframe: data.timeframe
    });
  }

  // Handle get subscription list request
  private handleList(ws: WebSocket, data: WSRequest) {
    const subscriptions = Array.from(this.activeSubscriptions.values());
    
    this.sendMessage(ws, {
      type: MessageType.LIST,
      requestId: data.requestId,
      success: true,
      subscriptions
    });
  }

  /**
   * Attach a client to a subscription and, if nobody else wanted it yet, create the
   * underlying TradingView subscription.
   *
   * @returns true if this call created the underlying TradingView subscription
   */
  private attachClient(ws: WebSocket, symbol: string, timeframe: string): boolean {
    const key = `${symbol}_${timeframe}`;

    let clientSubs = this.clientSubscriptions.get(ws);
    if (!clientSubs) {
      clientSubs = new Set();
      this.clientSubscriptions.set(ws, clientSubs);
    }
    clientSubs.add(key);

    // Explicitly subscribing overrides an earlier opt-out from this subscription.
    const declined = this.declinedPersistent.get(ws);
    if (declined) {
      declined.delete(key);
    }

    let clients = this.subscriptionClients.get(key);
    if (!clients) {
      clients = new Set();
      this.subscriptionClients.set(key, clients);
    }
    clients.add(ws);

    const alreadyActive = this.activeSubscriptions.has(key);
    if (!alreadyActive) {
      const subscription: Subscription = { symbol, timeframe };
      this.activeSubscriptions.set(key, subscription);
      this.emit('subscribe', subscription);
      logger.info('First client subscribed to %s/%s, subscribing to TradingView', symbol, timeframe);
    }

    return !alreadyActive;
  }

  /**
   * Detach a client from a subscription. The underlying TradingView subscription is
   * removed only when no client wants it anymore AND it is not a persistent
   * (config-defined) subscription.
   */
  private detachClient(ws: WebSocket, symbol: string, timeframe: string): void {
    const key = `${symbol}_${timeframe}`;

    const clientSubs = this.clientSubscriptions.get(ws);
    if (clientSubs) {
      clientSubs.delete(key);
    }

    const clients = this.subscriptionClients.get(key);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.subscriptionClients.delete(key);
      }
    }

    const stillWanted =
      this.subscriptionClients.has(key) || this.persistentSubscriptions.has(key);

    if (!stillWanted && this.activeSubscriptions.has(key)) {
      this.activeSubscriptions.delete(key);
      this.emit('unsubscribe', { symbol, timeframe });
      logger.info('Last client unsubscribed from %s/%s, unsubscribing from TradingView', symbol, timeframe);
    } else if (this.persistentSubscriptions.has(key)) {
      // The subscription stays alive service-wide, but this client asked to stop
      // receiving it - remember that so broadcastBar() honours the opt-out.
      let declined = this.declinedPersistent.get(ws);
      if (!declined) {
        declined = new Set();
        this.declinedPersistent.set(ws, declined);
      }
      declined.add(key);
      logger.info('Client opted out of persistent subscription %s/%s (kept alive service-wide)', symbol, timeframe);
    }
  }

  // Bulk subscription
  private handleSubscribeMany(ws: WebSocket, data: WSRequest) {
    if (!Array.isArray(data.pairs) || data.pairs.length === 0) {
      return this.sendMessage(ws, {
        type: MessageType.ERROR,
        requestId: data.requestId,
        success: false,
        message: 'pairs[] required for subscribe_many'
      });
    }
    const results = data.pairs.map(pair => {
      if (!pair.symbol || !pair.timeframe) {
        logger.warn('[DIAG] Skipping invalid pair in subscribe_many: %o', pair);
        return { ...pair, success: false, message: 'symbol and timeframe required' };
      }
      const key = `${pair.symbol}_${pair.timeframe}`;
      const clientSubs = this.clientSubscriptions.get(ws);
      if (clientSubs && clientSubs.has(key)) {
        return { ...pair, success: true, message: 'Already subscribed' };
      }
      const created = this.attachClient(ws, pair.symbol, pair.timeframe);
      logger.info('[DIAG] subscribe_many %s/%s (created=%s)', pair.symbol, pair.timeframe, created);
      return { ...pair, success: true, message: created ? 'Subscription created' : 'Subscribed (shared)' };
    });
    this.sendMessage(ws, {
      type: MessageType.SUBSCRIBE_MANY,
      requestId: data.requestId,
      success: true,
      message: 'Bulk subscribe processed',
      subscriptions: this.getActiveSubscriptions(),
      results
    } as any);
  }

  // Bulk unsubscription
  private handleUnsubscribeMany(ws: WebSocket, data: WSRequest) {
    if (!Array.isArray(data.pairs) || data.pairs.length === 0) {
      return this.sendMessage(ws, {
        type: MessageType.ERROR,
        requestId: data.requestId,
        success: false,
        message: 'pairs[] required for unsubscribe_many'
      });
    }
    const results = data.pairs.map(pair => {
      if (!pair.symbol || !pair.timeframe) {
        return { ...pair, success: false, message: 'symbol and timeframe required' };
      }
      const key = `${pair.symbol}_${pair.timeframe}`;
      if (!this.activeSubscriptions.has(key)) {
        return { ...pair, success: false, message: 'Subscription not found' };
      }
      const isPersistent = this.persistentSubscriptions.has(key);
      this.detachClient(ws, pair.symbol, pair.timeframe);
      return {
        ...pair,
        success: true,
        message: isPersistent
          ? 'Unsubscribed (service-wide subscription kept alive)'
          : 'Unsubscribed successfully'
      };
    });
    this.sendMessage(ws, {
      type: MessageType.UNSUBSCRIBE_MANY,
      requestId: data.requestId,
      success: true,
      message: 'Bulk unsubscribe processed',
      subscriptions: this.getActiveSubscriptions(),
      results
    } as any);
  }

  // Send message to client
  private sendMessage(ws: WebSocket, data: WSResponse) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // Send a bar to the clients that actually asked for it.
  //
  // A client receives the bar when it holds an explicit subscription for the
  // symbol/timeframe, or when the subscription is service-wide (defined in
  // SUBSCRIPTIONS or added via addSubscription), since those are broadcast to
  // every connected client.
  public broadcastBar(bar: Bar) {
    const key = `${bar.symbol}_${bar.timeframe}`;
    const message: WSResponse = {
      type: MessageType.BAR,
      bar
    };
    const payload = JSON.stringify(message);

    if (this.persistentSubscriptions.has(key)) {
      this.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        // Honour explicit opt-outs from service-wide subscriptions.
        const declined = this.declinedPersistent.get(client);
        if (declined && declined.has(key)) return;
        client.send(payload);
      });
      return;
    }

    const subscribers = this.subscriptionClients.get(key);
    if (!subscribers || subscribers.size === 0) return;

    subscribers.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
  }

  // Get list of active subscriptions
  public getActiveSubscriptions(): Subscription[] {
    return Array.from(this.activeSubscriptions.values());
  }

  // Check if subscription exists
  public hasSubscription(symbol: string, timeframe: string): boolean {
    return this.activeSubscriptions.has(`${symbol}_${timeframe}`);
  }

  // Add subscription programmatically (without client request).
  // Programmatic subscriptions are service-owned, so they are persistent.
  public addSubscription(subscription: Subscription) {
    const key = `${subscription.symbol}_${subscription.timeframe}`;
    this.persistentSubscriptions.add(key);
    if (!this.activeSubscriptions.has(key)) {
      this.activeSubscriptions.set(key, subscription);
      this.emit('subscribe', subscription);
      return true;
    }
    return false;
  }

  // Remove subscription programmatically (without client request)
  public removeSubscription(symbol: string, timeframe: string) {
    const key = `${symbol}_${timeframe}`;
    this.persistentSubscriptions.delete(key);
    if (this.activeSubscriptions.has(key)) {
      this.activeSubscriptions.delete(key);
      this.emit('unsubscribe', { symbol, timeframe });
      return true;
    }
    return false;
  }

  // Close all connections and stop server
  public close() {
    this.wss.close(() => {
      logger.info('WebSocket server closed');
    });
  }
} 