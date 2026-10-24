#!/usr/bin/env node
/**
 * Liveness + latency test for the tv-fetcher WebSocket API.
 *
 * Subscribes to one symbol and measures:
 *   - message rate and inter-arrival times
 *   - first update lag after a bar period starts
 *   - last update lag before a bar period ends
 *   - close price delta vs. Binance REST spot (bps), when reachable
 *
 * Usage:
 *   node examples/latency-test.js
 *   SYMBOL=BINANCE:ETHUSDT TF=5 DURATION_MS=60000 node examples/latency-test.js
 */
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:8081';
const SYMBOL = process.env.SYMBOL || 'BINANCE:BTCUSDT';
const TF = process.env.TF || '1';
const DURATION_MS = Number(process.env.DURATION_MS || 40000);
const REST_SYMBOL = SYMBOL.split(':').pop();

function tfToMs(tf) {
  if (tf === 'D') return 86400000;
  if (tf === 'W') return 7 * 86400000;
  if (tf === 'M') return 30 * 86400000;
  return parseInt(tf) * 60000;
}

const bars = [];
const rest = [];
let welcome = null;
let subAck = null;
let listAck = null;

function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: s[0],
    p50: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1],
  };
}

async function pollRest() {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${REST_SYMBOL}`);
    if (!r.ok) return;
    const j = await r.json();
    if (j.price) rest.push({ t: Date.now(), p: Number(j.price) });
  } catch (_) {
    /* exchange unreachable - freshness comparison skipped */
  }
}

const ws = new WebSocket(URL);

ws.on('open', () => {
  console.log(`[test] connected to ${URL}`);
  ws.send(JSON.stringify({ action: 'list', requestId: 'l1' }));
  ws.send(JSON.stringify({ action: 'subscribe', symbol: SYMBOL, timeframe: TF, requestId: 's1' }));

  const timer = setInterval(pollRest, 1000);
  pollRest();

  setTimeout(() => {
    clearInterval(timer);
    finish();
  }, DURATION_MS);
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (_) {
    return;
  }

  if (msg.type === 'bar') {
    if (msg.bar.symbol === SYMBOL && msg.bar.timeframe === TF) {
      bars.push({ recv: Date.now(), ...msg.bar });
    }
    return;
  }
  if (msg.type === 'info') welcome = msg;
  if (msg.type === 'list') listAck = msg;
  if (msg.requestId === 's1') subAck = msg;
});

ws.on('error', (e) => console.error('[test] ws error:', e.message));

function finish() {
  const intervalMs = tfToMs(TF);

  const intervals = [];
  for (let i = 1; i < bars.length; i++) intervals.push(bars[i].recv - bars[i - 1].recv);
  const ivStats = stats(intervals);

  const byPeriod = new Map();
  for (const b of bars) {
    const e = byPeriod.get(b.time);
    if (!e) {
      byPeriod.set(b.time, { first: b.recv, last: b.recv, lastClose: b.close, n: 1 });
    } else {
      e.last = b.recv;
      e.lastClose = b.close;
      e.n++;
    }
  }

  const testEnd = Date.now();
  const firstLag = [];
  const lastLag = [];
  const periodRows = [];
  for (const [time, e] of byPeriod) {
    const start = time * 1000;
    const end = start + intervalMs;
    // Only a period that closed before the test ended can tell us about end-of-bar lag
    const complete = end <= testEnd;
    const first = e.first - start;
    const last = complete ? end - e.last : null;
    firstLag.push(first);
    if (complete) lastLag.push(last);
    periodRows.push({ time, first, last, complete, updates: e.n });
  }

  console.log('\n=== PER PERIOD ===');
  for (const r of periodRows) {
    const tail = r.complete ? `last update -${(r.last / 1000).toFixed(2)}s before close` : '(period still open at test end)';
    console.log(
      `  ${new Date(r.time * 1000).toISOString()}  updates ${String(r.updates).padStart(3)}  first +${(r.first / 1000).toFixed(2)}s  ${tail}`
    );
  }

  console.log('\n=== CONNECTION ===');
  console.log('welcome      :', welcome ? welcome.message : '(none)');
  console.log('subscribe ack:', subAck ? `${subAck.success} - ${subAck.message}` : '(none)');
  console.log('initial list :', listAck ? JSON.stringify(listAck.subscriptions) : '(none)');

  console.log('\n=== BAR FLOW ===');
  console.log(`messages for ${SYMBOL}/${TF}: ${bars.length} in ${(DURATION_MS / 1000).toFixed(0)}s`);
  if (bars.length) {
    const span = (bars[bars.length - 1].recv - bars[0].recv) / 1000;
    console.log(`rate         : ${(bars.length / Math.max(span, 1)).toFixed(2)} msgs/s`);
    console.log('bar periods  :', byPeriod.size);
    console.log('distinct closes:', new Set(bars.map((b) => b.close)).size);
  }
  if (ivStats) {
    console.log(`inter-arrival: min ${ivStats.min}ms  p50 ${ivStats.p50}ms  p90 ${ivStats.p90}ms  max ${ivStats.max}ms`);
  }

  const fl = stats(firstLag);
  if (fl) {
    console.log(`first update after period start: p50 ${(fl.p50 / 1000).toFixed(2)}s  p90 ${(fl.p90 / 1000).toFixed(2)}s  max ${(fl.max / 1000).toFixed(2)}s`);
  }
  const ll = stats(lastLag);
  if (ll) {
    console.log(`last update before period end  : p50 ${(ll.p50 / 1000).toFixed(2)}s  p90 ${(ll.p90 / 1000).toFixed(2)}s  max ${(ll.max / 1000).toFixed(2)}s`);
    console.log('  (small values = delivered right up to bar close)');
  }

  if (bars.length) console.log('last bar     :', JSON.stringify(bars[bars.length - 1]));

  console.log('\n=== FRESHNESS vs Binance REST ===');
  if (!rest.length) {
    console.log('REST samples : 0 (exchange API unreachable from this host - skipped)');
  } else {
    const diffs = [];
    for (const b of bars) {
      const nxt = rest.find((r) => r.t >= b.recv && r.t - b.recv < 1500);
      if (nxt && nxt.p > 0) diffs.push((Math.abs(b.close - nxt.p) / nxt.p) * 10000);
    }
    const ds = stats(diffs);
    console.log(`REST samples : ${rest.length}  compared: ${ds ? ds.n : 0}`);
    if (ds) console.log(`delta bps    : p50 ${ds.p50.toFixed(2)}  p90 ${ds.p90.toFixed(2)}  max ${ds.max.toFixed(2)}`);
  }

  console.log('\n=== VERDICT ===');
  console.log(bars.length === 0 ? 'FAIL: no bar messages received' : 'PASS: real-time bars delivered over the WebSocket API');

  ws.close();
  process.exit(bars.length === 0 ? 1 : 0);
}
