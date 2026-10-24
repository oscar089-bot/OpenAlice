# TradingView live feed and external MCP

This guide owns two optional integrations that let OpenAlice consume data and
tools it does not produce itself:

1. **TradingView live feed** (`services/tv-feed` + `src/domain/market-data/tv-feed/`)
   — realtime watcher quotes for crypto and forex.
2. **External MCP servers** (`src/services/external-mcp/`) — third-party MCP
   servers Alice connects to as a *client*.

Both are **off by default**. Neither can break an existing install: with them
disabled, watchers use the federated bar layer and no third-party process is
spawned.

## TradingView live feed

### Why it exists

`bars/bar-service.ts` classifies vendor sources honestly:

```ts
yfinance: 'delayed', okx: 'realtime',
```

Crypto watchers therefore already get live candles (OKX is the default crypto
venue). **Forex, equity, index and commodity watchers are delayed** — that delay
is what this feed removes.

The live feed only serves **crypto and forex**. Equity/commodity/index watchers
keep using the bar layer; the service could technically price them, but their
venue mapping is far less reliable and the delayed source is less costly.

### Shape: sidecar process, verbatim code

`services/tv-feed/` is a **verbatim copy** of an independent microservice (a
TradingView WebSocket client plus a small WebSocket API). It is not modified,
not imported, and not part of the pnpm workspace:

```yaml
# pnpm-workspace.yaml
- '!services/tv-feed'
```

That exclusion is deliberate. The service carries its own dependency tree, and
its `express`/`express-ws` peer range would otherwise have to be satisfied by
the monorepo install. Alice never imports this code — it only speaks WebSocket
to it.

Install and run it independently:

```bash
cd services/tv-feed
npm install
npm run build
SUBSCRIPTIONS='[{"symbol":"BINANCE:BTCUSDT","timeframe":"1"}]' \
  WEBSOCKET_PORT=8081 node dist/main.js
```

`SUBSCRIPTIONS` is optional. Alice subscribes on demand, so an empty list is
fine.

### Configuration: `.env` vs Alice's config

The service still reads its own `.env` (`dotenv.config()` is untouched), so
running it by hand works exactly as upstream documented.

Nothing was copied into the repo because the original `.env` holds a **proxy
credential**, and secrets never belong in tracked files. When Alice spawns the
service (`autoStart`), it does not rely on that file: it passes the settings it
owns (`WEBSOCKET_PORT`, `WEBSOCKET_HOST`, `SUBSCRIPTIONS`) through the child's
environment, and `process.env` is inherited for everything else.

Practical rule:

- **Alice-spawned** → configure `tv-feed.json` (`url`, `bindHost`, `enabled`).
  A leftover `.env` would be overridden for those three keys only.
- **Hand-run** → configure `.env` (copy `env.example`). Keep it untracked.

### Alice-side client

`src/domain/market-data/tv-feed/`:

| File | Owns |
|---|---|
| `client.ts` | `TvFeedClient` — socket lifecycle, subscribe-on-demand, in-memory latest-bar cache, reconnect backoff |
| `symbol-map.ts` | Alice symbol → TradingView ticker, and Alice interval → TV resolution |
| `types.ts` | Wire and cache shapes |

Design rules that must not regress:

- **Fail-soft.** `getQuote()` returns `null` for every abnormal condition
  (disabled, disconnected, unsupported interval, unmapped symbol, stale bar).
  It never throws. The watcher then falls back to `barService`.
- **Wait for the handshake.** The first watcher tick after boot lands before
  the socket opens. `getQuote()` awaits the open (bounded by
  `subscribeTimeoutMs`) instead of returning `null` — otherwise every pair
  wastes one tick on every boot.
- **Never regress the cache.** A bar for an *older* period is dropped. The
  service can replay history after a reconnect, and moving the cache backwards
  would make a watcher evaluate a stale price.
- **Staleness is measured locally.** `receivedAt` is Alice's own clock, not the
  bar timestamp, so a service that freezes is detected even if it keeps sending
  an old candle.

### Watcher integration

`workspaces/watch/snapshot.ts` is the only bridge. The merge rule matters:

> History comes from `barService`; the **live price** comes from the feed.

The feed only ever sends the still-forming candle, so it cannot supply history.
`candle_close` rules need confirmed candles behind the live one. `mergeLiveCandle()`:

- live candle **newer** than the last history bar → append;
- live candle **same period** → replace that history bar (its close is a
  delayed snapshot of the same candle);
- live candle **older** → ignore, history wins.

A history failure never vetoes a live price: a level rule can be evaluated from
the live candle alone.

### Price provenance

Every snapshot records **which path served its price**:

```ts
priceSource: { kind: 'tv-feed', ref: 'BINANCE:BTCUSDT' }
priceSource: { kind: 'vendor', ref: 'okx|BTC-USDT', fellBack: true }
```

Persisted on `WatchState.lastPriceSource` and rendered on the watcher card as
`src LIVE` / `src delayed` / `src delayed (live unavailable)`.

This exists because a price is just a number: without provenance, an operator
or an agent asked to verify a watcher has to infer the source, and the obvious
inference is wrong. Nothing on the box is named "tradingview" — the service runs
as `services/tv-feed/dist/main.js` under Alice's process tree — so an agent that
greps for a TradingView process concludes the feed is absent and reports the
watcher as delayed even while it is receiving live push data.

`fellBack: true` is the honest signal: the feed was eligible for this watcher
but did not supply a usable quote on that tick, and the vendor path was used.

### Closed candles and the emit-order trap

The service broadcasts in a counter-intuitive order on a period rollover: the
**new forming candle first**, then the **closed candle for the previous period**
(with an *older* timestamp).

A single-slot "latest bar" cache therefore discarded every close as out of
order, and `candle_close` could never see a confirmed bar even though the fix in
`pushClosedBar` was delivering them. `TvFeedClient` now keeps two slots per
series:

- `cache` — the forming tail (highest timestamp wins);
- `closedBars` — the latest final candle, in its own slot.

`getQuote()` returns both: the live tail plus an optional `lastClosed`. The
snapshot provider folds `lastClosed` into history **before** the forming candle,
because `mergeLiveCandle` discards anything older than its live candle.

`lastClosed` is only reported while it is fresh (`staleMs`). An ancient close
must not let a rule fire on a period the operator already moved past.

### Per-rule candle timeframes

A `candle_close` rule carries its OWN `timeframe`, which may differ from
`watch.timeframe`. The evaluator filters candles strictly by the rule's
timeframe (`matchingCandles`), so serving only the top-level interval would
starve such a rule: it would see zero candles and could never fire.

`requiredSnapshotIntervals()` therefore collects the union of `watch.timeframe`
and every `candle_close` rule timeframe, and the provider fetches each one
(live + history) in parallel. Every candle is labelled with its interval, so the
evaluator's filter selects exactly the right series.

This is what makes a 15m reclaim inside a 1h watcher actually fire on a
**15-minute** close. `price` still comes from the watcher's own timeframe, since
level/zone rules are judged against the primary interval.

Cost: one fetch per distinct interval per tick. Keep the set small.

The feed's `closed` flag is **necessary but not sufficient** for `confirmed`.
It is trusted only when the period has also elapsed by Alice's own clock:

```ts
confirmed: quote.closed && quote.timeMs + span <= nowMs
```

The second half exists because a re-subscribe replays a just-closed period, and
clock skew can deliver `closed` before the period really ended. Measured on a
live 1m subscription, steady-state closes arrive at +60s/+61s, but the initial
subscribe replay can deliver one early. Without the guard, `candle_close` could
fire on a candle that is still forming.

The guard is one-directional: it can only downgrade a suspicious `closed` to
`confirmed: false`, never upgrade a forming candle. So it cannot make a watcher
fire more eagerly than local time allows.

### Configuration

`data/config/tv-feed.json` (`ConfigSection` name: `tvFeed`):

```json
{
  "enabled": true,
  "autoStart": true,
  "url": "ws://127.0.0.1:8081",
  "bindHost": "127.0.0.1",
  "assetClasses": ["crypto", "forex"],
  "staleMs": 5000,
  "subscribeTimeoutMs": 4000
}
```

`assetClasses` is the allow-list the watcher checks before consulting the feed.
Removing `forex` makes forex watchers fall back without disabling the feed.

### Remote / VPS binding

The feed is **unauthenticated**, so it binds loopback by default and exposing it
is a deliberate act. On a VPS, set:

```json
{ "bindHost": "0.0.0.0", "url": "ws://127.0.0.1:8081" }
```

`bindHost` is passed to the child as `WEBSOCKET_HOST`. Keep `url` on loopback
when Alice runs on the same host. If Alice runs elsewhere, point `url` at the
host's address and firewall the port to Alice's IP — there is no auth layer to
stop anyone else from reading prices or opening subscriptions.

Running the service yourself? The same knob exists in its `.env`:

```bash
WEBSOCKET_HOST=0.0.0.0
WEBSOCKET_PORT=8081
```

### Auto-start

`enabled` and `autoStart` both default to `true`, so `pnpm dev`, `pnpm start`, and
packaged Electron all bring the feed up with the other services. The supervisor
lives in `src/domain/market-data/tv-feed/supervisor.ts` and is owned by Alice —
not Guardian — so one implementation covers every launcher.

It is deliberately shallow:

- `resolveFeedEntry()` looks for `services/tv-feed/dist/main.js` under the app
  resources root, then the process cwd. Missing means the operator has not run
  `npm install && npm run build` there yet; the supervisor logs a one-line hint
  and does nothing else. Watchers keep using the bar layer.
- The bind port is derived from `url`, so the service and the client cannot
  disagree about which port to use.
- An unexpected exit restarts with exponential backoff (2s → 60s, capped).
- Alice never blocks on it: the client reconnects on its own, so child-start and
  socket-connect order does not matter.

Set `autoStart: false` to run the service yourself (a remote host, a container,
or a hand-tuned instance) while Alice still consumes it.

**Packaged Electron does not ship the service.** Its 415-package vendor tree is
not bundled into app resources, so `resolveFeedEntry()` finds nothing and the
feed stays off until the operator installs it separately. `pnpm dev` and
`pnpm start` run from the repo and do find it.

### Binding and remote (VPS) access

The service binds **`127.0.0.1` by default** because it is *unauthenticated*:
anyone who can reach the port can subscribe to market data and read the feed.

`127.0.0.1` is **not reachable from outside the machine**. For a VPS you must
bind all interfaces:

```bash
WEBSOCKET_HOST=0.0.0.0
```

Three ways to set it, in precedence order:

1. Alice spawns the child and injects `WEBSOCKET_HOST` from `tv-feed.json`:
   ```json
   { "enabled": true, "autoStart": true, "bindHost": "0.0.0.0",
     "url": "ws://your-vps:8081" }
   ```
2. Standalone: `WEBSOCKET_HOST=0.0.0.0 node dist/main.js`, or a
   `services/tv-feed/.env` (see below).
3. The process environment, which `dotenv` never overrides.

**Secure it.** The feed has no auth layer. On a VPS restrict the port to the
addresses that need it:

```bash
sudo ufw allow from <your-ip> to any port 8081 proto tcp
```

Verified locally: with `WEBSOCKET_HOST=0.0.0.0` the socket listens on
`0.0.0.0:8081` and a client connecting over the host's LAN address receives
bars. With the default it does not.

### `.env` support

The vendored `src/config.ts` still calls `dotenv.config()`, so a
`services/tv-feed/.env` file works exactly as the upstream project intends. It
is **git-ignored** by the repo root (`.gitignore` has `.env`), so host-specific
values — including a `TV_API_PROXY` credential — never get committed.

A committed `env.example` documents every knob; copy it to `.env` and edit.

You do **not** need a `.env` for the normal path. When Alice spawns the
service it passes `WEBSOCKET_PORT`, `WEBSOCKET_HOST`, and `SUBSCRIPTIONS`
directly, which is why the copy works without one. The file matters only for a
standalone run (`npm start` / `node dist/main.js`) where nothing else supplies
those values. Note that `dotenv` never overrides an already-set process
variable, so Alice's injected values always win.

### Verification

- `src/domain/market-data/tv-feed/*.spec.ts` — symbol mapping, interval
  mapping, connect-before-first-call, on-demand subscribe, staleness,
  out-of-order bars, and a dead endpoint returning `null`.
- `src/workspaces/watch/snapshot.spec.ts` — live append, same-period replace,
  `closed` → `confirmed`, history failure keeping the live price, and the
  asset-class allow-list.
- `scripts/tv-feed-smoke.ts` — **manual** acceptance against a real running
  service:

  ```bash
  TV_URL=ws://127.0.0.1:8081 npx tsx scripts/tv-feed-smoke.ts
  ```

  It prints one line per pair and exits non-zero on failure. Run it after
  changing the client or the symbol map; the unit specs use a mock server and
  cannot catch a TradingView venue/namespace change.

### Known operational trap

A long-running feed service can end up **accepting subscriptions but emitting
nothing** — its upstream TradingView socket reconnected while its chart
sessions did not. Restart the service; Alice's client is not at fault, and its
staleness check will simply fall back to the bar layer in the meantime.

## External MCP servers

`src/server/mcp.ts` **exports** Alice's tools to other MCP clients. This is the
opposite direction: Alice **consumes** a third-party MCP server's tools.

### Configuration

`data/config/mcp.json`:

```json
{
  "enabled": false,
  "port": 3001,
  "externalServers": [
    {
      "id": "tradingview",
      "name": "TradingView",
      "command": "uv",
      "args": ["run", "--directory", "/path/to/tradingview-mcp", "tradingview-mcp"],
      "env": {},
      "enabled": true
    }
  ]
}
```

`externalServers` defaults to `[]`. Adding one is done in
**Settings → MCP Server → External servers**; the page writes the same section
through the ordinary config API, so no new persisted shape or migration exists.

### Naming and lifecycle

- Tools are registered as **`mcp__<id>__<toolName>`**. The prefix makes
  provenance obvious in the agent's tool list and in Settings → Tools, and lets
  a server's contribution be identified exactly.
- The group is `external-mcp:<id>`.
- `ExternalMcpManager.start()` runs **after** the core plugins, so a slow
  third-party server never delays Alice's own listeners.
- Each server has a **15s connect + listTools ceiling**. A hung server is
  logged and skipped.
- Failures are isolated with `allSettled`: one broken server never blocks the
  others and never fails boot.
- `stop()` closes every client and transport; it is idempotent.

### Schema translation

MCP clients receive each remote tool's parameters as **JSON Schema**, while
everything inside Alice (ToolCenter, the AI SDK, our own MCP re-export) expects
Zod. `json-schema-to-zod.ts` bridges the subset MCP servers actually emit:
objects, strings, numbers, integers, booleans, arrays, nested objects, enums,
`anyOf`/`oneOf`, and required-vs-optional.

Two deliberate properties:

- **Permissive.** An unknown keyword is ignored, never thrown. A vaguely typed
  remote tool is still usable; a converter that threw would make the whole
  server unregisterable.
- **Passthrough objects.** Unadvertised extra fields are preserved, because a
  remote server may read a field its `listTools` schema did not describe.

### Environment inheritance

`StdioClientTransport` merges the configured `env` **on top of** the SDK's
default inherited environment (`HOME`, `PATH`, `SHELL`, …). This is why `uv`,
`npx`, and bare command names resolve. Do not replace that map with `{}` — it
would strip `PATH`.

Stderr is piped so a chatty server cannot interleave with Alice's own output.

### Adding a server does not hot-reload

The manager connects at boot. Restart OpenAlice after adding, removing, or
disabling a server. Enabling/disabling a row writes config but does not
reconnect; the UI states this.

### Testing before adding

The add form has a **Test** button backed by `POST /api/config/mcp/test`. It
spawns the draft command through a throwaway client
(`services/external-mcp/probe.ts`), lists the tools, and tears the process down —
the same 15s ceiling and the same environment inheritance as a real connection.

It reports either `Connected · <server> · N tools` with the tool names, or the
failure text, in place. Nothing is registered and nothing is persisted, so a typo
is caught while the operator is still editing the form rather than after a
restart.

## Change checklist

- Touching the wire protocol → update `client.ts` **and**
  `scripts/tv-feed-smoke.ts`, then run the smoke test against a live service.
- Changing the merge rule → update `snapshot.spec.ts`; `candle_close` semantics
  depend on it.
- Changing tool naming → update `index.spec.ts` and any docs that mention
  `mcp__<id>__<tool>`.
- Changing `tv-feed.json` or `mcp.json` shape → regenerate
  [[src/migrations/INDEX.md]] only if the shape **shipped**. Both are new and
  unreleased, so edit them directly.
