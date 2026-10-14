---
name: self-scheduling
description: >
  Define durable work and scheduled/headless execution with
  `.alice/issues/<id>.md`: structured ownership and optional `when` frontmatter
  plus one canonical markdown What. Use for creating or editing an Issue,
  choosing its assignee, schedule, prompt, delivery behavior, or health state.
  Use the `alice` skill instead when the goal is to ask another
  Session for an answer.
---

# Issues & self-scheduling — `.alice/issues/<id>.md`

OpenAlice treats an issue as a collaboration object, not just a timer. It is the
durable place to put trading follow-up, monitoring work, open questions,
handoffs, and scheduled checks. Status, priority, and assignee tell humans and
agents what deserves attention; `when` is the extra field that lets an issue
summon a headless agent run.

This workspace owns its work as **one markdown file per issue** in `.alice/issues/`
at its own root. Each file is YAML frontmatter (the structured fields) plus a
markdown What (the human-visible work definition and exact scheduled prompt).

- An issue **without** `when` is a plain **tracked work item** — it appears on
  the Issue board for you and the user to see, but the scanner never fires it.
- An issue **with** `when` **self-schedules**: a launcher scanner reads the dir
  (it never interprets the work) and fires a **headless run** of this workspace
  when the issue is due — exactly like a recurring job.

The filename stem **is** the issue id (`morning-scan.md` → id `morning-scan`).

## Two ways to manage issues — the CLI (agent surface) or the file

You have two equivalent paths, and both write the **same**
`.alice/issues/<id>.md` files:

1. **`alice issue …` — the convenient agent surface, and what you
   should reach for first.** A small set of verbs does the read-modify-write for
   you: id slug derivation, frontmatter validation against the allowed
   status/priority enums, structured comment sidecars, and not clobbering an
   existing id. The same tools are also exposed over **MCP** — it is *one*
   registration behind both, so an MCP-speaking agent gets the identical surface
   with no separate path.
2. **Editing the file directly** with your normal file tools. Reach for this when
   you are writing rich markdown **What** or scheduling frontmatter
  (`when` / `assignee` / `agent` / `credential` / `credentialSource` / `model` / `effort` / `timeout` / `commentPrompt`) — the CLI verbs cover the board fields, What, timeout, comment prompt, and
   comments, but the document and schedule shape read most clearly as text. The
   file is always the single source of truth either way.

### CLI verbs

```bash
# list — scan the WHOLE board: every workspace's issues as compact title rows
alice issue list

# show — one issue in full, resolved by its (global) name: frontmatter + What + comments +
# run history + inbox reports. --id takes a name OR id and resolves across the
# board; a name two workspaces share returns the candidates to pick from.
alice issue show --id morning-scan

# create — a new issue. --title is required; --id is derived as a kebab slug
# from the title when omitted. Creating over an existing id is refused.
alice issue create --title "Split the data fetcher" \
  --priority medium \
  --what "src/fetch.ts mixes the HTTP call with the normalization step."

# update — patch board fields, canonical What, or the optional run timeout;
# scheduling cadence (`when`) is left untouched. Setting status done|canceled is how
# you silence a self-scheduled issue (there is no separate enabled flag).
alice issue update --id morning-scan --status done
alice issue update --id morning-scan --timeout 30m

# comment — append markdown to the structured `<id>.comments.json` sidecar. An
# attributable Session signs with @resumeId. If somebody else comments on an
# For a fixed @resumeId owner, OpenAlice asks that owner in the background.
# Human comments without one ask the creator or a reconstructed Workspace Agent.
# Agent-authored comments without a fixed owner remain timeline notes.
alice issue comment --id morning-scan --text "Brief pushed; SPY gapped +0.4%."
```

Run `alice issue <verb> --help` for a verb's flags. Object-valued flags
take JSON — e.g. to create a self-scheduled issue in one call, pass the schedule
as `--when`:

```bash
alice issue create --title "Pre-market brief" --priority high \
  --when '{"kind":"cron","cron":"30 8 * * 1-5","timezone":"America/New_York"}' \
  --assignee @me \
  --what "Pull pre-market movers and overnight news for my watchlist, write a short brief to research/premarket.md, then run: alice inbox push --body-file research/premarket.md." \
  --agent codex \
  --credential openai-primary \
  --model gpt-5.6 \
  --effort high
```

The verb set is `list` / `show` / `create` / `update` / `comment` (no `delete` —
remove an issue by deleting its file, see Notes). **Reads are global, writes are
local:** `list` and `show` read the whole board across **every** workspace —
scan titles with `list`, decide which matter, then `show --id <name>` to read those
in full (the natural way to work a board) — while `create` / `update` /
`comment` write **this** workspace's own `.alice/issues/` files (changing a
peer's board is the human-approved peer-edit path). The examples below show the
on-disk file shape the CLI and your direct edits both produce.

## Example — a scheduled issue (`.alice/issues/morning-scan.md`)

```markdown
---
title: Pre-market brief
status: todo
priority: high
assignee: "@resume-calm-amber-river-a1b2c3"
when: { kind: cron, cron: "30 8 * * 1-5", timezone: America/New_York }
---

Pull pre-market movers and overnight news for my watchlist. Every trading
morning at 08:30, assemble the pre-market picture before the open, write a short
brief to `research/premarket.md`, then push it to Inbox. Cover movers, gaps, and
overnight headlines that move the thesis.
```

## Example — an unscheduled work item (`.alice/issues/refactor-fetcher.md`)

```markdown
---
title: Split the data fetcher into source + transform
status: backlog
priority: medium
assignee: "@unassigned"
---

`src/fetch.ts` mixes the HTTP call with the normalization step, which makes the
retry logic hard to test. Pull the transform into its own pure function so it
can be unit-tested without the network. No rush — picking this up next time we
touch fetching.
```

The first self-schedules (it has `when`) and keeps one accountable product
Session; the second is a pure work item the scanner ignores. Drop the `when`
line and any issue becomes a
plain tracked item; add a `when` and it starts firing.

## Frontmatter fields

- **`title`** — short, human-readable title of the issue (e.g. `Pre-market
  brief`). **Required.** This is what the Issue board and Inbox show. (The
  stable machine key is the filename `id`, not the title — so you can reword a
  title freely.)
- **`status`** *(optional, default `todo`)* — one of `backlog`, `todo`,
  `in_progress`, `done`, `canceled`. For a **scheduled** issue this is also its
  on/off switch: it fires only while the status is non-terminal. Moving it to
  `done` or `canceled` **silences** the schedule without deleting the file.
  (There is no `enabled` field — terminal status is how you pause a timer.)
- **`priority`** *(optional, default `none`)* — `urgent`, `high`, `medium`,
  `low`, `none`. Display/sort only.
- **`assignee`** *(optional)* — the single owner and
  scheduled-dispatch policy:
  - `@new-each-run` recruits a new product Session for each scheduled fire;
  - `@new-then-resume` asks the Workspace to recruit once; the first successful dispatch
    rewrites the Issue to that concrete `@resumeId`, so every later fire returns
    to the same accountable coworker;
  - an exact `@resumeId` continues that accountable Session, even when its
    signed Workspace differs from the Issue's Workspace;
  - `@human` and `@unassigned` are valid only for unscheduled work.
  CLI `issue create` defaults to `@me` when called by an attributable Session
  (who creates it owns it); `@me` is resolved to a concrete `@resumeId` before
  writing. Otherwise omitted scheduled ownership defaults to `@new-then-resume`, while an
  unscheduled board item defaults to `@unassigned`. Use `@new-each-run` explicitly
  only when every fire should recruit a newcomer.
- **`when`** *(OPTIONAL — present iff the issue self-schedules)* — one of:
  - `{ kind: every, every: "30m" }` — repeat on an interval (`30m`, `2h`,
    `1h30m`). Runs on the next scan, then on the interval.
  - `{ kind: cron, cron: "0 9 * * 1-5", timezone: local }` — a 5-field cron
    expression (`min hour day-of-month month day-of-week`; supports `*`, ranges
    `9-17`, lists `1,15`, steps `*/15`). `timezone` is part of the intent:
    use `local` for the user's own wall clock (morning reminders), or an IANA
    zone such as `America/New_York` for a market clock (pre-open scans). The
    zone handles daylight-saving changes. Omitted timezone remains machine-local
    only for compatibility with old files; new Issues should write it explicitly.
    A missed admission (busy Session, full worker pool) **retries that slot by
    default**, same as `every`. Write `catchUp: false` only when a miss should
    discard all elapsed slots and wait for the next future calendar time.
  - `{ kind: at, at: "2026-03-01T13:30:00Z" }` — run ONCE at an ISO timestamp,
    then never again.
- **`agent`** *(optional)* — runtime override for `@new-then-resume` / `@new-each-run`
  scheduled work; defaults to this Workspace's runtime resolution. An exact
  Session assignee already has a fixed Agent runtime, so Session-owned Issues
  cannot set this.
- **`credential`** *(optional)* — secret-free OpenAlice vault slug for the
  fresh Session. Never put a key or endpoint in the Issue file.
- **`credentialSource: native`** *(optional)* — explicitly use the Agent
  runtime's own login. It cannot be combined with `credential`. Omit both to
  inherit this Workspace's headless fixed/recent preference.
- **`model`** *(optional)* — native model id for a fresh Session. Omit it to
  inherit the selected credential, Workspace, or native runtime default.
- **`effort`** *(optional)* — reasoning effort for a fresh Session: `none`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, or `max`. Use a level supported by the
  selected runtime; omit it to inherit.
- **`timeout`** *(optional)* — scheduled-run watchdog: `15m`, `30m`, `45m`, or
  `60m`. Omit it for no limit (the agent may run until it exits). This is a run
  budget, not Session birth, so an exact `@resumeId` owner may still set it.
- **`commentPrompt`** *(optional)* — template for the Input Prompt sent when a
  comment needs a reply. Omit it to keep the default wrapper (Issue identity
  plus “reply directly; do not call `issue comment`”). Override replaces that
  whole structure. Tokens: `{comment}`, `{title}`, `{id}`, `{workspaceId}`,
  `{author}`, `{what}`. Must include `{comment}`. Chat-style Issues use
  `{comment}` alone.

`agent`, `credential`/`credentialSource`, `model`, and `effort` on an Issue seed a
new Session. They are valid only for `@new-then-resume` / `@new-each-run`;
do not write them into an Issue assigned to an exact `@resumeId`. That rule does
not freeze the existing Session's AI choice: its Agent runtime stays fixed, but
its credential, model, and effort can change for later launches. Use the Issue
page's assigned-Session settings or Session Settings while idle for an immediate,
validated update. `alice conversation ask --resume-id <resumeId>` with
`--model <id>` / `--effort <level>` and `--prompt <message>` can update an idle
Session and send its next turn. If editing the Session's own configuration file,
change `ai.model` / `ai.reasoningEffort` in `.alice/sessions/<resumeId>.json`,
preserve its other fields (especially `ai.credential`), and keep valid JSON.
Alice reconciles valid file edits on the scheduler tick; the change applies to
the next launch, not the current process. Never put a key in this file. The
scheduler freezes Issue values into a fresh Session binding and does not rewrite
persistent Workspace configuration.

> **Deprecated assignee aliases:** never write `@workspace` or `@new` in a new
> or edited Issue. They exist only so older Workspace files can be migrated:
> `@workspace` → `@new-each-run`, and `@new` → `@new-then-resume`. The CLI and
> API reject both deprecated spellings with the canonical replacement.

The old parallel `execution` field is retired and rejected after migration;
never write it into a new Issue.

> **Never write `connectorDesk`.** It marks the ONE phone-desk Issue per
> connector and is written only by Connector Settings. Hand-writing it onto an
> ordinary Issue removes that Issue from the board (desk rows are hidden) and
> makes the real phone-desk file invalid. A watcher that should notify you on
> Telegram does not need it — the watcher wakes the Session, and the Session's
> reply reaches you however that Session already talks to you.

The markdown **What** below the closing `---` is the Issue's canonical work
definition. It is useful for every Issue; when scheduled, this exact visible
markdown becomes the headless prompt. Comments are separate structured markdown
records in `.alice/issues/<id>.comments.json`, written through `issue comment`.

Issue files are part of the Workspace's Git history. After intentionally
creating or modifying `.alice/issues/<id>.md`, make a focused Git commit for
that work-definition change; never sweep unrelated working-tree changes into
it. OpenAlice Activity is the readable audit fallback (including edits made
without a commit), while Git is the exact-content history and rollback layer.

## Link entities and issues with `[[name]]`

An Issue's What can reference things in the `[[]]` knowledge graph, exactly like
any other note: write `[[name]]` to link a **tracked entity** (an asset ticker
or topic, e.g. `[[vst]]`, `[[ai-data-center-power]]`) or **another issue** (by
its id or title). The link shows up as a backlink on the target's page and is
clickable in the issue detail — so an issue saying "blocked on
`[[refactor-fetcher]]` until `[[vst]]` earnings clear" wires straight to both.

Names are **global** and team-wide, not workspace-scoped — `[[vst]]` means the
same thing everywhere, and there is no workspace prefix. Because of that, a
**vague or short issue title can collide** with an issue of the same name in
another workspace; nothing blocks you at write time, but the board flags such
clashes with a duplicate-name warning in the UI **for you to clean up
manually** (rename one, or merge them). So give an issue a **specific,
self-describing title** (prefer `Split the data fetcher into source + transform`
over `cleanup`) — it makes the issue a clean, unambiguous `[[ ]]` target and
avoids the collision flag in the first place.

## Write `what` for a headless run

The scheduled run is **headless — nobody is watching, and it cannot see this
conversation.** Write What as a
**complete, standalone instruction**, as if handing the job to a fresh teammate
who has only this workspace's files. Say exactly what to read, do, and produce.

Decide whether the run should notify the human or simply update its work:

- If the run produces something the user should see — a brief, a finding, a
  result — use **Inbox for an outward-facing notification or report**:
  `alice inbox push --body "…"` (reference files with `[[relative/path.ext]]`,
  or publish Markdown using `--body-file <path>`). A report pushed
  during a scheduled run is automatically linked back to the issue that
  triggered it — you don't pass any id.
- If the run is a **check that didn't trigger** (condition not met, nothing
  changed), **exit silently — that is the correct outcome**, not a failure.
  Don't manufacture noise.

A Connector-backed Issue may deliver its reply directly to the connected chat;
other headless runs need not have a chat recipient. Do not assume every runtime
reply is delivered. Put an Inbox push in What when a separate notification or
report is part of completion, and avoid duplicating a reply that already serves
that purpose. Inbox is a human delivery record, not storage for every run result.

Put **conditions inside `what`**, not in the schedule — there is no condition
field. For "ping me only if X", write: "check X; if it holds, push an alert;
otherwise do nothing and exit."

> **Commit the file.** The scanner reads your working tree, so an uncommitted
> `.alice/issues/<id>.md` still takes effect — but commit it so the issue (and
> any schedule) travels with the workspace and survives. Treat it like any
> other source file.

> **Trades still need a human.** A scheduled run can research, prepare, and even
> *stage* trades — but staged trades execute only when you approve them in the
> Web UI (Trading-as-Git). A timer never moves money on its own.

## Watch a market condition with `watch`

A `watch` is a **deterministic market condition**, not a timer. Alice evaluates it
every 5 seconds against live price. The moment the condition first becomes true,
it wakes this Issue's owning Session with your What as the plan, sends a Discord
alert, and lets you re-arm for the next phase.

Use a watcher instead of a frequent `when` whenever the work is
**"do something when the market does X"**:

- entry/reclaim/breakout conditions ("alert when BTC closes 1h above 110k")
- invalidation conditions ("tell me if SOL loses 92")
- trade management ("wake me at 2R", "alert if unrealized P&L drops below -5%")

A `when` schedule re-runs the agent on a clock whether or not anything changed.
A `watch` runs an agent **only when the condition actually fires** — so a watcher
that never triggers costs nothing but a price lookup.

> The complete field-by-field contract — every top-level field, rule type, pair
> form, and lifecycle rule — is in
> [the watcher reference](references/watch-reference.md). Read it before writing
> a `watch:` block you have not written before.

### Shape

```markdown
---
title: BTC 1h reclaim watch
assignee: "@resume-calm-amber-river-a1b2c3"
watch:
  pair: BTC-USDT
  assetClass: crypto        # crypto | forex | equity | commodity | index
  direction: LONG           # optional; sets the default rule side
  timeframe: 1h             # 1m or larger — 30s candles are not reliable
  rules:
    - { type: candle_close, timeframe: 1h, side: above, level: 110000 }
  invalidationRules:
    - { type: price_breaks_level, side: below, level: 98000 }
---

Re-analyse the reclaim against my original thesis, then tell me what changed and
what the next actionable level is. If the setup still holds, re-arm this Issue
for the next phase; otherwise mark it done.
```

- `pair` is a **bare symbol**, never a `source|symbol` barId. Write `BTC-USDT`,
  not `okx|BTC-USDT` or `yfinance|SOLUSD` — a barId here is passed to the vendor
  as a literal ticker and fails with *"No data found, symbol may be delisted"*.
  A `yfinance|...` barId is now **rejected at authoring time** with the symbol to
  write instead, so the mistake cannot be persisted silently.
  Crypto uses **exchange-native pairs** (`BTC-USDT`, `SOL-USDT`) and is priced
  from the keyless OKX exchange feed with real exchange volume; forex uses the
  Yahoo spot form (`EURUSD=X`). Do NOT guess the exact pair — confirm it with
  `alice market search-bars` and drop the `source|` prefix. Full pair table:
  [watcher reference](references/watch-reference.md#pair-rules-the-guard).
- `assignee: "@resumeId"` is what makes the wake return to **the same coworker**
  who wrote the analysis. Without it a scheduled-style recruit runs instead.
- The markdown **What** is the plan the woken Session receives. Write it as the
  next-step instruction — it is shown together with what just happened.
- A `watch` and a `when` may coexist on one Issue. They are independent: the
  clock fires the schedule, the market fires the watch.
- Add **`expiry: 2026-10-01T00:00:00Z`** to stop watching after a date.

### Presentation (`meta`) — what the watcher board shows

The deterministic rules decide *when* to wake you. The optional `meta` block is
what the **watcher board card** displays to the operator — your grade, the phase
name, and the next step. It is presentation only: the evaluator never reads it,
and changing it does **not** re-arm the watcher or replay an alert.

```yaml
watch:
  pair: BTC-USDT
  timeframe: 1h
  rules:
    - { type: candle_close, timeframe: 1h, side: above, level: 110000 }
  meta:
    grade: A+                 # setup quality shown on the card
    phase: reclaim             # which phase this watcher is watching
    nextStep: Re-check volume and the 4h structure before re-arming.
    waitingTrigger: BTC closes a 1h candle above 110k
    invalidationConditions:
      - BTC loses 98k on a 1h close
      - Funding flips negative for 3 consecutive periods
```

- `grade` / `rating` — setup quality. Without it the card reads `not graded`.
- `phase` — the plan phase (e.g. `reclaim`, `retest`, `phase 2`).
- `nextStep` — what the woken Session should do; shown as *Next after alert*.
- `waitingTrigger` — a plain-English trigger sentence, so the card reads
  without decoding the rule table.
- `invalidationConditions` — prose invalidation, shown alongside the rules.

Always set `grade` and `phase` when you arm a watcher. Leaving them out is why
the board looks empty even though the rules are working.

### Rule types

Every rule is `{ type, ... }`. Level rules need a numeric `level`; zone rules
need numeric `low` + `high`. **Use `side`, never `condition`.**

| `type` | Needs | Fires when |
|---|---|---|
| `price_breaks_level` | `side`, `level` | price is at or beyond the level (live) |
| `price_crosses_level` | `side`, `level` | price moves across the level since the last check |
| `candle_close` | `side`, `level`, `timeframe` | a **confirmed** candle closes beyond the level |
| `level_reclaim` | `level` | price is above the level (shorthand for `side: above`) |
| `level_breakdown` | `level` | price is below the level (shorthand for `side: below`) |
| `liquidity_sweep_touched` | `level` | price pokes beyond the level |
| `price_enters_zone` | `low`, `high` | price is inside the zone |
| `price_approaches_zone` | `low`, `high`, optional `threshold`/`thresholdPct` | price is within the threshold of the zone |

`side` defaults from `direction` when omitted (`LONG` → `above`, `SHORT` → `below`).

**`candle_close` only fires on confirmed candles**, and a candle that closed at or
before the watcher was armed is ignored — so re-arming never replays history.

### Trade management (`managementRules`)

To watch an **open** position, add a `position` block and `managementRules`. The
entry, stop, and side are frozen into the watcher at creation — nothing queries
the broker, so this works even when UTA is offline.

```yaml
watch:
  pair: ETH-USDT
  timeframe: 15m
  rules: []
  position: { side: LONG, entry: 3200, stop: 3050, targets: [3600] }
  managementRules:
    - { type: r_multiple_reached, multiple: 2 }
    - { type: unrealized_pnl_pct, op: below, pct: -4 }
```

`r_multiple_reached` measures reward against `entry - stop` (or `stop - entry`
for a short). `unrealized_pnl_pct` compares price to entry; `op` picks the
direction of the comparison.

### Anti-spam

Each rule fires **once**. After it fires the watcher stays armed but that exact
condition will not alert again until you re-arm, and a 15-minute cooldown
guards the remaining rules. Invalidation rules are **terminal**: the first one to
hit ends the watcher and reports `INVALIDATED`.

### Re-arming (this is the important part)

A watcher does **not** die when it fires — it is waiting for you to decide the
next phase. When you are woken:

1. Re-analyse against the event you were given.
2. Tell the user what changed (a normal reply; the Discord alert is separate).
3. If the thesis still holds, **rewrite the `watch:` block** with the next
   condition and update the What to describe the new phase. Because the block
   changed, Alice re-arms with fresh state and the previous phase's firing
   history is cleared.
4. If the thesis is finished or void, set `status: done` and delete the
   `watch:` block.

Keep the phase in the Issue so you do not lose the thread. Mention the current
step in What — for example *"phase 2: reclaim confirmed, now watch for the
retest of 108k"* — so the next wake has its own context.

> **Never place orders from a watcher wake.** Re-analyse, report, and re-arm, or
> stage a trade for human approval. A market condition is not approval.

> **The watcher is deterministic.** It does not read your prose. If the condition
> you care about is not expressible in the rules table, put the plain-English
> condition in What and add a `when` schedule instead, accepting the extra runs.

## Notes

- The scanner ticks about once a minute; a sub-minute cadence runs at most once
  a minute. Only issues with a `when` are ever fired.
- The `id` (filename stem) keys the scanner's "last fired" memory for scheduled
  issues, so don't rename a scheduled file you mean to keep (a new filename
  looks like a brand-new issue and fires right away).
- Runs are one-shot and independent — a run can overlap another run or your own
  interactive session in this same checkout. Treat it like ordinary concurrent
  edits; don't assume exclusive access.
- Each file is parsed and re-validated on every scan; a malformed file is
  reported on the board, in isolation, without breaking the other issues.
- Remove an issue by deleting its `.alice/issues/<id>.md` file (and commit). To
  pause a schedule without deleting it, set `status: done` or `status: canceled`.
- **Legacy:** the old single `.alice/issue.json` is retired. If you find one,
  split each issue into its own `.alice/issues/<id>.md` file with the
  frontmatter above.

Run a scheduled Issue immediately with `alice issue run --id <id>`; add `--await`
when its result is needed now. Retry its latest failed run with
`alice issue retry --id <id> --run-id <taskId>`. Both use the current What and
owner without moving the next scheduled occurrence.
