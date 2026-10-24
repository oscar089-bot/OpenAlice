# Watcher field reference

The complete `watch:` contract. The SKILL.md teaches the workflow; this is the
lookup table for every variable, so a watcher is authored correctly the first
time. Read it before writing a `watch:` block you have not written before.

## Top-level fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `pair` | **yes** | string | **BARE symbol**, never a `source\|symbol` barId. See *Pair rules*. |
| `timeframe` | **yes** | string | `1m` \| `5m` \| `15m` \| `30m` \| `1h` \| `4h` \| `1d` \| `1w`. `2h` and smaller-than-1m are rejected. |
| `rules` | **yes\*** | array | Trigger rules. \*At least one rule **or** one management rule is required. |
| `assetClass` | no | enum | `crypto` (default) \| `forex` \| `equity` \| `commodity` \| `index`. |
| `direction` | no | `LONG` \| `SHORT` \| `''` | Default for a rule's `side`: `LONG`→`above`, `SHORT`→`below`. |
| `invalidationRules` | no | array | Same shape as `rules`. **Terminal**: the first to hit ends the watcher with `INVALIDATED`. |
| `managementRules` | no | array | Position-based alerts. **Requires `position`.** Never terminal. |
| `position` | no | object | Frozen entry/stop context. **Required when `managementRules` is set.** |
| `expiry` | no | ISO string | `2026-10-01T00:00:00Z`. **Terminal** at that instant. |
| `meta` | no | object | Presentation only — never read by the evaluator, never re-arms. |

Unknown keys are **stripped silently**, so a typo in a field name disappears
without an error. Use only the names above.

## Pair rules (the guard)

`pair` is a **bare symbol**. A `source|symbol` barId is rejected at authoring
time with a correction — this is deliberate, because a barId is passed to the
vendor as a literal ticker and fails every poll with *"symbol may be delisted"*.

| Asset class | Write | Example | Do NOT write |
|---|---|---|---|
| `crypto` | exchange-native `BASE-QUOTE` | `BTC-USDT`, `SOL-USDT` | `yfinance\|SOLUSD`, `BTC-USD`\* |
| `forex` | yfinance spot form | `EURUSD`, `EUR/USD`, `EURUSD=X` | `EUR` (too short) |
| `equity` | ticker or source barId | `AAPL`, `eastmoney\|1.600519` | — |
| `commodity` / `index` | ticker or source barId | `XAUUSD=X` | — |

\* `BTC-USD` **is** accepted for crypto and widened to `BTC-USDT` (OKX spot is
USDT-quoted), but prefer `BTC-USDT`. `yfinance`'s `SOL-USD` is a different
symbol space and is not the venue a crypto trader executes on.

### Live pricing

Crypto and forex watchers are priced from the local **TradingView live feed**
when it is running: real-time push data instead of a delayed vendor snapshot.
This is transparent — the `pair` syntax above is unchanged, and when the feed is
off or disconnected the watcher silently falls back to the delayed vendor feed.
Do not write a different symbol to "use the live feed"; there is no such switch
per watcher.

Equity, commodity, and index watchers always use the federated bar layer.

## Candle timeframes (`candle_close`)

`candle_close` reads a **specific timeframe**, taken from the RULE's own
`timeframe` field, falling back to the watch's top-level `timeframe`. Write it
explicitly whenever they differ:

```yaml
watch:
  timeframe: 1h          # drives price_breaks_level / zone rules
  rules:
    - { type: candle_close, timeframe: 15m, side: above, level: 110000 }
```

That fires on a **15-minute** close, not a 1h close. Alice fetches every
distinct timeframe the rules name, so a 15m rule inside a 1h watcher receives
real 15m candles rather than being starved of data.

Rules:

- Only **confirmed** candles count. A candle that closes at or before the
  arming time is ignored, so re-arming never replays history.
- Confirmation requires the period to have **actually elapsed**. A re-subscribe
  can replay a just-closed period, so a premature close signal is downgraded
  and the rule waits for the real close.
- Use the same `timeframe` for a rule as the structure it is judging. A 15m
  reclaim is a 15m rule; a 4h breakdown is a 4h rule.
- Every timeframe costs one fetch per tick, so keep the set small (two or three
  at most).

**Do not guess the exact pair.** Confirm it with `alice market search-bars
--query SOL`, then drop the `source|` prefix when you write `pair`.

## Trigger rule types (`rules`, `invalidationRules`)

Every rule is `{ type, ... }`. Level rules need a numeric `level`; zone rules
need numeric `low` + `high`. **Use `side`, never `condition`** — the evaluator
only reads `side`.

| `type` | Needs | Fires when |
|---|---|---|
| `price_breaks_level` | `side`, `level` | price is at/beyond the level (live, intrabar) |
| `price_crosses_level` | `side`, `level` | price moves across the level since the last check |
| `candle_close` | `side`, `level`, `timeframe` | a **confirmed** candle closes beyond the level |
| `level_reclaim` | `level` | price is above the level (implies `side: above`) |
| `level_breakdown` | `level` | price is below the level (implies `side: below`) |
| `liquidity_sweep_touched` | `level` | price pokes beyond the level |
| `price_enters_zone` | `low`, `high` | price is inside the zone |
| `price_approaches_zone` | `low`, `high`, optional `threshold` **or** `thresholdPct` | price is within the threshold of the zone |

- `side` defaults from `direction` when omitted (`LONG`→`above`, `SHORT`→`below`).
  Omit `direction` **and** `side` and the rule never fires.
- `candle_close` **only** counts confirmed candles. A candle that closed at or
  before `armedAt` is ignored, so re-arming never replays history.
- `threshold` is an absolute price distance; `thresholdPct` is fractional
  (`0.002` = 0.2%). When neither is given, `price_approaches_zone` uses 0.2%.
- Use `candle_close` (not `price_breaks_level`) whenever the trigger or
  invalidation depends on a timeframe close. Do not invent rule types.

## Management rules (`managementRules`)

Require a `position` block. Entry/stop/side are frozen at authoring time, so
these work even when the broker (UTA) is offline.

```yaml
position: { side: LONG, entry: 3200, stop: 3050, targets: [3600] }
managementRules:
  - { type: r_multiple_reached, multiple: 2 }
  - { type: unrealized_pnl_pct, op: below, pct: -4 }
```

| `type` | Needs | Fires when |
|---|---|---|
| `r_multiple_reached` | `multiple` (positive) | profit reaches `multiple` × (entry − stop), signed by side |
| `unrealized_pnl_pct` | `pct`, optional `op` (`above`/`below`) | P&L% crosses `pct` relative to entry |

`position` fields: `side` (required), `entry` (required), `stop`, `targets[]`, `size`.

## Presentation (`meta`)

Shown on the watcher board card. Never read by the evaluator; changing it does
**not** re-arm the watcher or replay an alert.

| Field | Meaning |
|---|---|
| `grade` | Setup quality, e.g. `A+`. |
| `rating` | Numeric rating, when you use a scale instead of a letter. |
| `phase` | Which plan phase this watcher watches, e.g. `reclaim`. |
| `nextStep` | What the woken Session should do (shown as *Next after alert*). |
| `waitingTrigger` | Plain-English trigger sentence, so the card reads without the rule table. |
| `invalidationConditions` | Prose invalidation, shown beside the rules. |

**Always set `grade` and `phase`.** Leaving them out is why the board looks
empty even though the rules are working.

## Lifecycle semantics

- **Each rule fires once.** After it fires it will not alert again until you
  re-arm; a **15-minute cooldown** guards the remaining rules.
- **Invalidation and expiry are terminal.** The first invalidation to hit ends
  the watcher and reports `INVALIDATED`; `expiry` ends it with `EXPIRED`.
- **A trigger is not terminal.** The watcher stays armed, waiting for your next
  decision. Rewriting the `watch:` block re-arms it with fresh state and clears
  the previous phase's firing history.
- The evaluator is **pure and deterministic** — it never reads your prose. If a
  condition is not expressible as a rule, put it in What and use a `when`
  schedule instead.
- A snapshot fetch that fails is **not** a fire: the watcher records a data
  error and backs off, so an outage never wakes the Session.

## Minimal correct watcher

```yaml
watch:
  pair: BTC-USDT
  assetClass: crypto
  direction: LONG
  timeframe: 1h
  rules:
    - { type: candle_close, timeframe: 1h, side: above, level: 110000 }
  invalidationRules:
    - { type: price_breaks_level, side: below, level: 98000 }
  expiry: 2026-10-01T00:00:00Z
  meta:
    grade: A+
    phase: reclaim
    nextStep: Re-check volume and 4h structure before re-arming.
    waitingTrigger: BTC closes a 1h candle above 110k
    invalidationConditions: ['BTC loses 98k on a 1h close']
```
