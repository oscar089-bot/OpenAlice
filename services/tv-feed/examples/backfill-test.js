#!/usr/bin/env node
/**
 * Deterministic test for post-reconnect backfill.
 *
 * Scenario: a subscription is running and has emitted closed bars up to T1.
 * The socket drops. While offline, candles T2..T4 close. On reconnect the
 * vendor replays history (100 bars), which still contains T2..T4.
 *
 * Expected: the missing candles are emitted as 'bar_closed' exactly once each,
 * in chronological order, and already-emitted candles are NOT re-emitted.
 *
 * Uses a fake vendor injected via require cache - no live TradingView needed.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'tradingview_vendor', 'main.js');
const TV_DIST = path.join(ROOT, 'dist', 'tradingview.js');

const MIN = 60;
const T0 = 1792000000 - (1792000000 % MIN); // aligned minute timestamp

// History the vendor "replays" after the reconnect, newest first.
// Newest entry is the still-forming candle.
const replay = [
  { time: T0 + 5 * MIN, open: 15, max: 16, min: 14, close: 15.5, volume: 5 }, // forming
  { time: T0 + 4 * MIN, open: 14, max: 15, min: 13, close: 14.5, volume: 4 }, // missed
  { time: T0 + 3 * MIN, open: 13, max: 14, min: 12, close: 13.5, volume: 3 }, // missed
  { time: T0 + 2 * MIN, open: 12, max: 13, min: 11, close: 12.5, volume: 2 }, // missed
  { time: T0 + 1 * MIN, open: 11, max: 12, min: 10, close: 11.5, volume: 1 }, // already emitted
];

const instances = [];
let chartIndex = 0;

class FakeChart {
  constructor() {
    this.infos = { description: 'Fake' };
    this.periods = [];
    this.updateCbs = [];
    this.symbolCbs = [];
    chartIndex++;
    FakeChart.lastInstance = this;
  }
  onError() {}
  onSymbolLoaded(cb) { this.symbolCbs.push(cb); setTimeout(cb, 5); }
  onUpdate(cb) { this.updateCbs.push(cb); }
  setMarket() {}
  delete() {}

  // Test helper: push a full periods snapshot and fire onUpdate.
  emit(periods) {
    this.periods = periods;
    this.updateCbs.forEach((cb) => cb());
  }
}

class FakeClient {
  constructor() {
    this.disconnectCbs = [];
    this.errorCbs = [];
    this.Session = { Chart: FakeChart };
    this.charts = [];
    instances.push(this);
  }
  onDisconnected(cb) { this.disconnectCbs.push(cb); }
  onError(cb) { this.errorCbs.push(cb); }
  end() {
    setTimeout(() => this.disconnectCbs.forEach((cb) => cb()), 10);
    return Promise.resolve();
  }
  simulateDrop() { this.disconnectCbs.forEach((cb) => cb()); }
}

require.cache[require.resolve(VENDOR)] = {
  id: VENDOR,
  filename: VENDOR,
  loaded: true,
  exports: { Client: FakeClient },
};

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
  const closed = [];
  client.on('bar_closed', (b) => closed.push(b.time));

  await client.connect();
  await client.subscribe({ symbol: 'EXCH:GAP', timeframe: '1' });

  // Emit an initial snapshot where T0+1 is the forming candle, so T0 closes.
  const chartA = findChart();
  chartA.emit([
    { time: T0 + 0 * MIN, open: 10, max: 11, min: 9, close: 10.5, volume: 1 },
  ]);
  await sleep(30);
  check('no close emitted while the first candle is forming', closed.length === 0, JSON.stringify(closed));

  // Second snapshot: T0+1 is now forming, so T0 rolls over and closes.
  chartA.emit([
    { time: T0 + 1 * MIN, open: 11, max: 12, min: 10, close: 11.5, volume: 1 },
    { time: T0 + 0 * MIN, open: 10, max: 11, min: 9, close: 10.5, volume: 1 },
  ]);
  await sleep(50);
  check('emitted T0 close before the drop', closed.includes(T0), JSON.stringify(closed));

  // --- drop + reconnect ------------------------------------------------
  instances[0].simulateDrop();
  for (let i = 0; i < 100 && instances.length < 2; i++) await sleep(200);
  check('reconnected', instances.length === 2, `${instances.length} instances`);

  // Wait for restore + first update window.
  for (let i = 0; i < 50 && client.getSubscriptions().length === 0; i++) await sleep(100);
  await sleep(300);

  // Vendor replays history that spans the outage.
  const chartB = findChart();
  chartB.emit(replay);
  await sleep(100);

  const missed = [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN];
  check('backfilled all candles that closed during the outage',
    missed.every((t) => closed.includes(t)), JSON.stringify(closed));

  // T0+1 was the forming candle when the drop happened, so it never closed
  // before the outage. Backfill must deliver it exactly once (not zero, not twice).
  check('delivered the candle that was forming at drop time exactly once',
    closed.filter((t) => t === T0 + 1 * MIN).length === 1,
    `count=${closed.filter((t) => t === T0 + 1 * MIN).length}`);

  check('did not emit the still-forming candle', !closed.includes(T0 + 5 * MIN), JSON.stringify(closed));

  const backfilled = closed.filter((t) => missed.includes(t));
  check('backfilled in chronological order',
    backfilled.length === 3 && backfilled[0] < backfilled[1] && backfilled[1] < backfilled[2],
    JSON.stringify(backfilled));

  check('no candle emitted twice', new Set(closed).size === closed.length, JSON.stringify(closed));

  client.close();
  await sleep(100);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test error:', err.stack || err.message);
  process.exit(1);
});

// The client keeps charts in a private map, so reach the live one through the
// most recent FakeChart constructed after the latest connect.
function findChart() {
  // FakeChart instances are created via new this.client.Session.Chart();
  // The constructor records the latest one on the class for lookup.
  return FakeChart.lastInstance;
}
