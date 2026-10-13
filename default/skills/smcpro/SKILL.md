---
name: smcpro
description: >
  SMC + price-action live analysis protocol for crypto and forex.
  Discipline-first governance engine with top-down structure, weighted
  confluence, volume activity states, passive-entry control, trap detection,
  explicit VALID/WAITING/INVALID outcomes, portfolio heat controls,
  drawdown-based scaling, session rules, confidence-band grading,
  reverse-read bias check, exception caps, and optional memory tracking.
version: 4.1.0
tags: [trading, smc, price-action, crypto, forex, live-analysis]
category: strategy
---

# SMC + PRICE ACTION — LIVE ANALYSIS PROTOCOL v4.1

Execution-first governance framework for crypto and forex.
The goal is a clean live decision with no hidden execution state.

---

## Design Intent

This is a **discipline engine, not a probability engine.**

The confluence weights are structured heuristics — reasoned opinions about
relative importance, not statistically calibrated edge measurements.
The framework's value is preventing undisciplined entries, not predicting
direction. Treat every score as structured reasoning, never as a measured
probability.

The confluence factors are **not statistically independent.** Daily bias,
4H structure, and 1H confirmation are correlated reads of the same trend.
Premium/discount zone and fresh OB location are correlated location reads.
The maximum score is a structured reasoning checklist, not an
information-theoretic sum. A score of 9.5 means "the same price data, read
through multiple structural lenses, tells a consistent story" — not
"9.5 independent confirmations."

**The actual edge is the governance layer** — gates, exception caps,
reverse read, pre-output audit, trap check, watcher phases. The SMC
vocabulary (OBs, FVGs, BOS, CHoCH, sweeps) is the language. The discipline
engine is the product.

---

## Core Decisions

| Decision | Values |
|---|---|
| Setup status | `VALID` · `WAITING` · `INVALID` |
| Waiting urgency | `WAITING - ACTIVE` · `WAITING - AGGRESSIVE` |
| Passive entry | `NOT ELIGIBLE` · `ELIGIBLE` · `ACTIVE REDUCED STARTER` |

Hierarchy:

- `VALID / WAITING / INVALID` is the **main setup decision**.
- `WAITING - ACTIVE / AGGRESSIVE` are urgency sub-states under `WAITING`.
  They are **not** valid trades.
- `PASSIVE ENTRY STATUS` is a separate execution-permission check,
  not a replacement for setup validity.

No backtest framing. No vague "maybe" setups. No fake precision.

---

## Critical Directives

| # | Rule |
|---|---|
| 1 | **LIVE ONLY.** No backtesting references. No historical performance claims. |
| 2 | **Data before opinion.** Fetch live OHLCV before structural conclusions. |
| 3 | **No memory prices.** Use current fetched data only. |
| 4 | **Weighted confluence.** Minimum score **4.0**. Minimum **3 distinct contributing factors**. Raw signal count is meaningless. |
| 5 | **RR floor.** TP1 must support ≥ 1:2 RR by default. TP2 may validate RR only under the explicit TP2 exception (Appendix B (`references/appendices.md`)). |
| 6 | **Kill Zone required.** State the active session / kill zone explicitly. |
| 7 | **No standalone signal generators.** Do not use RSI, MACD, Bollinger Bands, Stochastic, generic MA crosses, or similar tools as entry/exit signals. VWAP and ADX are permitted as **context tools only** — VWAP for location reference, ADX for trend-strength filtering. Neither generates directional bias. |
| 8 | **Fixed timeframe set.** 1D / 4H / 1H / 15M. Crypto may use 5M only for stop precision after the setup is already valid. |
| 9 | **Exception cap.** Maximum **2 exceptions** per trade. Declared **before** confluence scoring. See Appendix B (`references/appendices.md`). |
| 10 | **Reverse Read.** After top-down analysis, perform Step 4E to counteract confirmation bias. Mandatory for full analyses. |

---

## Execution Modes

Three modes control how much protocol runs. Choose based on context.

### FULL PROTOCOL

Complete top-down analysis. All steps, all gates, full audit.
Use for: fresh analyses, session opens, structure shifts, watcher re-arms.

### FAST GATE

Five non-negotiable checks for time-sensitive situations.

| # | Check | Fail → |
|---|---|---|
| 1 | HTF bias confirmed? (Daily + 4H align, or Daily Resumption applies) | `INVALID` |
| 2 | POI valid? (fresh, unmitigated OB/FVG in trade direction) | `INVALID` |
| 3 | LTF confirmation printed? (15M BOS/CHoCH + displacement per Step 3 (`references/analysis.md`)) | `WAITING` |
| 4 | RR clean to TP1? (≥ 1:2, or valid exception from Appendix B (`references/appendices.md`)) | `INVALID` |
| 5 | No Tier 1 event within 30 min? | `WAITING` |

All 5 pass → proceed to trade plan. Any fail → `WAITING` or `INVALID`.

**FAST GATE trades edge for speed.** It skips the scoring layer, the volume
layer, and the full audit — three of the six governance elements named in
Design Intent. It exists for situations where the FULL PROTOCOL conclusion
is already obvious from HTF bias and location, and the trader needs a read
before the entry is gone.

FAST GATE must still include:

- One-line Reverse Read (mandatory)
- One-line Trap check (mandatory)

These two checks are the minimum governance floor. FAST GATE is not
"no governance." It is **two-item governance, five-check gate, no scoring.**
If either the Reverse Read or the Trap check is ambiguous, escalate to
FULL PROTOCOL. The speed is not worth the lost governance.

Other FAST GATE rules:

- No confluence scoring. No full audit. No volume deep-dive.
- If FAST GATE reveals material structure shift, escalate to FULL PROTOCOL.
- Log `MODE: FAST GATE` in the output.

### QUICK READ

For follow-up questions, minor updates, or "has anything changed?" checks
in the same session.

1. Re-fetch only relevant timeframes (usually 15M + 1H).
2. Compare against prior analysis.
3. State what changed, what held, whether status changed.
4. One-line Reverse Read:
   - "Does the LTF read conflict with the stated HTF bias?"
   - Yes → `REVERSE READ: CONFLICT`, downgrade size.
   - No → `REVERSE READ: ALIGNED`.
5. Output compact answer per Step 10 (`references/output-contract.md`).

Quick Read requires: fresh data fetch, data quality gate (Step 0D),
one-line Reverse Read, explicit statement of whether prior status changed.

Quick Read does NOT require: full news scan (unless Tier 1 imminent),
full volume re-analysis, full STEP GATES, watcher re-arming (unless
status changed to/from WAITING).

If Quick Read reveals a material structure shift, escalate to FULL
PROTOCOL and say so explicitly.

### Follow-Up Rule

If the user asks about the immediately previous analysis in the same
session, answer from existing analysis first. Do not restart the full
protocol unless the user explicitly asks for a refresh, the prior read
is clearly stale, or critical live context is missing.

---

## Step 0 — Initialization

### 0A. Asset Routing

Every series is addressed by a **barId**: `<sourceId>|<nativeSymbol>`.
Find one with `alice market search-bars --query <symbol>`. Never guess
a sourceId.

| Asset | barId shape | Volume Handling |
|---|---|---|
| Crypto | `okx\|BTC/USDT`, `bybit-main\|ETH/USDT:USDT` | Real exchange volume |
| Crypto fallback | another crypto source from `search-bars` | Real exchange volume |
| Forex / indices / commodities | `yfinance\|EURUSD=X`, `yfinance\|XAUUSD=X` | Spot volume is NOT real volume. See Step 5 (`references/analysis.md`). |
| Crossovers / edge cases | whichever source `search-bars` ranks first | Note which source won |

### 0B. Skill Loading

This skill delegates DATA and STRUCTURE maths:

- **`market-data`** — barId lookup and K-line fetch. Required before any
  structural read.
- **`smart-money-concepts`** — Python structural engine (FVG, BOS, CHoCH,
  order blocks, sweeps). Run for the mechanical part of Step 3 (`references/analysis.md`).
- **`alice-analysis`** — bounded quant calculator for VWAP, ADX, and
  permitted helper measures.

Read `market-data` first: you cannot fetch OHLCV without a real barId.

Do not use Elliott Wave or Ichimoku inside this framework.

### 0C. Data Fetch Set

| Timeframe | Candles | Purpose |
|---|---|---|
| 1D | 60 | Macro bias, weekly liquidity, premium/discount |
| 4H | 60 | Primary structural bias, displacement, POI |
| 1H | 60 | Intraday structure, inducement, transition |
| 15M | 60 | Execution trigger |

Crypto only: fetch BTC 4H context if the pair is not BTC itself.

### 0D. Data Quality Gate

Before any structural read:

| Check | Fail Condition | Action |
|---|---|---|
| Candle count | Any timeframe < 40 candles | Halt or fallback source |
| Staleness | Latest candle > 2 candle-lengths behind UTC now | Halt (see forex note) |
| OHLC integrity | `high < low` or close outside range | Halt |
| Volume anomaly | All volume values 0 or identical | Continue; remove volume from confluence |
| Gap anomaly | Cross-TF gap > 3% with no event context | Continue with caution |

Output: `DATA STATUS: CLEAN` · `FLAGGED — [reason]` · `HALTED — [reason]`

If halted, stop. Analysis cannot proceed safely.

**Forex market-hours note:** The staleness halt applies during active
forex hours. Outside active hours (late Friday close, Saturday, early
Sunday pre-open), stale candles do not auto-invalidate. Mark
`DATA STATUS: FLAGGED — forex market closed / off-hours` and treat the
analysis as planning/context only, not fresh execution timing.

### 0E. Portfolio Heat Check

Use when the user requests execution, trade management, or sizing.
Do not block a plain market read because account context is missing.

| Condition | Output |
|---|---|
| 3+ simultaneous open trades | `HEAT BLOCK: Max open trades reached` |
| Correlated crypto positions open | `CORRELATION WARNING` |
| 2 consecutive losses | `SIZE REDUCED` (50%) |
| 3 consecutive losses | `OBSERVATION ONLY — SESSION STOP ACTIVE` |
| Daily loss > 3% | `NO NEW ENTRIES TODAY` |

Output: `HEAT STATUS: CLEAR` · `CAUTION — [reason]` · `BLOCKED — [reason]`
· `UNKNOWN — account context not supplied`

Missing-context rule:

- Plain market read → `HEAT STATUS: UNKNOWN — account context not supplied`.
- Execution request → `HEAT STATUS: UNKNOWN — cannot size without account
  context`; `EXECUTION MODE` defaults to `WAIT FOR CONFIRMATION`.

The agent does not execute trades. It flags heat risk clearly.
If heat is blocked, analysis may continue but the setup cannot be
presented as actionable.

---

## Step 1 — Environment Scan

Mandatory. The agent must attempt the relevant news-scan calls before
declaring `NEWS STATUS`.

Three news surfaces — use all that apply:

- `alice web search` — open-web coverage (multi-backend, keyless). Primary
  for breaking news. Reports which backend answered as `backend`
  (brave → bing → google → yahoo → mullvad → duckduckgo → mojeek); any
  backend name is a full result set. `unavailable`/`error` = all exhausted.
- `alice rss` — user's subscribed feed archive.
- `traderhub board get --board calendar` — scheduled events. Plus `fed`,
  `macro`, `global-macro` boards.

### Coverage Honesty Rule

- `alice web search` is a keyless multi-backend scrape. It can fail
  transiently. When it fails, say so. Do not silently substitute and
  claim you searched the web.
- `alice rss` searches only the subscribed feed list. Empty result means
  "not in subscribed feeds," not "nothing happened."
- The calendar board is forward-looking; web/rss are backward-looking.
  Use all three. State which you used.

Always write a `NEWS SOURCE` line stating what you actually queried.

If every news-scan call fails, continue with chart-only analysis but mark
`NEWS STATUS: CAUTION — news sources unavailable; scheduled/high-impact
event risk not independently verified`.

### Forex Environment

Run:

- `traderhub board get --board calendar --days 7`
- `traderhub board get --board fed`
- `traderhub board get --board macro`
- `alice web search --query "economic calendar high impact [date UTC]" --time day`
- `alice web search --query "DXY analysis today" --time day`
- `alice web search --query "[PAIR] central bank stance [date]" --time week`
- `alice rss glob --pattern "DXY|dollar index" --lookback 2d`
- `alice rss grep --pattern "<PAIR>|correlation" --lookback 2d`

State the most decision-relevant cross-market link (DXY, yields, linked
FX pair). If correlation is mixed, say so.

### Crypto Environment

Run:

- `alice web search --query "BTC news today [date]" --time day`
- `alice web search --query "crypto funding rates open interest [date]" --time day`
- `alice rss glob --pattern "BTC|Bitcoin" --lookback 1d`
- `alice rss grep --pattern "funding|open interest|liquidation" --lookback 1d`
- `traderhub board get --board term-structure`

Funding guide:

| Funding | Read |
|---|---|
| > +0.01% | Crowded longs, downside squeeze risk |
| < −0.01% | Crowded shorts, upside squeeze risk |
| −0.005% to +0.005% | Balanced / cleaner conditions |

### News Impact Tiers

| Tier | Examples | Rule |
|---|---|---|
| Tier 1 — Hard Block | FOMC, CPI, NFP, GDP, rate decisions, major CB speech | No entries 30m before to 30m after. Analysis continues; trade call defaults to no-trade until structure clears. |
| Tier 2 — Caution | PMI, claims, PPI, Fed member speech, major crypto regulatory headline | Reduce size or wait for post-event structure. |
| Tier 3 — Note Only | Low-impact scheduled items | Note only. |

Output: `NEWS STATUS: CLEAR` · `CAUTION — [reason]` · `HIGH RISK — [reason]`

---

## Step 2 — Session & Kill Zone Context

### Forex Windows (UTC)

| Window | UTC | Intent |
|---|---|---|
| Asian | 00:00–04:00 | Range formation |
| London Open | 07:00–09:00 | Manipulation first, real move second |
| NY Open | 13:00–15:00 | Continuation or reversal of London |
| London Close | 15:00–16:00 | Profit-taking / fade risk |
| Dead Zone | 20:00–00:00 | No new entries |

### Crypto Windows (UTC)

| Window | UTC | Intent |
|---|---|---|
| Asian | 00:00–08:00 | Accumulation |
| London | 07:00–12:00 | First volatility expansion |
| NY | 13:00–21:00 | Strongest trend window |
| Dead Zone | 21:00–00:00 | No new entries |

### Session Behavior Rules

**Asian:** Define the Asian range high/low. Treat them as likely liquidity
targets for the next active session. Do not trust breakout continuation.

**London Open:** Expect Judas behavior before the real move. If the Asian
range has not been swept, flag that sweep as likely first. The real entry
is the reversal after the sweep, not the breakout.

**NY Open:** State explicitly whether NY is more likely continuation of
London or reversal. Base it on: whether London produced full displacement
or only a manipulation sweep; whether price is at a 4H/Daily POI or
mid-range; whether major liquidity remains untouched.

**London Close (forex only):** Profit-taking / fade window. No fresh
trend entries unless context is exceptional.

**Dead Zone:** No new entries. Analysis may be given for observation or
next-session planning. `WAITING` setups may be planned and watchers armed,
but `EXECUTION MODE` is `NO TRADE` until the next active session. Label
the plan `NEXT SESSION PLANNING ONLY`. Do not arm a watcher that could
fire during Dead Zone unless the user asked for overnight coverage.

Kill Zone alignment adds `+1.0` weighted confluence.

**Why 1.0 and not 0.5:** session is a timing factor, and timing is the
difference between a setup that reacts and one that dies. A clean HTF
location with no session alignment often waits hours for a move that
already happened; a clean HTF location inside the kill zone often reacts
immediately. Weighting session equally with structural confirmation
reflects that a well-timed mediocre setup and a poorly-timed good setup
have comparable expected response. The weight is a claim about trading,
not a rounding convenience.

---

## Step 3 to 6 - Analysis (reference files)

Steps 3 to 6 are kept in reference files so this protocol always loads in full. Read them before producing any structural read.

- `references/analysis.md` - Step 3 core SMC definitions, Step 4 top-down structure analysis, Step 5 volume analysis.
- `references/confluence-and-gates.md` - Step 6 weighted confluence, gates, rating and size.

Step 7 continues below.
## Step 7 — Trap & Inducement Check

Answer before any trade presentation:

- Is the level too obvious?
- Was external liquidity or IRL just swept?
- Was there a Judas move first?
- Did the breakout happen on weak confirmation?
- Is there an inducement swing between price and the real target?
- Is the block partially mitigated?
- Did a double sweep/CTR print and reclaim in the intended direction?
- Did CISD or V-shaped recovery confirm the sweep, or is it still only a wick?
- On BTC, is the market walking into an obvious liquidity pool?

Output: `TRAP RISK: LOW / MEDIUM / HIGH — [reason]`

---

## Step 8 - Trade Setup (reference file)

The full setup, execution, entry, stop-loss, target, management and watcher rules live in `references/trade-setup.md`. Read it before presenting any trade.

Step 9 continues below.
## Step 9 — Invalidation Conditions

Track:

- **Hard:** 15M closes through SL logic
- **Structural:** 1H breaks against planned direction before entry
- **Mitigation:** entry block dies before trigger
- **Timing:** trigger never prints in the relevant kill zone
- **Event:** new Tier 1 risk appears
- **Crypto-specific:** funding flips aggressively against position

---

## Step 9B — Pre-Output Audit

Mandatory before any final SETUP output. Mark each item CONFIRMED,
SKIPPED (with reason), or FAILED (with reason).

| Audit Item | Covers |
|---|---|
| `AUDIT DATA` | Step 0: data fetched, quality gate, heat check |
| `AUDIT ENVIRONMENT` | Step 1: news sources attempted, NEWS SOURCE declared |
| `AUDIT SESSION` | Step 2: session and kill zone stated |
| `AUDIT SMC DEFINITIONS` | Step 3 (`references/analysis.md`): displacement, mitigation, liquidity, archetypes |
| `AUDIT TOP-DOWN` | Step 4 (`references/analysis.md`): full 1D→4H→1H→15M chain + Reverse Read |
| `AUDIT VOLUME` | Step 5 (`references/analysis.md`): source, reliability, activity state, divergence |
| `AUDIT GATES` | Step 6 (`references/confluence-and-gates.md`): HTF bias, transition, POI, LTF, confluence, exceptions, confidence |
| `AUDIT TRAP` | Step 7: trap risk rated |
| `AUDIT TRADE PLAN` | Step 8 (`references/trade-setup.md`): status, execution mode, passive status, SL/targets/RR, entry edge |
| `AUDIT INVALIDATION` | Step 9: invalidation conditions stated |
| `AUDIT EXCEPTIONS` | All exceptions considered, count ≤ 2, declared before scoring |
| `AUDIT WATCHER` | If WAITING: watch block authored after final decision, confirmed healthy |

Blocking rule:

- Any FAILED item → go back and fix before printing final SETUP.
- If unfixable → final SETUP must be `INVALID` / `NO TRADE`.
- If VALID or INVALID, AUDIT WATCHER may be SKIPPED.
- Do not print the full audit by default. Print only failed/skipped items,
  exceptions, or details the user explicitly requests.

### STEP GATES Block

Before the final setup output in FULL PROTOCOL mode, include:

```text
STEP 0 GATE: [one-line finding or SKIPPED - reason]
STEP 1 GATE: [one-line finding or SKIPPED - reason]
...
STEP 9B GATE: [confirmed or FAILED - reason]
```

Each line must be specific enough to prove the step was performed.
FAST GATE and QUICK READ modes skip STEP GATES.

---

## Step 10 - Compact Output Contract (reference file)

The mandatory output shape lives in `references/output-contract.md`. Read it before writing the final answer.

Step 11 continues below.
## Step 11 — Trade Memory & Performance Tracking

### 11A. Save Trade Memory

For VALID and high-quality WAITING setups, append a structured
`TRADE MEMORY` block to the Issue or conversation.

Key format: `trade_log_{PAIR}_{YYYYMMDD}_{SESSION}`

Fields: pair, date, session, direction, setup status, confluence,
confidence band, caveats, rating, entry, stop, TP1–TP3, position size,
heat status, news status, top confluence drivers, exceptions, reverse
read, result, actual RR, exit reason, notes.

**Waiting-setup invalidation rule:** If a WAITING setup never triggers
and becomes invalid, log it as `result = INVALIDATED_PRE_TRIGGER` with
`exit_reason`. This data is part of setup-quality analysis.

### 11B. Recall & Pattern Review

Support: last 10 logs · win rate by pair · band performance · loss
clustering by session/asset/direction. Use only closed trades with
actual outcomes.

### 11C. Trade Journal Analysis

After meaningful sample, analyze TRADE MEMORY blocks:

- Win rate · achieved vs. planned RR · drawdown
- Bias diagnostics: overtrading, chasing, anchoring, poor exits
- Exception frequency and performance
- Reverse-read correlation (CONFLICT vs. ALIGNED performance)

**Sample rule:** No performance claim below N = 30 closed trades in the
relevant bucket. Below 30, report as `OBSERVATION ONLY` with sample size.
Above 30, report as statistic with sample size and note that 30 is a
floor, not sufficiency.

The framework cannot self-calibrate. If asked "what's the probability":
state the band, the sample size in that band (or "none yet"), and
explicitly state that the framework does not produce calibrated
probabilities.

### 11D. Shadow Account

No shadow-account tooling exists. Do not claim to run a shadow backtest.
If the user wants to separate analysis quality from execution quality,
propose it as a follow-up experiment. Model as a self-scheduling Issue
if approved. Do not force on tiny samples.

### 11E. Self-Evolving Skill Updates

No `patch_skill` / `save_skill` tools. If recurring patterns justify a
framework change, propose as a labeled `SKILL PATCH PROPOSAL` block.
Never auto-apply. Present evidence first. Propose only narrow, justified
changes.

---

## Appendices (reference file)

`references/appendices.md` holds Appendix A (watcher phase model), Appendix B (exception registry) and Appendix C (confidence system). Read it whenever a watcher is armed, an exception is invoked, or a confidence band is reported.