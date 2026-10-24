#!/usr/bin/env node
/**
 * Deterministic test for the UNEXPECTED vendor disconnect path.
 *
 * We cannot reliably kill the live TCP connection from userland, so instead we
 * inject a fake vendor client into Node's require cache before loading the real
 * compiled TradingViewClient. This exercises the production code path:
 *
 *   vendor 'disconnected' -> handleVendorDisconnect -> charts cleared
 *     -> scheduleReconnect -> connect() -> restoreDesiredSubscriptions()
 *
 * It also asserts that a deliberate close() does NOT cause a reconnect loop.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'tradingview_vendor', 'main.js');
const TV_DIST = path.join(ROOT, 'dist', 'tradingview.js');

// --- fake vendor ---------------------------------------------------------
const instances = [];

class FakeChart {
  constructor() {
    this.infos = { description: 'Fake' };
    this.periods = [{ time: Math.floor(Date.now() / 1000), open: 1, max: 2, min: 0.5, close: 1.5, volume: 10 }];
  }
  onError() {}
  onSymbolLoaded(cb) { setTimeout(cb, 5); }
  onUpdate() {}
  setMarket() {}
  delete() {}
}

class FakeClient {
  constructor() {
    this.disconnectCbs = [];
    this.errorCbs = [];
    this.ended = false;
    this.Session = { Chart: FakeChart };
    instances.push(this);
  }
  onDisconnected(cb) { this.disconnectCbs.push(cb); }
  onError(cb) { this.errorCbs.push(cb); }
  end() {
    this.ended = true;
    // The real vendor's end() closes its socket, whose 'close' handler emits
    // 'disconnected'. Mirror that so the intentionalClose guard is exercised.
    setTimeout(() => this.disconnectCbs.forEach((cb) => cb()), 10);
    return Promise.resolve();
  }
  // Test helper: simulate the socket dropping without us asking for it.
  simulateDrop() { this.disconnectCbs.forEach((cb) => cb()); }
}

require.cache[require.resolve(VENDOR)] = {
  id: VENDOR,
  filename: VENDOR,
  loaded: true,
  exports: { Client: FakeClient },
};

// Config is read at import time; keep it deterministic.
process.env.SUBSCRIPTIONS = '[]';
process.env.WEBSOCKET_ENABLED = 'false';
process.env.TV_API_READY_TIMEOUT_MS = '0';

const { TradingViewClient } = require(TV_DIST);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = new TradingViewClient();
  let disconnects = 0;
  client.on('disconnect', () => disconnects++);

  await client.connect();
  check('connected with fake vendor', client.isConnected() === true);

  await client.subscribe({ symbol: 'EXCH:TEST_PAIR', timeframe: '1' });
  check('subscription recorded', client.getSubscriptions().length === 1, JSON.stringify(client.getSubscriptions()));

  const firstInstance = instances[0];

  // --- unexpected drop --------------------------------------------------
  firstInstance.simulateDrop();
  check('drop marks client disconnected', client.isConnected() === false);
  check('drop emits disconnect event', disconnects === 1, String(disconnects));

  // Reconnect delay is ~5s; wait for the new vendor instance and restore.
  for (let i = 0; i < 100 && instances.length < 2; i++) await sleep(200);
  check('reconnect created a new vendor client', instances.length === 2, `${instances.length} instance(s)`);

  for (let i = 0; i < 100 && client.getSubscriptions().length === 0; i++) await sleep(100);
  await sleep(500);

  check('subscriptions survive the drop', client.getSubscriptions().length === 1, JSON.stringify(client.getSubscriptions()));
  check('client connected again', client.isConnected() === true);
  check('symbol containing underscore preserved', client.getSubscriptions()[0]?.symbol === 'EXCH:TEST_PAIR', JSON.stringify(client.getSubscriptions()[0]));

  // --- deliberate close must not reconnect ------------------------------
  const before = instances.length;
  client.close();
  check('close marks disconnected', client.isConnected() === false);
  await sleep(7000);
  check('close does NOT trigger a reconnect', instances.length === before, `${instances.length - before} extra instance(s)`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test error:', err.stack || err.message);
  process.exit(1);
});
