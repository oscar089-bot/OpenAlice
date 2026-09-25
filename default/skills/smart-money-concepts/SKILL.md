---
name: smart-money-concepts
description: >
  ICT / Smart Money Concepts analysis over OpenAlice K-lines: fair value gaps
  (FVG), swing highs and lows, break of structure (BOS), change of character
  (CHoCH), order blocks (OB), liquidity sweeps, previous high/low, sessions and
  retracements. Use whenever the question is about market STRUCTURE or
  supply/demand geography rather than a scalar indicator: "where are the fair
  value gaps on BTC", "did AAPL sweep liquidity", "is this a CHoCH or a BOS",
  "mark the order blocks on ES", "where is the nearest unmitigated imbalance".
  Runs a Python bridge over `alice market bars`; builds its own venv on first
  use, so no manual install is needed.
---

# Smart Money Concepts (SMC / ICT)

Structural analysis, not indicator values. `alice-analysis` answers "what is
RSI"; this skill answers "where did price leave an imbalance, and what did it
break to get here".

All indicators come from the upstream `smartmoneyconcepts` Python package
(MIT). This skill is a thin bridge: it reads K-lines through the `alice` CLI,
runs the package, and prints JSON. OpenAlice does not reimplement the maths.

## Prerequisite

Needs `python3`. **Nothing to install by hand** — on first use the script
provisions its own isolated venv (at `$OPENALICE_HOME/tools/smc-venv`, created
with `uv` when available) holding `pandas` and `smartmoneyconcepts`, then
re-runs itself inside it. Progress goes to stderr; stdout stays pure JSON.

It reuses an interpreter that already has the deps, so a deliberate install
(e.g. an AutoQuant desk's own environment) is respected rather than shadowed.
Pass `--no-bootstrap` to forbid venv creation and fail instead. Point
`OPENALICE_SMC_VENV` at a directory to choose the location yourself.

The venv lives outside this Skill's tree on purpose: Alice fingerprints every
file in a Skill and copies that tree into each Workspace, so an environment
stored here would corrupt the version fingerprint and be duplicated per desk.

If no Python interpreter is available at all, say so and fall back to
`alice analysis quant` for the scalar part of the question. Do not silently
skip the structural part.

The first run creates the venv and can take a minute; later runs reuse it.

## Locating the script

`scripts/smc.py` ships inside this Skill's own directory. Alice injects every
Skill into **both** `.agents/skills/<name>/` and `.claude/skills/<name>/` —
identical copies. Use whichever matches your runtime:

| Runtime | Path (relative to the Workspace root) |
|---|---|
| Most agents (Codex, Pi, Cursor, …) | `.agents/skills/smart-money-concepts/scripts/smc.py` |
| Claude Code | `.claude/skills/smart-money-concepts/scripts/smc.py` |

Both work; if one is missing, use the other. Run it from the Workspace root,
where your shell already starts.

## Workflow

**1. Find the barId.** Same handle the chart and `alice-analysis` use:

```bash
alice market search-bars --query AAPL
```

**2. Run the analysis.** One call computes the whole dependency chain
(swings feed BOS/CHoCH, OB, liquidity and retracements). Set `SMC` once, then
reuse it:

```bash
SMC=.agents/skills/smart-money-concepts/scripts/smc.py   # or .claude/... (see above)

python3 "$SMC" analyze \
  --bar-id 'yfinance|AAPL' --asset-class equity --interval 1d --count 250
```

Broker barIds (`alpaca-paper|AAPL`) and opt-in keyless exchange sources
(`binance-readonly|BTC/USDT`) need no `--asset-class`. Vendor sources resolve
by exact catalog match; pass `--asset-class` when lookup is ambiguous.

Select a subset with `--indicators`, and tune detection with `--swing-length`:

```bash
python3 "$SMC" analyze --bar-id 'binance-readonly|BTC/USDT' --interval 4h \
  --count 400 --indicators fvg,swing_highs_lows,bos_choch --swing-length 20
```

**3. Read the JSON.** Only actionable rows are emitted (all-NaN detector rows
are dropped). Every row carries the bar's `date`, so you can cite a level and
a time.

Discrete detectors (`fvg`, `bos_choch`, `ob`, `liquidity`) return their full
event history. State detectors would otherwise repeat on every bar, so they are
summarized: `previous_high_low` and `retracements` return only the latest
reading, and `sessions` returns only bars where the session is active. Pass
`--full-series` to get every bar for any of them.

## Verbs

| Verb | Output |
|---|---|
| `analyze` | Requested indicators as labeled JSON records |
| `bars` | The prepared OHLCV frame — use when you want to compute something else in the same script |
| `list` | Indicator names, parameters and defaults |

## Indicators

| `--indicators` key | What it marks | Key output columns |
|---|---|---|
| `fvg` | Fair value gap — a 3-candle imbalance | `FVG` (1 bull / -1 bear), `Top`, `Bottom`, `MitigatedIndex` |
| `swing_highs_lows` | Fractal pivots over `swing_length` bars each side | `HighLow` (1/-1), `Level` |
| `bos_choch` | Break of structure vs change of character | `BOS`, `CHOCH`, `Level`, `BrokenIndex` |
| `ob` | Order block — the last opposing candle before an impulse | `OB` (1/-1), `Top`, `Bottom`, `OBVolume`, `Percentage` |
| `liquidity` | Clustered equal highs/lows within `range_percent` | `Liquidity` (1/-1), `Level`, `End`, `Swept` |
| `previous_high_low` | Prior period high/low and whether it broke | `PreviousHigh`, `PreviousLow`, `BrokenHigh`, `BrokenLow` |
| `sessions` | Which candles sit in a named session | `Active`, `High`, `Low` |
| `retracements` | Depth pulled back from the last swing | `Direction`, `CurrentRetracement%`, `DeepestRetracement%` |

Defaults: `swing_length=50`, `range_percent=0.01`, `close_break=true`,
`close_mitigation=false`, `join_consecutive=false`, `time_frame=1D`.
Override with `--swing-length`, `--range-percent`, `--close-break`,
`--close-mitigation`, `--join-consecutive`, `--time-frame`, and for sessions
`--session` plus `--start-time` / `--end-time` / `--time-zone`.

`list` prints this table with the live signature, which is authoritative if the
upstream package adds or renames a parameter.

## Reading the output

- **`MitigatedIndex` / `Swept` null means still open.** An unmitigated FVG or an
  unswept liquidity level is the live one; a filled one is history, useful for
  context but not for an entry.
- **BOS continues, CHoCH reverses.** Bullish BOS = trend continuation through a
  prior swing high. Bullish CHoCH = the first break against the prior
  direction. Do not report a CHoCH as a confirmed reversal on its own — it
  marks a character change, not a completed one.
- **`swing_length` is the single biggest lever.** 50 on daily data is
  structural/macro; 5-20 on intraday is tactical. State the value you used.
  Two answers that disagree usually used different `swing_length`, not different
  data.
- **OB `Percentage` is a strength proxy, not a probability.** It compares the
  block's volume against its neighbours.
- **Levels are geography, not signals.** Combine with the scalar side
  (`alice-analysis`: RSI, trend, RVOL) before drawing a conclusion. A FVG in a
  vacuum is just a gap.
- **Repainting caveat.** Swing detection looks `swing_length` bars forward, so
  the most recent `swing_length` bars cannot contain a confirmed pivot — the
  newest swing is provisional by construction. Say so rather than reporting a
  pivot that may vanish.

Upstream ships this indicator set for educational use and states it should not
be a sole decision maker. Pass that through when the output drives a trade
suggestion; pair it with the risk and position-sizing path in `alice-uta`.

## Scope

This skill is analysis only. It reads K-lines and computes; it never places,
stages, or approves an order. Trading writes stay behind `alice-uta` and the
UTA authority boundary.

## Attribution

The `smartmoneyconcepts` package is MIT licensed, by Joshua Attridge and
contributors: https://github.com/joshyattridge/smart-money-concepts. It is
installed from PyPI at use time and is NOT vendored into this repository. Only
this bridge script is OpenAlice-authored; see `THIRD_PARTY_NOTICES.md`.
