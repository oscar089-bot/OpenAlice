#!/usr/bin/env node
/**
 * Regression test for the subscription lifecycle bugs:
 *
 *  1. Config SUBSCRIPTIONS must survive a client connecting and disconnecting.
 *  2. `list` must include config subscriptions (previously returned []).
 *  3. Unsubscribing from a persistent subscription must NOT tear it down.
 *  4. Bars must only go to clients that asked for them.
 *
 * Usage: node examples/regression-test.js
 */
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:8081';
const CONFIG_SYMBOL = process.env.CONFIG_SYMBOL || 'BINANCE:BTCUSDT';
const CONFIG_TF = process.env.CONFIG_TF || '1';
const EXTRA_SYMBOL = 'BINANCE:SOLUSDT';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const key = `${CONFIG_SYMBOL}_${CONFIG_TF}`;

  // --- 1. connect, ask for the list -------------------------------------
  const a = await connect();
  send(a.ws, { action: 'list', requestId: 'a-list' });
  const listA = await waitFor(a.messages, (m) => m.requestId === 'a-list');
  const keysA = (listA.subscriptions || []).map((s) => `${s.symbol}_${s.timeframe}`);
  check('list includes config subscriptions', keysA.includes(key), `got ${JSON.stringify(keysA)}`);

  // --- 2. subscribe to an extra symbol ----------------------------------
  send(a.ws, { action: 'subscribe', symbol: EXTRA_SYMBOL, timeframe: CONFIG_TF, requestId: 'a-extra' });
  const extraAck = await waitFor(a.messages, (m) => m.requestId === 'a-extra');
  check('extra subscribe acknowledged', extraAck.success === true, extraAck.message);

  // --- 3. a second client must NOT receive the extra symbol's bars ------
  const b = await connect();
  await sleep(10000); // long enough for at least one BTC bar

  const bExtraBars = b.messages.filter((m) => m.type === 'bar' && m.bar.symbol === EXTRA_SYMBOL);
  check('client B does not receive client A\'s extra bars', bExtraBars.length === 0, `${bExtraBars.length} bar(s)`);

  const bConfigBars = b.messages.filter((m) => m.type === 'bar' && `${m.bar.symbol}_${m.bar.timeframe}` === key);
  check('client B does receive persistent config bars', bConfigBars.length > 0, `${bConfigBars.length} bar(s)`);

  // --- 4. disconnect the subscribing client, config subs must survive ---
  a.ws.close();
  await sleep(2000);

  const c = await connect();
  send(c.ws, { action: 'list', requestId: 'c-list' });
  const listC = await waitFor(c.messages, (m) => m.requestId === 'c-list');
  const keysC = (listC.subscriptions || []).map((s) => `${s.symbol}_${s.timeframe}`);
  check('config subscriptions survive client disconnect', keysC.includes(key), `got ${JSON.stringify(keysC)}`);
  check(
    'client-only subscription was cleaned up',
    !keysC.some((k) => k.startsWith(EXTRA_SYMBOL)),
    `got ${JSON.stringify(keysC)}`
  );

  // --- 5. unsubscribing a persistent sub must not kill it ---------------
  send(c.ws, { action: 'unsubscribe', symbol: CONFIG_SYMBOL, timeframe: CONFIG_TF, requestId: 'c-unsub' });
  const unsubAck = await waitFor(c.messages, (m) => m.requestId === 'c-unsub');
  check('unsubscribe of persistent sub succeeds', unsubAck.success === true, unsubAck.message);

  send(c.ws, { action: 'list', requestId: 'c-list2' });
  const listC2 = await waitFor(c.messages, (m) => m.requestId === 'c-list2');
  const keysC2 = (listC2.subscriptions || []).map((s) => `${s.symbol}_${s.timeframe}`);
  check('persistent subscription still active after unsubscribe', keysC2.includes(key), `got ${JSON.stringify(keysC2)}`);

  c.ws.close();
  b.ws.close();

  await sleep(1500);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test error:', err.message);
  process.exit(1);
});
