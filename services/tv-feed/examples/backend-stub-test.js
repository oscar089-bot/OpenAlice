#!/usr/bin/env node
/**
 * Verifies backend delivery semantics against a stub HTTP endpoint.
 *
 * Starts a stub server, points the service at it via BACKEND_ENDPOINT, and
 * asserts:
 *   1. Every POST has closed:true (no forming-candle ticks reach the backend).
 *   2. At most one POST per (symbol, timeframe, time) - no duplicate rows.
 *   3. At least one POST arrives for a 1m symbol within the window.
 *
 * Usage:
 *   STUB_PORT=3999 node examples/backend-stub-test.js
 *   (requires the service to be started with BACKEND_ENDPOINT=http://127.0.0.1:3999/bar)
 */
const http = require('http');

const PORT = Number(process.env.STUB_PORT || 3999);
const DURATION_MS = Number(process.env.DURATION_MS || 100000);

const received = [];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      received.push({ at: Date.now(), payload });
    } catch (_) {
      received.push({ at: Date.now(), payload: null, raw: body });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

server.listen(PORT, () => {
  console.log(`[stub] listening on ${PORT}, collecting for ${DURATION_MS / 1000}s`);
});

setTimeout(() => {
  console.log(`\n=== RECEIVED ${received.length} POST(S) ===`);

  const parsed = received.filter((r) => r.payload);
  check('backend received at least one bar', parsed.length > 0, `${parsed.length} post(s)`);

  const open = parsed.filter((r) => r.payload.closed !== true);
  check(
    'no forming-candle ticks reached the backend',
    open.length === 0,
    `${open.length} non-final post(s)`
  );

  const keys = parsed.map((r) => `${r.payload.symbol}_${r.payload.timeframe}_${r.payload.time}`);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  check('no duplicate (symbol, timeframe, time) rows', dupes.length === 0, dupes.slice(0, 3).join(', '));

  // Show a few samples so the payload shape is visible.
  for (const r of parsed.slice(0, 4)) {
    console.log(
      `  ${r.payload.symbol}/${r.payload.timeframe} t=${r.payload.time} closed=${r.payload.closed} C=${r.payload.close}`
    );
  }

  const perSymbol = {};
  for (const r of parsed) {
    const k = `${r.payload.symbol}/${r.payload.timeframe}`;
    perSymbol[k] = (perSymbol[k] || 0) + 1;
  }
  console.log('  per symbol:', JSON.stringify(perSymbol));

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}, DURATION_MS);
