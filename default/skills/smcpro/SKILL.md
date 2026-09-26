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
| 5 | **RR floor.** TP1 must support ≥ 1:2 RR by default. TP2 may validate RR only under the explicit TP2 exception (Appendix B). |
| 6 | **Kill Zone required.** State the active session / kill zone explicitly. |
| 7 | **No standalone signal generators.** Do not use RSI, MACD, Bollinger Bands, Stochastic, generic MA crosses, or similar tools as entry/exit signals. VWAP and ADX are permitted as **context tools only** — VWAP for location reference, ADX for trend-strength filtering. Neither generates directional bias. |
| 8 | **Fixed timeframe set.** 1D / 4H / 1H / 15M. Crypto may use 5M only for stop precision after the setup is already valid. |
| 9 | **Exception cap.** Maximum **2 exceptions** per trade. Declared **before** confluence scoring. See Appendix B. |
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
| 3 | LTF confirmation printed? (15M BOS/CHoCH + displacement per Step 3) | `WAITING` |
| 4 | RR clean to TP1? (≥ 1:2, or valid exception from Appendix B) | `INVALID` |
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
5. Output compact answer per Step 10.

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
| Forex / indices / commodities | `yfinance\|EURUSD=X`, `yfinance\|XAUUSD=X` | Spot volume is NOT real volume. See Step 5. |
| Crossovers / edge cases | whichever source `search-bars` ranks first | Note which source won |

### 0B. Skill Loading

This skill delegates DATA and STRUCTURE maths:

- **`market-data`** — barId lookup and K-line fetch. Required before any
  structural read.
- **`smart-money-concepts`** — Python structural engine (FVG, BOS, CHoCH,
  order blocks, sweeps). Run for the mechanical part of Step 3.
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

## Step 3 — Core SMC Definitions

### Displacement

Valid displacement requires ALL of the following:

- **Body size:** candle body ≥ 1.5× the **median** body of the prior
  20 candles on the same timeframe, AND in the top 20% of prior 20
  candle bodies (≥ 80th percentile).
- **Wick ratio:** combined upper + lower wick ≤ 40% of total candle range.
- **Decisive close:** close extends beyond the broken level by at least
  30% of that candle's total range (not just a wick through).
- **Volume confirmation (crypto):** displacement candle volume > 1.5×
  the 20-candle volume average.

No valid trade setup exists without displacement on 15M or 4H.

**Elite location exception:** If price is reacting from a fresh
unmitigated HTF POI with elite confluence context, a strong momentum
rejection / reclaim candle may substitute for the full displacement
template. Valid only when ALL are true:

- POI is Daily or 4H and clearly fresh
- Liquidity already swept or trapped at the location
- Kill zone / session supports the move
- Candle closes decisively back in the trade direction (≥ 30% of range)

If used, output `DISPLACEMENT EXCEPTION INVOKED` with evidence.

**Forex note:** Weak tick-volume confirmation reduces confidence but does
not auto-kill a structurally clean displacement.

### Mitigation Status

All OBs and FVGs must be classified:

| Status | OB Definition | FVG Definition | Trade Use |
|---|---|---|---|
| Unmitigated | Price has not returned to 50% of OB candle | Price has not filled any part of the gap | Valid |
| Partially mitigated | Price entered zone, no close beyond opposite extreme | Price entered but did not fully close through | Caution |
| Fully mitigated | Price closed beyond opposite extreme | Price closed through the whole gap | Dead — discard |

### Block Types & Priority

1. Fresh unmitigated OB
2. Rejection block (failed OB as rejection boundary; use for stop placement)
3. Breaker block (failed OB that flips polarity; valid only if the break
   happened with displacement per the definition above)
4. Partially mitigated OB
5. Fully mitigated OB/FVG → discard

### Internal Range Liquidity (IRL)

Identify stop clusters inside the range, not only at extremes.
Use IRL for trap recognition and SL refinement.

### Judas Swing

Counter-trend manipulation before the real move, usually around Asian
range or pre-kill-zone liquidity. If confirmed, the real trade is
opposite the Judas push.

### BTC Liquidity Grab Protocol

| Phase | What Happens | Required Response |
|---|---|---|
| Build-up | Price approaches clean high/low, round number, EQH/EQL | Flag high trap risk |
| Grab | Price wicks through the level | Do NOT treat the wick as entry |
| Confirmation | 15M closes back through the level in the real direction | This is the trigger |
| Re-entry | Thesis survives but you were stopped by the grab | Re-entry valid if close confirms back; SL beyond grab wick |

The wick alone is not confirmation. The close back through is.

### Second-Layer Confirmation Archetypes

Named refinements of LTF CONFIRMATION. Not extra mandatory gates.

**Hard cap:** all second-layer archetypes combined contribute at most
`+0.5` to confluence. They cannot create a valid setup, override missing
HTF bias, missing POI, or missing RR. Garnish, not structure.

**V-Shaped Recovery:** Valid only after price grabs liquidity from a major
key level or HTF POI. Requires: sweep → sharp close back through swept
level (≥ 30% of range) → displacement or strong rejection → entry still
at/inside a fresh OB/FVG.

**CISD (Change in State of Delivery):** Refined CHoCH. Log
`CISD CONFIRMED` when: 15M CHoCH/BOS closes through an internal delivery
level; confirmation candle creates/expands an FVG in the new direction;
delivery flips; price reacts from valid HTF POI or sweep context.

**Double Sweep / CTR:** Both sides of a local range swept, then price
reclaims in the intended direction with displacement, CISD, or decisive
close. May reduce trap risk one level (HIGH→MEDIUM, MEDIUM→LOW). Must not
auto-mark trap risk LOW without confirming reclaim.

---

## Step 4 — Top-Down Structure Analysis

Work strictly: **1D → 4H → 1H → 15M**.

### 4A. Daily — Macro Bias

Identify: market structure (HH/HL, LH/LL, ranging) · freshest unmitigated
HTF OB · open HTF FVGs · premium/discount location · current HTF delivery
· previous week high/low · clean unswept HTF liquidity levels (PWH/PWL,
monthly high/low, EQH/EQL, major swing) · any obvious daily Judas behavior.

Output:

- `DAILY BIAS: BULLISH / BEARISH / RANGING`
- `HTF DELIVERY: BULLISH / BEARISH / NEUTRAL`
- `HTF LIQUIDITY DRAW: [level] / NONE`

### 4B. 4H — Primary Bias

Identify: BOS or CHoCH · last confirmed structural shift (corrective vs.
possible HTF transition) · displacement quality (per Step 3) · ADX context
(>25 strong, 20–25 weak, <20 ranging) · active OBs/FVGs · rejection/breaker
blocks · liquidity above/below · clean unswept HTF liquidity draw · IRL ·
PDH/PDL · inducement · Judas behavior.

Output:

- `4H BIAS: BULLISH / BEARISH / RANGING`
- `4H STRUCTURAL SHIFT: NONE / CORRECTION / TRANSITION_EARLY / TRANSITION_CONFIRMED`
- `HTF DELIVERY: BULLISH / BEARISH / NEUTRAL`
- `HTF LIQUIDITY DRAW: [level] / NONE`

### 4C. 1H — Intraday Confirmation

Identify: whether 1H confirms 4H or conflicts · intraday CHoCH · whether
1H confirms or rejects any 4H transition attempt · active OBs/FVGs ·
rejection blocks · nearest liquidity targets · retracing vs. expanding ·
any 1H manipulation.

Output: `1H BIAS: BULLISH / BEARISH / RANGING`

### 4D. 15M — Entry Precision

Identify: micro BOS/CHoCH · entry-side displacement · whether 15M
supports HTF transition or is only a local bounce · entry OB · entry FVG ·
rejection block near entry · confirmation candle type · liquidity sweep
quality · IRL sweep · Judas / turtle-trap · V-shaped recovery · CISD ·
double sweep/CTR.

**Daily-trend resumption check:** If Daily is clear, 4H is in a
counter-trend correction, and 15M prints fresh CHoCH/BOS plus displacement
back in the Daily direction, this may qualify for the Daily Trend
Resumption exception (Appendix B).

Mitigation rule: partially mitigated entry OB/FVG → downgrade confidence.
Fully mitigated → discard.

Output: `ENTRY READINESS: ACTIVE / WAITING / INVALIDATING FACTORS PRESENT`

15M readiness is diagnostic only. Final setup status is decided in Step 8.

### 4E. Reverse Read — Confirmation Bias Check

**Mandatory for full analyses.** After completing 4A–4D, answer three
questions before proceeding to Step 5.

**The problem:** The top-down sequence enforces order but not independence.
Once you form a Daily bias, you unconsciously read 4H, 1H, 15M to confirm
it. The hierarchy prevents cherry-picking timeframes but not confirmation
bias within the sequence.

**Question 1 — Blind read:** "If I had NOT seen the Daily chart first,
and I opened only 15M and 1H, what direction would I read?"

- Conflicts with Daily → `REVERSE READ CONFLICT: LTF reads [direction]
  without HTF anchor`
- Aligns → `REVERSE READ: ALIGNED`

**Question 2 — Counter-thesis:** "What is the strongest argument AGAINST
my current bias, using only the data I already fetched?"

- Write one sentence. If you cannot construct a counter-argument, flag
  `REVERSE READ: NO COUNTER-THESIS FOUND — possible anchoring`.

**Question 3 — Level swap:** "If my intended direction were reversed,
would I still consider the current price location a valid entry?"

- Yes → `REVERSE READ: LOCATION AMBIGUOUS — not a clean directional edge`
- No → `REVERSE READ: LOCATION DIRECTIONALLY SPECIFIC`

**Output (one line):**

- `REVERSE READ: ALIGNED — no conflict detected`
- `REVERSE READ: CONFLICT — [describe]`
- `REVERSE READ: ANCHORING RISK — [describe]`

**Rules:**

- `CONFLICT` does not auto-invalidate but reduces size to 50%. Must be
  stated in output.
- `ANCHORING RISK` requires re-examination of whether Daily bias was
  formed from structure or from a desired conclusion. If bias survives,
  proceed. If not, restart Step 4A.

**Crypto 5M note:** If 15M displacement closed too deep into the entry
zone and the setup remains valid, use 5M only for stop precision /
trigger refinement. Do not expand the framework beyond that.

---

## Step 5 — Volume Analysis

**Purpose:** Read current participation and urgency. Distinguish dormant
WAITING setups from active setups close to triggering.

**Core rule:** Price action is the gate. Volume is the
participation/urgency layer. Volume may upgrade monitoring priority,
support confidence, support passive-entry review, and warn that a WAITING
setup is waking up. Volume may NOT replace HTF bias, replace fresh POI
location, replace LTF confirmation, or make a full-size trade valid
without the required trigger.

### Volume Activity State

| State | Meaning | Trade Implication |
|---|---|---|
| `DORMANT` | Volume quiet or fading near POI | Lower urgency; do not anticipate |
| `ACTIVE` | Participation increasing, directionally agrees, trigger incomplete | `WAITING - ACTIVE`; monitor closely |
| `AGGRESSIVE` | Strong volume expansion + range/displacement pressure into/away from POI | `WAITING - AGGRESSIVE`; trigger may be close but do not chase |

Classification:

- `DORMANT`: no volume spike, weak range expansion, or volume contradicts.
- `ACTIVE`: volume > 1.3× 20-candle average, candle spread expanding,
  direction agrees.
- `AGGRESSIVE`: volume > 2× 20-candle average, range/displacement
  expanding, price at/near trigger or POI.

`ACTIVE` and `AGGRESSIVE` are monitoring states, not entry permission.

### Crypto Volume

Use real exchange volume from OKX/CCXT.

Check: displacement candle volume vs. 20-candle average · retracement
volume profile · OB creation volume · climax/exhaustion profile · volume
divergence at sweep or POI · volume delta between rejection and
continuation candles · open interest / liquidation context if available.

**VWAP (crypto only):**

| Check | Read |
|---|---|
| Price above VWAP | Bullish support for longs |
| Price below VWAP | Bearish support for shorts |
| Rejection from below | Bearish continuation |
| Rejection from above | Bullish continuation |
| Entry POI confluent with VWAP | Upgrade confidence |
| Entry POI on wrong side of VWAP | Caution |

Do not use VWAP on forex / indices / commodities.

Output:

- `CRYPTO VOLUME SOURCE: OKX / CCXT / NONE`
- `CRYPTO VOLUME RELIABILITY: HIGH / MEDIUM / NONE`
- `VOLUME: CONFIRMING / NEUTRAL / DIVERGING`
- `VOLUME ACTIVITY STATE: DORMANT / ACTIVE / AGGRESSIVE`
- Brief reason

### Forex Volume

**Structural limitation:** Spot FX has no centralized exchange volume.
Yahoo/yfinance spot volume is not reliable for forex confirmation.
This is a data limitation, not a framework flaw. The forex side of this
protocol is structurally thinner on volume than the crypto side.

**Primary proxy:** CME FX futures volume. Fetch the relevant futures leg
with `alice market search-bars --query "<currency> futures"` then
`alice market bars`. Map the forex pair into base and quote currency legs.
Compare each leg against its recent baseline. Agreement between pair
direction and futures participation is stronger evidence than broker
tick volume.

Common CME proxy legs:

| Pair | Preferred Volume Proxy |
|---|---|
| GBPJPY | British Pound futures + Japanese Yen futures |
| EURGBP | Euro FX futures + British Pound futures |
| AUDJPY | Australian Dollar futures + Japanese Yen futures |
| USDJPY | Japanese Yen futures + Dollar Index / USD context |
| EURUSD | Euro FX futures + Dollar Index / USD context |

**Secondary proxy only:** Broker tick volume, session-open tick activity,
candle range/displacement expansion.

**Reliability labels:**

| Label | Requirement |
|---|---|
| `HIGH` | CME futures proxy confirms ≥ 1 liquid leg AND price action agrees |
| `MEDIUM` | CME unavailable but reputable tick volume and displacement agree |
| `LOW` | Only broker/yfinance/tick proxy exists |
| `NONE` | Volume is zero, missing, or contradictory |

**Volume divergence (both markets):** Bearish divergence = price makes
new high into liquidity/POI while volume is lower than prior comparable
swing high. Bullish divergence = new low with lower volume. Divergence
suggests possible exhaustion, not automatic reversal. For forex, if
reliability is LOW or NONE, mention divergence as observation but do not
award confluence.

If no CME proxy or reliable tick proxy is available:
`FOREX VOLUME SOURCE: NONE — spot FX volume is not centralized; volume
removed from confluence.`

Output:

- `FOREX VOLUME SOURCE: CME_PROXY / TICK_PROXY / NONE`
- `FOREX VOLUME RELIABILITY: HIGH / MEDIUM / LOW / NONE`
- `VOLUME: CONFIRMING / NEUTRAL / DIVERGING`
- `VOLUME ACTIVITY STATE: DORMANT / ACTIVE / AGGRESSIVE`
- Brief reason, naming the proxy used

---

## Step 6 — Weighted Confluence & Trade Gate

### Structural Gate

Three mandatory pillars. All three required before `VALID`.

| Pillar | Definition |
|---|---|
| `HTF BIAS` | 4H aligns with the dominant tradable narrative, Daily Trend Resumption exception applies, or `HTF TRANSITION: CONFIRMED` validates a reversal narrative |
| `POI LOCATION` | Fresh unmitigated OB or FVG in the trade direction |
| `LTF CONFIRMATION` | 15M BOS/CHoCH plus displacement per Step 3 |

**Note on pillar independence:** the three pillars are correlated reads
of the same price series (see Design Intent). The gate enforces different
types of evidence — bias, location, trigger — but not independent
verification. See Design Intent for the full framing.

Gate logic:

- Missing `HTF BIAS` → `INVALID`
- Missing `POI LOCATION` → `INVALID`
- Missing only `LTF CONFIRMATION` → may be `WAITING`, but only if the
  exact trigger can be named
- Cannot identify 3 distinct contributing factors → `WAITING`, not `VALID`

### HTF Narrative Rule

The tradable narrative may be: continuation with the Daily trend, or a
true reversal narrative after sweep + CHoCH + displacement on 4H.
Daily remains the macro anchor; 4H defines the actual tradable leg.

### HTF Transition / Reversal Watch Mode

Use when the proposed trade direction conflicts with the current HTF
label but fresh evidence suggests transition.

Mandatory output fields when transition evidence exists:

- `HTF TRANSITION: NONE / EARLY / WATCH / CONFIRMED`
- `TRANSITION DIRECTION: BEARISH_TO_BULLISH / BULLISH_TO_BEARISH / NONE`
- `TRANSITION FACTORS: [list]`
- `TRANSITION VERDICT: BOUNCE_ONLY / WATCH_FOR_REVERSAL / REVERSAL_CONFIRMED`

**Transition evidence factors** (score only objective evidence):

1. `HTF STRUCTURE BREAK` — close beyond last meaningful swing with
   displacement. Wick through is not enough.
2. `MAJOR HTF LIQUIDITY SWEEP + RECLAIM` — sweep then immediate decisive
   close back through with displacement.
3. `INSTITUTIONAL HTF LOCATION` — reacting from monthly/weekly/daily
   demand/supply, yearly/quarterly open, quarterly FVG, major OB, deep
   discount/premium, or major historical shelf.
4. `ACCUMULATION / DISTRIBUTION EVIDENCE` — repeated failed
   breakdowns/breakouts, multiple stop hunts, range formation after
   extended trend, breakout with participation.
5. `IMPULSE QUALITY SHIFT` — new-direction moves show displacement;
   old-direction pullbacks become shallow/overlapping.
6. `MTF CONFIRMATION STACK` — 4H/Daily starts transition, 1H confirms,
   15M confirms entry timing.
7. `NARRATIVE / CATALYST SHIFT` — optional supporting factor only.
   Must not replace price structure.

**Classification:**

- `EARLY`: 1–2 factors, no 4H/Daily structure break confirmed. Output
  usually `WAITING` or `NO TRADE`.
- `WATCH`: ≥ 3 factors including structure break or major sweep+reclaim,
  plus institutional location. LTF confirmation incomplete. Create/update
  watcher for next deterministic confirmation.
- `CONFIRMED`: 4H/Daily confirms with close + displacement · price
  reclaims/holds broken level · transition starts from valid HTF location ·
  1H/15M confirms continuation · RR clean.

Only `CONFIRMED` may satisfy `HTF BIAS` as a reversal narrative.

**Transition judgment explanation** (only when EARLY, WATCH, or CONFIRMED):

- `WHY NOT JUST A BOUNCE`: one sentence.
- `HTF TRANSITION EVIDENCE`: exact HTF facts.
- `MISSING CONFIRMATION`: what is still required.
- `TRANSITION INVALIDATION`: level/condition that proves it wrong.

If the explanation cannot defend the label, downgrade it.

**Hard reversal safety rules:**

- 15M CHoCH/BOS alone never confirms an HTF reversal.
- POI tap, support bounce, oversold, divergence, or wick sweep alone
  never confirms an HTF reversal.
- If Daily/4H remain bearish and only LTFs turn bullish, label
  `BOUNCE_ONLY` or `EARLY`.
- In counter-bias conditions, passive entries are prohibited unless the
  passive-entry exception is fully satisfied and logged.
- If transition evidence is promising but incomplete, output `WAITING`
  with the exact next confirmation needed.
- Do not upgrade to `VALID` unless the full execution chain passes.

### Daily Trend Resumption Exception

May pass the `HTF BIAS` gate when: Daily bias is clearly directional ·
4H is in counter-trend correction · 15M prints fresh CHoCH/BOS +
displacement back in Daily direction · 15M entry POI is fresh and
unmitigated · 4H has not already reversed structure in the opposite
direction. See Appendix B for invocation rules.

### Weighted Confluence Table

Minimum tradable score: **4.0**
Minimum distinct contributing factors: **3**

> Weights are structured heuristics reflecting relative importance.
> They are not statistically calibrated. A score of 9/15 is precise
> but not "accurate" in a statistical sense. Treat scores as structured
> reasoning aids, not measured probabilities.

| Factor | Weight |
|---|---:|
| Daily bias aligns with trade direction | 1.5 |
| Daily trend resumption exception (bonus) | +1.0 |
| HTF transition confirmed as reversal narrative | 1.5 |
| HTF transition watch confluence (not yet confirmed) | 0.5 max |
| 4H structure confirms with displacement | 1.5 |
| 1H confirms / does not conflict | 1.0 |
| Price in correct premium/discount zone | 1.0 |
| Fresh unmitigated OB at entry zone | 1.0 |
| Unmitigated FVG at/near entry zone | 0.5 |
| Liquidity sweep before entry signal | 1.0 |
| Clean unswept HTF liquidity draw aligns with trade path | 0.5 |
| Second-layer confirmation (CISD / V-recovery / CTR, capped) | 0.5 max |
| Inside active kill zone | 1.0 |
| Volume confirms | 0.5 |
| 4H trend strength confirmed by ADX | 0.5 |
| Crypto VWAP alignment at POI | 0.5 |
| News environment clear | 0.5 |

**Maximum score: 15.0**

Scoring rules:

- HTF liquidity draw: award only for clean, unswept, relevant levels
  (PWH/PWL, monthly, major swing, EQH/EQL). Do not double-count with
  liquidity sweep.
- HTF transition: award confirmed OR watch, never both. Do not
  double-count the same 4H displacement as both transition confirmation
  and 4H structure confirmation.
- Second-layer: CISD, V-recovery, CTR share one capped 0.5 bonus.
- Volume: crypto from real exchange volume. Forex only when reliability
  is HIGH or MEDIUM. If LOW or NONE, do not award.
- Volume activity state changes monitoring urgency, not confluence points.

### Rating & Size

| Score | Rating | Base Risk |
|---|---|---|
| 4.0–5.5 | Standard | 1.0% |
| 6.0–8.0 | High Probability | 1.5% |
| 8.5+ | Elite | 2.0% |

Consistency: `RATING` must align with `CONFLUENCE` and `CONFIDENCE BAND`.
Do not label "Elite" if confirmation is pending or any exception was invoked.

See Appendix C for the full confidence system.

---

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

## Step 8 — Trade Setup

### Setup Status Definitions

| Status | Definition |
|---|---|
| `VALID` | All gates met, confluence ≥ 4.0, ≥ 3 distinct factors, displacement confirmed, POI alive, acceptable RR, ≤ 2 exceptions |
| `WAITING` | HTF bias and POI valid, but exact LTF trigger not printed |
| `WAITING - ACTIVE` | Still WAITING; volume ACTIVE; market waking up near trigger/POI |
| `WAITING - AGGRESSIVE` | Still WAITING; volume AGGRESSIVE; trigger may be close but confirmation still required |
| `INVALID` | Cannot become valid under current conditions |

### WAITING Trigger Rule

Allowed: `Price must reclaim 94,200 with a 15M displacement close above
the OB → VALID`

Not allowed: `Price needs to pull back` · `Waiting for confirmation`

If you cannot write a trigger that specific, the setup is `INVALID`,
not `WAITING`.

### WAITING Activity Rule

| Volume Activity | Label | Message |
|---|---|---|
| DORMANT | `WAITING` | Planned but not urgent |
| ACTIVE | `WAITING - ACTIVE` | Participation building; monitor trigger |
| AGGRESSIVE | `WAITING - AGGRESSIVE` | Trigger may be close; no chase |

Rules: use ACTIVE/AGGRESSIVE only if HTF bias and POI are valid. Never
bypass invalidation. Setup remains inactive until activation criteria print.

### WAITING Blueprint Rule

If WAITING, still provide the full planned setup: ENTRY ZONE · STOP LOSS ·
TP1 · TP2 · TP3 · MOVE BE AT · POSITION SIZE · WAITING TRIGGER.
The missing piece is activation, not planning.

### Execution Mode

Every VALID or WAITING setup must state one of:

- `PLACE LIMIT NOW`
- `PLACE LIMIT NOW (REDUCED)`
- `WAIT FOR CONFIRMATION`
- `NO TRADE`

If a sweep, reclaim, displacement close, or CHoCH is still required,
execution mode must be `WAIT FOR CONFIRMATION`.

If any HIGH caveat is active (trap HIGH or news HIGH RISK), execution
mode cannot be `PLACE LIMIT NOW`.

### Universal SMC Execution Chain

```
HTF thesis
→ price enters POI / retest zone
→ wait for LTF rejection or CISD
→ enter only if R:R is still clean
→ manage around liquidity targets
```

- Any step missing → not VALID yet.
- HTF thesis exists but price not at POI → WAITING.
- Price at POI but no LTF rejection/CISD/displacement → WAITING - ACTIVE.
- Rejection confirms but RR no longer clean → INVALID.
- Rejection confirms and RR clean → VALID.
- Watcher alert, level touch, POI tap = alert only, not the trade.

### Counter-Bias Forex POI Rule

When Daily and 4H are mixed, counter-trend, or unclear:

- No passive FVG, OB, or POI entries.
- POI touch gives location only, not trade permission.
- Status stays WAITING until LTF confirmation prints.
- Do not classify VALID only because price tapped a valid POI.

For a long in mixed/counter-bias conditions, require:
sweep/tap into POI → bullish rejection → 15M close/reclaim above
displacement midpoint/FVG top/OB boundary → retest hold → then entry
permission may be considered.

For a short: mirror the above.

If only the POI touch happened:

- `SETUP: WAITING`
- `EXECUTION MODE: WAIT FOR CONFIRMATION`
- `PASSIVE ENTRY STATUS: NOT ELIGIBLE — HTF bias mixed/counter-bias`
- Deterministic WAITING TRIGGER

### Passive Entry Exception

Narrow exception for elite HTF-location trades likely to react before
textbook 15M confirmation prints.

All conditions must be true:

- Setup rated High Probability or Elite
- Daily and 4H aligned, or Daily Trend Resumption clearly applies
- Entry at fresh unmitigated Daily or 4H POI
- True first touch since creation
- Not mid-range; edge from HTF location itself
- Meaningful liquidity sweep or trap already occurred into the POI
- Kill zone / session supports immediate response
- Stop placement structurally clean
- TRAP RISK not HIGH
- NEWS STATUS not HIGH RISK
- REVERSE READ must be ALIGNED

**Session cooldown:** Maximum **1 passive entry per session**. If the
previous passive entry in this session failed (time-failed or stopped),
the next passive entry requires explicit user override.

If all conditions hold:

- Execution mode: `PLACE LIMIT NOW (REDUCED)`
- Initial passive size: 25%–50% of normal planned size
- Remaining size added only after exact 15M confirmation trigger prints
- If reaction is weak/sluggish/fails to confirm within 2–4 completed
  15M candles after fill (2 for sharp session setups, 4 for exceptional
  HTF locations with slower expansion), treat as time-failed and stand down

If used, output: `PASSIVE ENTRY EXCEPTION INVOKED` · status · why location
qualifies · why reduced staging allowed · exact trigger for adding size ·
exact reduced fraction.

Even when not used, output: `PASSIVE ENTRY STATUS: NOT ELIGIBLE — [reason]`

### Entry

- Entry at or inside the identified unmitigated 15M OB/FVG.
- Default: **proximal edge** (closest to current price).
- Midpoint: only with passive-entry exception.
- Distal: only if retest of distal edge is explicitly part of WAITING
  TRIGGER.
- If the trade plan does not state which edge, it is incomplete.

### Stop Loss — Structural Invalidation

**Step 1 — Identify invalidation timeframe:**

| Trade Driver | Invalidation TF |
|---|---|
| 4H structure + 15M entry | 4H swing |
| 1H structure + 15M entry | 1H swing |
| 15M scalp only | 1H nearest structural level |
| Daily trend resumption | 4H counter-trend extreme |

**Step 2 — Distinguish micro vs. structural levels:**

A level is **micro** (unsafe for SL) if ANY: single-candle swing with no
HTF significance · wicked through in last 10–20 candles · within
0.15%–0.25% of entry (crypto) or 5–8 pips (forex majors) · OB midpoint
rather than extreme · formed in last 4–8 candles with no HTF context ·
inside active FVG/OB/IRL zone.

A level is **structural** (valid SL candidate) only when ALL: clear swing
on invalidation TF · beyond visible stop-side liquidity · distance ≥ 0.20%
(crypto) or 10+ pips (forex majors) · breaking it flips the bias · not
the obvious retail level (EQH/EQL, round number, recent unswept swing).

**Step 3 — Stop-side liquidity and sweep buffer:**

Include unswept stop-side liquidity. If rejection block boundary is
fresher than broad OB, use it. If liquidity grab occurred on stop side,
SL beyond grab wick.

Primary buffer: `0.25 × ATR(20)` of the invalidation timeframe beyond
the structural level.

Fallback when ATR unavailable:

| Market | Buffer |
|---|---|
| Crypto alts (SOL, AVAX) | 0.15%–0.25% |
| BTC / ETH | 0.10%–0.15% |
| Forex majors | 3–5 pips |
| Forex crosses (GBPJPY) | 5–8 pips |
| Gold / XAUUSD | $2–$3 |

If ATR buffer would exceed 2× fallback, reconsider the invalidation TF.
State when fallback was used.

**Step 4 — RR integrity check:**

After placing SL, recalculate RR. TP1 must meet minimum (1:2 standard,
1:1.5 only with valid exception). If TP1 fails and no exception applies:

1. Wait for better entry (price closer to invalidation zone)
2. Reduce size (keep wider stop, same dollar risk)
3. Skip

Never tighten SL into micro territory to salvage RR.

**Step 5 — Anti-anchoring check:**

"If I had no prior levels marked, where would I say the thesis is
wrong?" · "Is this level likely to be swept as normal behavior?" ·
"Am I anchoring to a previous read?"

If defending a level from before the current session's price action,
assume anchoring risk. Reset.

**SL output requirement:** `SL RATIONALE` must state invalidation TF ·
structural level · why structural not micro · stop-side liquidity ·
buffer used · post-SL RR.

**BTC rule:** Never place stops at obvious round numbers or clean swing
levels. After a grab, SL beyond the grab wick. Widen and reduce size
proportionally.

### Take Profit Levels

| Target | Description | RR |
|---|---|---|
| TP1 | Nearest clean liquidity / management target | Default formal validator |
| TP2 | 4H swing, major HTF level, clean external liquidity | May validate RR only under TP2 exception |
| TP3 | Major external liquidity sweep | 1:5+ |

Verify target is still unmitigated.

### RR Exceptions

See Appendix B for: TP2 RR Validation · Ranging Market RR · HTF Location RR.

### Trade Management

- At 1:1 → move SL to breakeven
- At TP1 → close 50%
- Trail rest toward TP2/TP3
- 15M CHoCH against position → consider full exit
- Target becomes mitigated before hit → reassess

### Drawdown-Based Position Scaling

| Condition | Override |
|---|---|
| 0–1 consecutive losses | Normal size |
| 2 consecutive losses | 50% size |
| 3 consecutive losses | Session stop / observation only |
| First trade back after stop | 50% size |
| Back to full size | Only after 2 consecutive wins |

This override takes priority over the base confluence size table.

### WAITING Watcher Rule

For every WAITING setup, arm a watcher on the Issue's `watch:` block
before the final answer.

Key rules:

- Complete analysis and commit to setup status FIRST. Do not write a
  watcher before the final decision.
- If no active watcher exists for this pair/setup, create one. If one
  exists, edit in place. Do not create duplicates.
- For multi-step sequences, arm only the next unmet step.
- Confirm on the Issues board that the watcher is healthy, then report
  the Issue reference and what it watches.

See **Appendix A** for the full watcher model, rule types, and
watcher-trigger re-analysis protocol.

---

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
| `AUDIT SMC DEFINITIONS` | Step 3: displacement, mitigation, liquidity, archetypes |
| `AUDIT TOP-DOWN` | Step 4: full 1D→4H→1H→15M chain + Reverse Read |
| `AUDIT VOLUME` | Step 5: source, reliability, activity state, divergence |
| `AUDIT GATES` | Step 6: HTF bias, transition, POI, LTF, confluence, exceptions, confidence |
| `AUDIT TRAP` | Step 7: trap risk rated |
| `AUDIT TRADE PLAN` | Step 8: status, execution mode, passive status, SL/targets/RR, entry edge |
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

## Step 10 — Compact Output Contract

Do the full analysis internally. The visible answer must be compact,
plain-English, and decision-first.

**Length targets:**

- Normal analysis: 12–22 short lines
- Complex transition/reversal: 22–30 lines max
- Full audit/reasoning dump: only when user explicitly asks

### Required Header (every output)

Combine into 4–5 lines:

```
PAIR: [pair] | MODE: [FULL PROTOCOL / FAST GATE / QUICK READ]
SETUP: [VALID / WAITING / INVALID / NO TRADE] | DIRECTION: [LONG / SHORT / NONE] | NARRATIVE: [TREND_CONTINUATION / DAILY_RESUMPTION / HTF_REVERSAL_CONFIRMED / BOUNCE_ONLY / NO_TRADE]
CONFLUENCE: [score]/15 — [strong / moderate / weak / n/a] | BAND: [LOW / MEDIUM / HIGH / ELITE] | RATING: [Standard / High Probability / Elite / No Trade]
REVERSE READ: [ALIGNED / CONFLICT / ANCHORING RISK]
```

`CONFIDENCE CAVEATS` line is printed **only when at least one caveat is
active.** If no caveats, omit the line entirely. Do not print
`CAVEATS: none`.

`CONFIDENCE BAND` is an **ordinal quality label, not a probability
estimate.** If the user asks for a probability, state the band, the
sample size in that band (or "none yet"), and explicitly state the
framework does not produce calibrated probabilities.

### Compact Bias Snapshot

Print only bias details that affect the decision:

- `DAILY`: bias + simple meaning
- `4H`: bias + simple meaning
- `1H`: bias + simple meaning
- `HTF TRANSITION`: only if not NONE, with the important reason

Example: `4H: still bearish — sellers control the bigger move`

### Core Reasons

3–5 bullets max. Each combines evidence + simple meaning. Include
confluence score and strongest factors. Include trap/news/volume/funding
only if materially decision-relevant.

For HTF transition outputs, include: WHY NOT JUST A BOUNCE (one sentence)
· CONFIRMING EVIDENCE (2–3 bullets) · MISSING CONFIRMATION (one sentence)
· INVALIDATION (level/condition).

### If SETUP = VALID → TRADE PLAN

- `ENTRY`: exact price/range, entry edge, execution mode
- `STOP`: exact level + simple reason
- `TP1 / TP2`: exact levels; TP3 only if useful
- `R:R`: to TP1 and TP2
- `POSITION SIZE`: normal/reduced + why
- `INVALIDATION`: what proves the trade wrong
- `DO NOT CHASE`: only if price already away from entry

### If SETUP = WAITING → WAITING PLAN

- `WAITING STATE`: DORMANT / ACTIVE / AGGRESSIVE + simple meaning
- `TRIGGER`: exact condition
- `ENTRY AREA`: level/range + entry edge
- `STOP / TARGETS`: planned levels only
- `INVALIDATION`
- `NO ACTIVE TRADE YET`: explicit
- `WATCHER`: Issue reference, status, trigger monitored

If ACTIVE or AGGRESSIVE, add: WHY ACTIVE (one sentence) · WHAT MUST PRINT
NEXT (one sentence) · DO NOT CHASE NOTE (if relevant).

### If SETUP = INVALID → WHY NO TRADE

- `WHY INVALID`: one clear reason
- `MISSING REQUIREMENT`
- `WHAT MUST CHANGE`
- `KEY RISK`: only if relevant

Do not fabricate a trade blueprint for an invalid setup.

### Exception Logging

If any exception is used, include `EXCEPTIONS INVOKED` section:

- `EXCEPTIONS USED: [N] of 2 maximum`
- If N = 2: `EXCEPTION CAP REACHED`
- List each: e.g. `DISPLACEMENT EXCEPTION INVOKED — [reason]`

If no exceptions, do not print the section.

### Plain-English Rule

Explain trading terms simply the first time they appear. After each core
reason, say what it means for price or market control. Avoid long theory.
Write like the user needs the useful result quickly. Keep numbers precise,
explanation human.

### Style Rules

Clean section headers · short labeled bullets · precise numbers · concise
reasoning · simple terms · useful for a trader not deep in SMC language ·
no hedging between WAITING and INVALID.

### Do Not Print By Default

Full STEP GATES · full PRE-OUTPUT AUDIT · every POI/OB/FVG found · long
confluence tables · full environment sections · repeated labels · raw
watcher JSON. Include HEAT STATUS only when account context was supplied
or execution requested.

---

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

## Appendix A — Watcher Phase Model

### Three Phases (no others valid)

| Phase | Meaning | Action |
|---|---|---|
| `THESIS_CONFIRMED_ENTRY_READY` | Fired trigger confirmed thesis; execution conditions exist now | Output full executable TRADE PLAN. Do NOT re-arm. Leave fired Issue as triggered history. |
| `THESIS_ALIVE_WAITING` | Fired trigger did not produce entry, but thesis valid and next deterministic trigger can be named | Rewrite same Issue's `watch:` block to next condition. Confirm healthy on board. |
| `THESIS_DEAD` | Thesis invalid, missed, became a chase, no clean path, or fresh structure shifted with no new thesis | Close fired Issue or clear `watch:` block. Confirm on board. |

Transition rules:

- `THESIS_CONFIRMED_ENTRY_READY` is terminal for the fired watcher.
- `THESIS_ALIVE_WAITING` must name the next deterministic trigger.
  If it cannot, it is `THESIS_DEAD`.
- `THESIS_DEAD` is terminal. A new setup requires fresh analysis.
- Banned phase labels: PULLBACK, CONFIRMATION, WEAKENED, SHIFTED,
  MISSED, INVALID_NO_TRADE. Distinctions live in `next_condition`
  prose, not phase labels.

### Supported Watcher Rule Types

- `price_enters_zone` with `low` / `high`
- `price_breaks_level` with `side` / `level`
- `price_crosses_level` / `level_reclaim` / `level_breakdown`
- `candle_close` with `side` / `level` / `timeframe`

Use `candle_close` (not `price_breaks_level`) when the trigger or
invalidation depends on a timeframe close. Use `price_breaks_level` only
for live intrabar alerts. Do not invent rule types.

Field mapping from the older Vibe watcher fields:

- `pair` / `asset_class` / `direction` / `timeframe` -> `watch.pair` (barId
  form), `watch.assetClass`, `watch.direction`, `watch.timeframe`
- `trigger_rules` -> `watch.rules` (camelCase; arrays of `{ type, ... }`)
- `invalidation_rules` -> `watch.invalidationRules`
- `invalidation_conditions` / `waiting_trigger` / `analysis_context` -> prose
  in the Issue body, not structured fields
- `watcher_id` -> the Issue reference returned by the Issues CLI
- `status: "active"` / `verified_pollable` -> the health state rendered on the
  Issues board after the watcher is armed

The watcher authoring contract lives in the `self-scheduling` skill — read it
before writing a watcher for the first time in a session. Create with
`alice issue create`; edit an existing watcher in place, never a second Issue.

### Multi-Step Sequences

Arm only the next unmet step, not the final condition in the sentence.

Example: `Wait for SOL to retrace into 66.06–66.93, reject, then close a
15M candle below 66.06.`

- First watcher: `price_enters_zone` at 66.06–66.93.
- Issue body records the later requirement: `next condition after
  trigger: check rejection/CISD; rewrite same watch: block to a 15M
  candle_close below 66.06`.

### Watcher-Trigger Re-Analysis

When an existing watcher fires:

**Choose response mode:**

- `FULL STRUCTURAL RE-ANALYSIS`: for first thesis-confirmation triggers,
  invalidations, weakened/shifted structure, unclear phase, or unreliable
  prior thesis.
- `FAST EXECUTION CHECK`: only when stored `watcher_phase` is
  `THESIS_ALIVE_WAITING` and prior analysis already confirmed thesis.
  Do not restart full top-down unless fresh data shows invalidation or
  material shift.

**FAST EXECUTION CHECK is not fast entry approval.** Fast means focused,
not shallow. Check: fresh data · exact fired condition · thesis survival ·
invalidation · location/chase risk · LTF rejection/CISD/displacement ·
volume/participation · RR from current entry to targets · management ·
invalidation. Must be willing to output WAITING, THESIS_DEAD, or
THESIS_ALIVE_WAITING.

**Outcomes:**

- Execution conditions present → `THESIS_CONFIRMED_ENTRY_READY` +
  full TRADE PLAN (direction, execution mode, entry, stop, TP1–TP3,
  RR, size, invalidation, management, reason). Do not re-arm.
- Thesis alive, one condition missing → rewrite same watcher,
  `THESIS_ALIVE_WAITING`, name `next_condition`.
- Missed, chase, no clean next condition → `THESIS_DEAD`, close watcher.
- Fresh structure shift → `FAST CHECK ESCALATED TO STRUCTURAL
  RE-ANALYSIS`, then classify based on new evidence.

**Continuity rules:**

- A fired watcher is an alarm bell, not a cage. Fresh evidence overrides
  stored thesis when structure shifted.
- If fresh structure reveals a better POI, FVG, liquidity draw,
  invalidation, or confirmation path, adapt and update the same watcher.
- Do not chain endless WAITING updates. Re-arm only for the next concrete
  execution phase unless structure genuinely shifted.
- If previous watcher was thesis-confirmation, the pullback/retest is
  `same thesis, next execution phase`, not a new thesis. Set
  `thesis_continuity: same_thesis_next_execution_phase`.
- If no concrete next phase after confirmation, classify `THESIS_DEAD`.

**Required Issue body fields on re-arm:** `watcher_phase` ·
`previous_watcher_phase` · `next_condition` · `thesis_continuity`
(`same_thesis_next_execution_phase` or `new_thesis_due_to_structure_shift`).

**Final answer must include:** `WATCHER PHASE: [phase]` and whether this
is same thesis / next phase or new thesis.

**Watcher line format:**

- Waiting: `re-armed fired watcher: [issue]`
- Ready: `triggered history kept: [issue]`
- Dead: `closed fired watcher: [issue]`

Do not print fenced JSON as the primary watcher action. The watcher is
armed through the Issue `watch:` block.

---

## Appendix B — Exception Registry

Maximum **2 exceptions per trade.** Declared **before** confluence scoring.
If a third would be needed → `WAITING` or `INVALID`.
Output must list every invoked exception. If cap hit:
`EXCEPTION CAP REACHED — no further exceptions available`.

### 1. Displacement Exception

Elite location substitute for full displacement template. See Step 3.

### 2. Passive Entry Exception

Reduced starter at elite HTF location before full 15M confirmation.
See Step 8. Max 1 per session. Cooldown after failure.

### 3. TP2 RR Validation Exception

TP1 becomes management target; TP2 becomes formal RR validator.
Requires: structural SL methodology satisfied · High Probability or Elite
rating or confluence ≥ 6.0 · TP1 nearby because it is first liquidity
pocket, not poor entry · TP2 clean, realistic, unmitigated, aligned ·
path to TP2 does not force through dense opposing liquidity, major HTF
POI, or Tier 1 risk · TP2 gives ≥ 1:2 RR (or 1:1.5 with another valid
RR exception) · clear management plan at TP1.

Output: `TP2 RR VALIDATION INVOKED` · TP1 labelled `management target /
partial` · TP2 labelled `formal RR validation target` · RR to both shown.

### 4. Ranging Market RR Exception

Relax TP1 from 1:2 to 1:1.5. Requires: Daily explicitly ranging ·
4H explicitly ranging · confluence ≥ 6.0 · price at true range boundary ·
liquidity sweep at boundary confirmed.

### 5. HTF Location RR Exception

Relax TP1 from 1:2 to 1:1.5 outside pure ranges. Requires: High
Probability or Elite · fresh unmitigated HTF POI · location doing the
real work · path to target clean.

### 6. Daily Trend Resumption Exception

Passes HTF BIAS gate when Daily is directional, 4H in counter-trend
correction, 15M prints fresh CHoCH/BOS + displacement back in Daily
direction, 15M POI fresh, 4H has not reversed opposite. See Step 6.

---

## Appendix C — Confidence System

Two separate layers. Never mixed into one number.

### Layer 1 — CONFIDENCE BAND

Ordinal quality label from confluence score only.

| Band | Confluence | Meaning |
|---|---|---|
| `LOW` | 4.0–5.0 | Minimum passing; some gaps or conflicts |
| `MEDIUM` | 5.5–7.0 | Clean structure, no gaps |
| `HIGH` | 7.5–10.0 | Strong multi-TF alignment |
| `ELITE` | 10.5+ | Exceptional, no gaps |

### Layer 2 — CONFIDENCE CAVEATS

Separate risk layer. Does NOT change the band. Adjusts execution and size.

Caveats reported: TRAP RISK · REVERSE READ · NEWS STATUS · EXCEPTIONS USED.

| Caveat Combination | Effect |
|---|---|
| Any HIGH caveat (trap HIGH or news HIGH RISK) | Cannot `PLACE LIMIT NOW`; size 50% |
| REVERSE READ: CONFLICT | Size 50%; mandatory counter-thesis in output |
| REVERSE READ: ANCHORING RISK | Restart Step 4A |
| 2 exceptions used | Size 50% |
| LOW band + any HIGH caveat | WAITING only; cannot be VALID |

Output format:

- `CONFIDENCE BAND: [band] — ordinal quality label, not a probability estimate`
- `CONFIDENCE BASIS: [one-line reason]`
- `CONFIDENCE CAVEATS: [list]` — **only when at least one caveat is active**

Do NOT output a numeric probability percentage.

If asked "what's the probability": state the band · state sample size in
that band from recorded trades (or "no sample yet") · state explicitly:
"This framework does not produce calibrated probabilities. The band is an
ordinal quality label derived from structural confluence."