#!/usr/bin/env node
/**
 * Tests for the reconnect and opt-out fixes:
 *
 *  1. A client that unsubscribes from a persistent subscription must stop
 *     receiving its bars (the reply promises exactly that).
 *  2. Re-subscribing restores delivery.
 *  3. A full reconnect restores all subscriptions instead of losing them.
 *
 * Usage: node examples/reconnect-test.js
 */
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:8081';
const HEALTH = process.env.HEALTH_URL || 'http://localhost:8082';
const SYMBOL = process.env.CONFIG_SYMBOL || 'BINANCE:BTCUSDT';
const TF = process.env.CONFIG_TF || '1';
const KEY = `${SYMBOL}_${TF}`;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const messages = [];
    ws.on('message', (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch (_) {}
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

function waitFor(messages, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const hit = messages.find(pred);
      if (hit) {
        clearInterval(tick);
        resolve(hit);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error('timeout waiting for message'));
      }
    }, 50);
  });
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));
const barsFor = (msgs, sym, tf) =>
  msgs.filter((m) => m.type === 'bar' && m.bar.symbol === sym && m.bar.timeframe === tf);

(async () => {
  const c = await connect();

  // --- 1. baseline: persistent bars arrive -----------------------------
  await sleep(12000);
  const before = barsFor(c.messages, SYMBOL, TF).length;
  check('receives persistent bars before opting out', before > 0, `${before} bar(s)`);

  // --- 2. opt out -------------------------------------------------------
  send(c.ws, { action: 'unsubscribe', symbol: SYMBOL, timeframe: TF, requestId: 'opt-out' });
  const ack = await waitFor(c.messages, (m) => m.requestId === 'opt-out');
  check('opt-out acknowledged', ack.success === true, ack.message);

  const mark = c.messages.length;
  await sleep(12000);
  const during = barsFor(c.messages.slice(mark), SYMBOL, TF).length;
  check('stops receiving bars after opting out', during === 0, `${during} bar(s)`);

  // --- 3. opt back in ---------------------------------------------------
  send(c.ws, { action: 'subscribe', symbol: SYMBOL, timeframe: TF, requestId: 'opt-in' });
  await waitFor(c.messages, (m) => m.requestId === 'opt-in');

  const mark2 = c.messages.length;
  await sleep(12000);
  const after = barsFor(c.messages.slice(mark2), SYMBOL, TF).length;
  check('receives bars again after re-subscribing', after > 0, `${after} bar(s)`);

  c.ws.close();
  await sleep(1500);

  // --- 4. full reconnect restores subscriptions --------------------------
  const res = await fetch(`${HEALTH}/recovery/full-reconnect`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  check('full reconnect endpoint succeeded', res.ok && body.status === 'success', JSON.stringify(body));

  await sleep(15000);

  const status = await fetch(`${HEALTH}/status`).then((r) => r.json());
  const subs = (status.tradingview?.subscriptions || []).map((s) => `${s.symbol}_${s.timeframe}`);
  check('subscriptions restored after full reconnect', subs.includes(KEY), `got ${JSON.stringify(subs)}`);
  check('tradingview connected after full reconnect', status.tradingview?.connected === true, String(status.tradingview?.connected));

  // --- 5. data actually flows again -------------------------------------
  const d = await connect();
  await sleep(12000);
  const resumed = barsFor(d.messages, SYMBOL, TF).length;
  check('bars flow again after reconnect', resumed > 0, `${resumed} bar(s)`);
  d.ws.close();

  await sleep(1000);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test error:', err.message);
  process.exit(1);
});
