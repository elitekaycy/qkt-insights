# qkt-insights revamp: accurate, fast, adaptable, journal-style

Date: 2026-10-21. Status: proposal, nothing implemented.
Evidence (all measured, file:line inside):
`private review notes (UX, backend, accuracy, journal)`, 85 dashboard screenshots in `shots/`,
68 journal screenshots in `journal-shots/`, venue reconciliation scripts in `venue/`, benchmarks in `scripts/`.

## The goal, from the user's seat

A trader opening insights wants, in this order:

1. **Am I safe right now?** Balance, equity, today's P&L, open risk to the stops, distance to each loss limit.
2. **What is each strategy doing?** One sortable row per strategy: today, week, month, all-time, drawdown, status.
3. **Show me the trades.** Round trips, searchable like the backtester journal, each one traceable to its fills.
4. **Is the edge holding?** Calendar, monthly returns, edge by time and side, stability over time.
5. **Is the plumbing healthy?** Only when something is wrong.

Today insights answers 3 to 5 partly and gets 1 wrong in places (below). The plan fixes what is wrong first, removes
what nobody uses, makes every read cheap, makes insights stop breaking when qkt grows, then rebuilds the UI in the
journal's design.

## What the review found

### Accuracy (venue reconciliation on all three collectors, deal by deal)

Every per-trade number matches the venue to the cent inside each collector's window: trades, P&L incl. commission and
swap, side, times (true UTC, 0 ms off), volume, attribution, per-strategy stats, balance, equity, open positions,
duplicate per-profile deal copies. The failures are in derived and labelled figures:

| # | Problem | Effect today | Where |
|---|---|---|---|
| A1 | "Account DD" and risk-widget "Account drawdown" are balance minus equity (just floating loss) | a prop account showed ~1% of its loss limit used while its true static drawdown was **~72%** of it | AccountSummary.tsx:71, OverviewDashboard.tsx:144 |
| A2 | "All-time" deletes a strategy's deals 30 days after it stops reporting | all-time totals understate the venue by the deleted history | retention.ts:109-131 |
| A3 | Risk caps are summed per strategy, and every strategy carries the whole account's capital | 5 strategies on one account showed caps 5x too large | Overview.tsx:31-54,133-134 |
| A4 | Calendar/monthly Return % divides by summed allocations | returns 5x too small with 5 strategies on one account | Overview.tsx:124, Calendar.tsx:162,183 |
| A5 | Symbols keep the broker-profile prefix | one instrument split over up to 9 rows; one account drawn as two equity charts | write.ts:288, analytics.ts:614,856 |
| A6 | Unattributed deals vanish from totals | an orphan close left out of totals; a close dropped at ingest | write.ts:286,370-381 |
| A7 | Prop daily loss uses UTC day and realized only; the prop rule uses server day incl. floating | 14 historical closes land on another day | queries/Overview |
| A8 | Smaller: open P&L omits swap; trades net omits fees; Sharpe skips no-close days (absurd values on 6-trade sleeves); "-880.8% captured"; two win-rate definitions; "gross" means three things; "-0.00" | misleading labels | Strategies.tsx:40, Trades.tsx:75, analytics |

### Interop (live risk)

qkt since v0.55.0 emits six types the collector's contract does not know: `signal.suppressed` (on by default),
`state.persistence`, `signal.structure`, `bot.command`, `bot.modify`, `bot.cancel`. The collector validates a batch
with one schema, so one unknown envelope 400s the whole batch, and qkt's journal retries that head batch forever:
**the first suppressed signal freezes that bot's telemetry until insights is upgraded.** No bot is blocked today
(journals empty, 0 rejections in 24 h), but it has happened three times before (`bot.session.intent`,
`marketdata.recovered` blocking v0.54.0's replay, `snapshot.equity` removed and restored). Neither CI catches it.

### Speed and storage (quant-live snapshot, timings are medians)

- No HTTP compression anywhere. Equity page pulls **11.1 MB** (111,851 unsampled minute rows), polled every 60 s.
- `/performance` rebuilds the closed-trade list 14 times per call plus 655 one-per-trade queries (169 ms; 336-620 ms
  cold). Overview makes 17 calls, 555 KB. Public overview takes 1.7 s to show content.
- ECharts full build: 1 MB (335 KB gzip) for ~7 chart types.
- DB: 680 MB live, 217 MB after VACUUM (`auto_vacuum=NONE`, deletes never shrink it). hg20k is 3.1 GB and stalled
  ingest for ~7 minutes after today's restart. 79% of `equity_snapshots` rows repeat the previous one; deals stored
  2.5x; `ingest_observations` (22 MB) is write-only; `*_decimal` columns (16 MB) never read; 15,448 duplicate
  snapshots because `snapshot.equity` is not idempotent.

### UX

- No URLs: no deep links, Back leaves the app, reload lands on Overview.
- Overview is 4,017 px (8.5 phone screens), repeats itself, and nothing on it opens a strategy.
- No **today** figure anywhere.
- Trades page lists order legs (opening legs show 0.00), silently stops at 1,000 of 6,518 deals even on "All time",
  no sort, no export, and the trade drawer is unreachable on live data.
- Charts capture the mouse wheel; no reset-zoom. Times mix UTC and local without saying which. Hover-only
  explanations are invisible on touch. Sidebar cut off at 1440x900. Dark only.
- Bug: Overview.tsx:110 calls a hook after an early return (crashes when instances go from 0 to 1 on Overview).

What is good and stays: account tiles, open positions, the daily + cumulative P&L chart, long/short split, the metric
explanation popups, drawdown periods table, Health uptime strips, sample-size labels, no sideways scroll at 390 px.

### Why the backtester journal works (and what to copy)

One filter object drives every widget; every aggregate drills to its trades; the numbers always describe what is on
screen; the unit is the round trip and it says so; one formatting module (true minus, ▲/▼, tabular figures);
all times UTC and labelled; colour is never the only signal; old results stay on screen while new ones load;
keyboard-first search with a small query language (`side:long held:<1h r:>=1 entry:2024-10 pnl:>50 #12`), chips,
completions from the data, specific errors; every widget says what clicking it does. Design: hand-tuned dark (default)
and light themes, gains blue / losses red with fill and text shades, Inter + JetBrains Mono, 650 weight headlines,
4 px grid, radii 6/8/12, hairline borders no shadows, quiet chart axes with exact tooltips, zoom only past 24-60
points with a zoom bar that recomputes totals, Monday-first calendar with a week column.

## Principles for the new insights

1. **The venue is the truth; insights shows it, labelled.** Every money figure says its basis (realized / incl.
   floating / server day / UTC day) and reconciles to venue deals. A number that cannot be computed honestly is not shown.
2. **The round trip is the unit** for trades, win rate, expectancy. Legs and fills live inside the trade.
3. **One scope, everywhere:** instance › account › strategy › date range › query, held in the URL.
4. **Reads are O(1) or O(log n + k).** Aggregates are maintained on write; requests never rescan history.
5. **Never block on the unknown.** Unknown qkt events are stored raw and backfilled later; insights never stops qkt.
6. **Less, but complete.** Every panel answers a question a trader asks; diagnostics move to Health.

## Phase 0: stop the bleeding (small PRs, days)

| PR | Change | Done when |
|---|---|---|
| 0.1 | Tolerant `/ingest`: validate per envelope; unknown type / bad payload / unsupported major `v` → stored raw with `status=quarantined` + reason, acked 2xx, counted on Health. 400 only for auth, non-JSON, instance mismatch. Add the six missing types to the contract. | A batch with one unknown type stores the valid ones; test per case in the interop table |
| 0.2 | Never prune deals, closed trades, account equity rollups or risk events by staleness; retention only for logs/signals/decisions | all-time equals the venue since the first stored deal (older history needs a one-off venue backfill) |
| 0.3 | Drawdown/limits computed from an **account risk profile** (per account: limit basis static/trailing, start balance, daily reset hour + timezone, daily loss incl. floating or not, max DD). Prop accounts: static from the start balance, server day, incl. floating. Caps and return base from the account, never summed per strategy | static-basis account shows its true usage; shared-account caps and returns no longer multiplied |
| 0.4 | Instrument identity: store `venue`, `profile`, `instrument` separately; aggregate by instrument | NZDUSD one row; one equity chart per real account (login@server) |
| 0.5 | "Unattributed" bucket in every total and the trades list | totals include unattributed closes |
| 0.6 | Venue reconciliation job (from `venue/` scripts): nightly, read-only, compares deals/balance/positions per account; result on Health as "Reconciled ✓ as of 02:00 UTC" or a diff | runs green on all three collectors |
| 0.7 | Label/formula fixes from A8; fix the hook bug | the six A8 items gone |

## Phase 1: cleanup (one PR per area)

Remove, with their backend and tests (exact file:line lists in ux.md (b) and backend.md §5):

- Overview: **size-normalized performance, execution quality, review focus, system health, Instances section**, the
  "Dashboard" heading, trade-outcome donut (one number), duplicate strategy-equity chart, Overview's 15 s
  `/health/instances` poll. Backend: `normalizedPerformance`, `executionQuality`, `percentile`
  (analytics.ts:859-1040), their bundle keys and public allow-list entries.
- Edge: strategy comparison radar (min-max over 4 strategies misleads).
- Equity: strategy legend pills (duplicate legend).
- Unused endpoints `/orders`, `/ingest/observations`; store fns `listPortfolioEquity`, `listRiskEvents`,
  `listCurrentPositions` (tests only); table `ingest_observations`; `*_decimal` columns; `idx_deals_position`,
  `idx_position_valuations_lookup`; fold branches and `portfolio_exposure` for six types qkt never emits
  (`snapshot.position`, `position.*`, `portfolio.exposure.updated`); the stale "qkt retired snapshot.equity" comments.
- Move Viewership out of the main nav into Settings › Sharing.

Expected: each strategy's Overview request ~75 ms faster and ~25% smaller; Overview height roughly halves.

## Phase 2: data layer that stays fast as history grows

Raw events plus projections maintained on write. Every read becomes a point lookup or one index range scan.

| Structure | Key / index | Maintained | Serves | Read cost |
|---|---|---|---|---|
| `raw_events` (append-only, JSONB) | PK (instance, id) | on ingest; the single idempotency point (fixes snapshot dupes) | replay, search, audit | O(log n) |
| `projections(name, version, cursor)` | name | reducer bump ⇒ replay from raw | rebuilds, backfill of once-unknown types | - |
| `deals` once per venue deal | UNIQUE (account, ticket) + `deal_sightings` | upsert, fill NULL attribution only | trades, reconciliation | O(log n + k) |
| `closed_trades` (round trips) | (instance, strategy, close_ts), UNIQUE close ticket | recompute one position's rows per deal: O(legs) | trades list, every trade stat | O(log n + k) |
| `strategy_daily` | (instance, strategy, day) | same transaction as closed_trades | calendar, monthly, Sharpe, costs, rolling stats | O(days) |
| `position_excursions` | (account, ticket) | O(1) per valuation | MAE/MFE (655 queries → 1) | O(log n) |
| `account_equity` multi-resolution: 1 m for 14 d, 15 m for 180 d, 1 h after; plus a daily close row | (account, resolution, ts) | rollup once a minute; dedupe unchanged points | equity chart at any zoom ≤ 2,000 points | O(log n + 2000) |
| `account_drawdown_state` | account | O(1) per minute flush | DD tiles, limit gauges | O(1) |
| `live_state` (balance, equity, positions, today P&L) | account | in memory + persisted on change | home strip | O(1) |
| FTS5 on events/logs | rowid desc LIMIT | on insert | search with early stop | O(log n + k) |

Plus: request-scoped memo now (169 ms → ~15 ms before the projections land); gzip/brotli on JSON and static files;
ETag/`If-None-Match` on aggregates keyed by projection cursor (unchanged data = 304, no body); server-side
downsampling (LTTB for display series); cursor (keyset) pagination, never OFFSET; prepared statements cached per
DB; `auto_vacuum=INCREMENTAL` with a nightly `incremental_vacuum`; WAL checkpoint after bulk writes; boot does no
prune/scan work before serving (the hg20k 7-minute stall). Measure hg20k's 3.1 GB split (real vs bloat) before
the migration and plan a one-off VACUUM INTO + swap in a maintenance window, after making FTS and monitor cursors
rowid-independent.

Budgets (CI-enforced with a seeded 1-year DB): any API p95 < 50 ms warm, any response < 200 KB compressed, first
content < 1 s on the public overview, JS initial < 250 KB gzip.

## Phase 3: adaptability to a growing qkt

1. **Versioned contract as an artifact.** JSON Schema generated from `packages/contract`, published per insights
   release (`contractVersion`, per type `since`/`deprecated`). Minor = new type or optional field; major = rename,
   removal, meaning change ⇒ new envelope `v`. The collector supports a set of majors and quarantines others.
2. **Contract tests in both CIs.** qkt: one golden envelope per emitted type validated against the pinned contract,
   plus a coverage test that every `type = "..."` literal qkt emits exists in it (fails today on the six types).
   insights: replay qkt's golden envelopes (published as a qkt release asset) through `/ingest` into a real SQLite
   and assert the projections.
3. **`GET /ingest/capabilities`** `{contractVersion, majors, types, maxBatch}` replaces hand-kept opt-in families;
   qkt holds or drops (counted) what the collector does not list. With 0.1 in place this is an optimisation.
4. **qkt-side changes** (separate qkt PRs, through the normal dev → testing → main path): read the per-envelope ack;
   split a 4xx batch and park poison envelopes instead of retrying the head forever; deal id
   `deal-<login@server>-<ticket>`; real per-producer `seq`; persist the deal watermark (no 30-day resend on every
   restart); `snapshot.equity` on change + heartbeat; explicit `startingBalance` on `strategy.started`;
   attribution resolved in qkt (`TicketAttribution.kt`) so insights trusts `strategyId`.
5. **Unknown is visible, not fatal.** Health shows quarantined counts by type and version; when a reducer for a
   type ships, its projection backfills from `raw_events`.

## Phase 4: the UI in the journal's design

### Design system (copied, not shared, like labs #62)

Port tokens from qkt-backtester `theme.css:5-79`: dark (default) and light hand-tuned; gains blue `#4b8fe6`/`#2a78d6`,
losses red, fill + text shades; ▲/▼ + true minus on every signed number; Inter + JetBrains Mono, tabular figures,
11-28 px scale, 650 headline weight; 4 px grid; radii 6/8/12; hairline borders, no shadows; the backtester's
`format.ts` for every number; its ECharts base config (quiet axes, exact tooltips, crosshair) and zoom bar. Extract a
shared package later only if a third consumer needs it; copying keeps insights free of backtester release coupling.

### Navigation and scope

Left rail (icons + labels, collapsible): **Home · Strategies · Trades · Calendar · Equity & risk · Edge · Logs ·
Health**, Settings at the bottom. A scope bar under the title: account › strategy › date range (Today, 7D, MTD,
YTD, All, custom) + the search/query box + "Showing k of n trades". Everything in the URL
(`/s/gold_rsi_fade_v2/trades?q=side:short+pnl:<0&from=2026-10-01`), so links, Back and reload work. Phone: bottom
tab bar with 5 entries, scope bar collapses to a chip row.

### Pages

- **Home (replaces Overview).** Account strip: balance, equity, **today** (realized + floating, on the account's
  day basis), open risk to stops in money, gauges for daily loss and max DD against the account's own limits with
  the basis printed ("static from start balance, server day, incl. floating"). Open positions with SL, TP, distance to stop
  in money, held time, strategy. Strategy table, sortable: status/halt badge, today, 7D, MTD, all-time, DD, trades,
  win rate, last trade; click opens the strategy. Cumulative + daily P&L chart. Compact calendar month. Nothing else.
- **Strategy (journal layout).** Header with net, return on the strategy's real base, status, runtime info.
  Sections: Overview (KPI cards like the journal: realised P&L with net incl. open, win rate ring, profit factor
  gauge, payoff bars, expectancy in money and R when a stop exists), Calendar, Daily, Monthly, Trades, Time & risk
  (hold-time buckets, ended-by, side, weekday/hour with n and significance shading), Logs. Halts and their reason
  shown at the top, not only in Logs.
- **Trades.** Round trips, server-paged virtual table (keyset cursor), sortable, columns: #, strategy, instrument,
  side, entry (UTC), entry price, exit (UTC), exit price, size, risk, P&L, R, held, ended by. Query language from
  the journal generalised over field names (`strategy:`, `symbol:`, `side:`, `held:`, `pnl:`, `r:`, `entry:`,
  `exit:`, `ended:stop|tp|signal|venue|manual`, `#ticket`), chips, completion from the data, specific errors.
  Row opens a drawer: timeline (signal → order → fills → SL/TP changes → close, with latencies and slippage in
  price and money), price chart around the trade with entry/exit/SL/TP, MAE/MFE path, the raw events (copyable).
  CSV export of the current query.
- **Calendar.** Journal calendar per account or strategy: Monday-first, week column, tint by size of day with legend,
  today as an "in progress" cell, click a day to filter trades; month/year switch; return % on the right base.
- **Equity & risk.** One stitched account equity chart (by login@server) with underwater below, deposit/withdrawal
  markers, drawdown periods table; strategy comparison (% change) with retired strategies toggle.
- **Edge.** Weekday, hour, session, side, hold time with n and SE, greyed under n=30; rolling win rate / expectancy
  windows; no radar.
- **Logs, Health.** Health absorbs Instances and System health: uptime strips, incidents, runtime table, ingest
  (quarantined types), reconciliation status. Settings: sharing links + viewership.

### Interaction details

- Charts take the wheel only when focused (click) or with Ctrl/⌘; drag to pan; zoom bar shows and recomputes totals
  for the visible window; double-click or a button resets; tooltips show exact values, axes compact.
- Every widget has a one-line hint of what clicking does; every aggregate drills to the trades behind it.
- Explanations open on tap/click (popover), not hover-only.
- All times UTC by default with a visible "UTC" label and a toggle to local; the account's server day shown where
  limits use it.
- Live: WebSocket deltas update rows in place (no reflow, no flicker); every panel shows "as of"; stale data greys
  with a badge; previous results stay until new ones arrive.
- Keyboard: `/` search, `g h/s/t/c/e` go to page, `j/k` rows, `Enter` open, `Esc` close, `?` help.
- Empty states say why ("No closed trades in this range: widen to 30D").
- Accessibility: colour never the only signal, focus rings, 44 px touch targets, contrast checked in both themes.

### Frontend performance

Route-level code splitting; ECharts modular imports (`echarts/core` + the 7 used charts) for ~1/3 of today's
chart bundle; TanStack Query cache keyed by scope with ETag revalidation; virtualised long lists; skeletons sized
like the final layout; public pages served from a 15-minute cached snapshot (they are delayed anyway).

## Order of work

1. Phase 0.1 (interop safety) immediately, then 0.2-0.7. Each PR adds a reconciliation or regression test.
2. Phase 1 cleanup in parallel with 0.x where files do not overlap.
3. Phase 2 behind the existing API (same responses, faster), verified by response-equality tests old vs new on the
   three production snapshots before switching.
4. Phase 3: insights side with Phase 2 (raw_events), qkt side as normal qkt PRs.
5. Phase 4 page by page on the new API, behind a `?ui=next` flag until Home, Strategy and Trades are done; then make
   it the default and delete the old pages.

Each phase ships dev → main with a ghcr image and is rolled to the three collectors one at a time (restart only the
insights container), checking ingest, journals and the reconciliation job after each.

## Decisions for the user

1. Default theme: dark (journal default) with light available? Gains **blue** like the journal, or keep green?
2. The exact limit rules per account to encode in 0.3.
3. Keep public sharing as is (15-minute delay) in the new UI?
4. Viewership: keep under Settings, or remove?
5. Backfill: allow a read-only pull of full venue deal history once per account to restore true all-time (A2)?
