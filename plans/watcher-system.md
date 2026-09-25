# Watcher System

**Status:** In progress
**Owner guides:** [[docs/workspace-issues-and-scheduling.md]], [[docs/connector-service.md]]
**Related:** [[docs/market-data-architecture.md]], [[docs/conversation-provenance.md]]

## Scope

Add a deterministic market-condition **watcher** to an Issue. The model writes a
plan plus a machine-checkable condition at creation time. A separate 30-second
loop evaluates that condition against live market data and, when it first becomes
true, wakes the exact owning Session with the plan. The woken model re-analyzes,
reports to the user on Telegram, and re-arms for the next phase by rewriting its
own Issue.

Ported from the Vibe-Trading watcher subsystem (`agent/src/watcher/`), which
proved this shape in production: deterministic rules, no LLM in the hot loop,
phase-by-phase re-arm, and create-time dedup.

## Decisions (locked)

| # | Decision |
|---|---|
| 1 | Polling is **30s, always** — price rules and candle rules alike. |
| 2 | Minimum candle timeframe is **1m**. There is no 30s candle (unreliable). Candle rules evaluate confirmed candles; the noticing poll is still 30s. |
| 3 | Wake is **always auto**. No on-demand mode. Fire implies immediate model wake. |
| 4 | State is **persisted** (JSON sidecar beside the Issue). |
| 5 | Lifecycle is Vibe-Trading parity: the watcher does not die on fire; the model re-arms. |
| 6 | Alerts go to **Discord only**. Telegram carries the model's write-up, not alert spam. |
| 7 | **No Telegram button.** Dropped. |
| 8 | Management watchers bake entry/direction/stop/targets into the watcher at creation; rules compare stored context to live price. **No cross-process position query.** Works with UTA offline. |
| 9 | Authoring is via the `alice issue` CLI verbs plus the self-scheduling skill. **No new MCP tool.** |
| 10 | Multiple rules evaluate **independently** (each with its own `condition_key`); any rule may fire. Not AND. |
| 11 | Cooldown default **900s**. |

## Architecture

```
Issue file (.alice/issues/<id>.md)
  frontmatter: watch { pair, asset_class, timeframe, rules[], invalidation_rules[], expiry, plan }
  body: What = the plan + reanalysis instruction
        |
        | live read each tick
        v
WatchLoop (30s, separate from ScheduleScanner)
  -> MarketSnapshot (price + confirmed candles)
  -> RuleEvaluator (pure, deterministic)
       -> no events  -> persist state, done
       -> event      -> cooldown/dedup guard -> FIRE
        |
        v
  dispatchIssue(issue, wakePrompt = plan + trigger event)
        |
        +--> Discord alert (machine notification)
        +--> owning Session resumes -> re-analyzes -> Telegram write-up
                                       -> rewrites Issue to re-arm
```

## Build checklist

### Increment 1 — pure core (no wiring)
- [x] `src/workspaces/watch/types.ts` — WatchSpec, WatchRule, MarketSnapshot, WatchEvent, WatchState
- [x] `src/workspaces/watch/evaluator.ts` — deterministic rule evaluation + condition keys + cooldown
- [x] `src/workspaces/watch/evaluator.spec.ts` — unit specs for every rule type + anti-spam (45 tests)

### Increment 2 — schema + persistence
- [x] `watch:` frontmatter member in `src/workspaces/issues/declaration.ts` with validation
- [x] `src/workspaces/watch/schema.ts` — zod grammar shared by declaration + mutate
- [x] `src/workspaces/watch/store.ts` — JSON sidecar read/write, atomic, path-guarded
- [x] `src/workspaces/watch/store.spec.ts`
- [x] `mutate.ts` accepts `watch` on create + patch (null removes)

### Increment 3 — market data + loop
- [x] Inject a bar/price source into `CreateWorkspaceServiceOptions` (today `barService` lives only in `EngineContext`)
- [x] `src/workspaces/watch/snapshot.ts` — bar-layer adapter (marks the forming tail unconfirmed)
- [x] `src/workspaces/watch/loop.ts` — 30s watch-only loop with per-tick quote cache + per-fetch timeout
- [x] `src/workspaces/watch/loop.spec.ts`

### Increment 4 — fire path
- [x] Fire gate calls `dispatchIssue` with the trigger event injected into the wake prompt
- [x] Discord-only alert routing (`deliverTo: ['discord']` through Inbox to Connector)
- [x] `HeadlessTaskTrigger` gains a `watch` metadata profile
- [x] `SessionIssueFire` gains `'watch'` for Session birth provenance
- [x] Integration spec: armed watcher -> condition true -> one dispatch, not N

### Increment 5 — authoring + docs
- [x] `alice issue create/update --watch` (auto-derived from the tool schema; JSON object flags)
- [x] `default/skills/self-scheduling/SKILL.md` teaches the grammar and the plan-then-re-arm discipline
- [x] Update [[docs/workspace-issues-and-scheduling.md]]

### Increment 6 — frontend
- [x] Watch status section in `ui/src/components/IssueDetail.tsx`
- [x] Watcher status readout (armed, last checked, last price, fired conditions, recent events)
- [x] Board watch summary; i18n keys in all four locales
- [x] `ui/src/demo/` handlers for the new `watch` shape

## Discoveries during implementation

- `CreateWorkspaceServiceOptions` had **no** market-data access. `barService`
  lives only in `EngineContext` for tools, so the scanner could not see prices at
  all. Resolved by threading `barService` through `WebConfig` →
  `createWorkspaceService`. The loop does not start when it is absent, so
  `watch:` blocks stay inert rather than half-working.
- `HeadlessTaskTriggerMetadata` was a plain object type, so adding a second
  profile required converting it to a discriminated union. `service.ts` read
  `metadata.connectorId` without narrowing and only failed once the union
  existed — a latent bug the change surfaced.
- `issueFrontmatterObjectSchema` forbade `@new-then-resume` on an Issue with no
  `when`. A watch-only Issue needs exactly that policy, so the rule was relaxed
  to "needs a schedule **or** a watch".
- The Issue plan is the markdown **What**, per the existing no-second-prompt
  rule. An early `watch.plan` field was removed rather than duplicating it.
- Weekly candle timeframes were unparseable in all three timeframe parsers,
  while the bar layer serves `1w`. Fixed, and the schema now also rejects any
  timeframe the bar layer cannot serve (for example `2h`), so an unfireable
  watcher cannot be authored.
- `flattenBoardRows` (the agent-facing `alice issue list` projection) dropped
  `watch`, so the model could not see its own watcher on the CLI board. Fixed.

## Post-ship field findings

Two live defects found by running a real watcher (`eurusd-short-setup-watch`):

1. **The board never rendered the watcher.** Backend data and the detail panel
   were correct, but `IssuesBoard.tsx` had no badge, and `flattenBoardRows`
   dropped the field. Both fixed; a `MarketWatchPill` now shows the pair.
2. **A model hand-wrote `connectorDesk: telegram` onto an ordinary watch Issue.**
   That field marks the single phone-desk Issue: the board hides any Issue
   carrying it, and it invalidated the real `telegram-phone-desk` file. The
   field was removed from the live file, and the self-scheduling skill now
   states explicitly that a watcher never needs it.
3. **The 8s fetch ceiling was too aggressive** for delayed vendor feeds
   (yfinance forex), producing `watch snapshot timed out after 8000ms` and a
   watcher that rarely evaluated. Raised to 20s (the loop's re-entrancy guard
   means a slow fetch delays the next pass rather than stacking one).
4. **A failing feed retried forever with no backoff.** `errorCount` climbed and
   the provider was re-fetched every tick. Added a persisted `backoffUntil`:
   the first two failures retry immediately, then the delay doubles per
   consecutive failure from 60s up to 30min. The deadline lives in the sidecar,
   so **a restart cannot reset it into a retry storm**. The first successful
   fetch clears the streak and the backoff.

## Verification

| Change | Required evidence |
|---|---|
| Increment 1 | evaluator specs green; root `npx tsc --noEmit` |
| Increment 2 | store + declaration specs; root typecheck |
| Increment 3 | loop specs with injected fake provider; root typecheck |
| Increment 4 | integration spec (single dispatch per fire); `pnpm test:changed` |
| Increment 5 | CLI spec; skill format matches schema |
| Increment 6 | `cd ui && npx tsc -b`; `pnpm test:owner:ui`; real browser route |

## Completion criteria

- A model can create a watcher through the CLI and skill alone.
- A true condition wakes the owning Session exactly once and notifies Discord.
- No agent run occurs while the condition is false.
- State survives restart without a duplicate fire.
- `pnpm test` passes; owner guides updated in the same change.
