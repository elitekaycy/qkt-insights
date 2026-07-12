# Granular trader analytics — edge, time, and attribution

Date: 2026-07-12
Status: Phase A implemented (feat-edge-analytics); Phase B/C proposed
Driving ask: "as a trader I have analytical questions — which weekdays/hours
are profitable, where do wins come from, does time-of-day contribute to edge —
answered visually, accurately, quant-institutional."

## Verdict up front

qkt-insights already stores everything needed for ~80% of the institutional
analytics catalog. The `deals` table carries symbol, side, qty, price, profit,
commission, swap, magic/strategy, and epoch-ms timestamps; IN/OUT pairing
(`dealClosedTrades`) yields entry time, exit time, and hold duration per
position. One-dimensional byHour/byDow/holdTime/distribution breakdowns exist
in `analytics.ts` and render today as grouped bars. What is missing is
two-dimensional time analysis (day×hour matrix), statistical honesty (n per
bucket, confidence), session/timezone framing, excursion metrics (MAE/MFE),
gross-vs-net cost decomposition, and comparison visuals (radar, monthly
heatmap, rolling-window lines). All but two items are derivable from stored
data; only R-multiples and guaranteed MAE/MFE need new data from qkt.

## The catalog — question → view → status

Statuses: HAVE (rendered today) · DERIVE (data stored, view missing) ·
PARTIAL (reconstructable with caveats) · NEEDS-DATA (qkt/gateway change).

| # | Trader question | Institutional view | Status |
|---|---|---|---|
| 1 | Am I making money; how does the ride feel? | Equity curve + underwater plot sharing an x-axis | HAVE (separate panels; unify axis) |
| 2 | Is the edge stable or decaying? | Rolling Sharpe / win-rate / vol lines (window in title) | DERIVE from dailyNets/equity |
| 3 | Which months/days were good? | Monthly-returns heatmap (year×month) + daily PnL calendar | PARTIAL — calendar HAVE, monthly heatmap DERIVE |
| 4 | Which weekdays are profitable? | Weekday bars: net PnL + win-rate overlay, n labeled, SE whiskers, grey-out n<30 | PARTIAL — bars HAVE, n/confidence missing |
| 5 | Peak hours? Does time-of-day carry the edge? | Day-of-week × hour heatmap (7×24, diverging palette, min-n mask) | DERIVE — needs `dowHourMatrix` aggregation |
| 6 | Where do wins come from? | Ranked contribution bars by symbol/strategy/direction + expectancy table (PORT-style attribution) | PARTIAL — bySymbol/side bars HAVE; ranked contribution + gross/net split DERIVE |
| 7 | What does my PnL distribution look like? | Histogram + per-category box plots (box, not violin, under n<30) | PARTIAL — histogram HAVE; box plots DERIVE |
| 8 | Am I leaving money on the table? | MAE/MFE scatter, exit efficiency | PARTIAL — reconstruct from `position_valuations` per ticket; coverage = valuation cadence; else NEEDS-DATA |
| 9 | Does duration correlate with outcome? | Duration-vs-PnL scatter (HAVE) + win/loss-split duration histogram (DERIVE) | PARTIAL |
| 10 | Compare strategies at a glance | Radar: one outline polygon per strategy over 5-6 normalized axes (win rate, PF, Sharpe, DD⁻¹, expectancy, consistency) | DERIVE from per-strategy reports |
| 11 | Worst stretches? | Drawdown-periods table + shaded spans on the equity curve | PARTIAL — table HAVE; span shading DERIVE |
| 12 | True cost of trading? | Gross profit vs commission vs swap decomposition (stacked bars per month/strategy) | DERIVE — columns stored separately, `realized` currently merges them |
| — | Risk-normalized (R-multiple) analytics | R-based distribution/expectancy | DERIVE (revised) — SL/TP as set at submit time already arrives in `order.submit` envelopes; see "Data flow" below |

## The institutional differentiator: statistical honesty

Weekday/hour slices are the analytics most vulnerable to small-n false
positives (calendar-anomaly literature: most vanish under proper testing;
slicing one account five ways then picking the best slice is a
multiple-comparisons trap). Design rule, first-class not tooltip:

- Every bucketed view prints **n** on the mark.
- Buckets with n < 30 render desaturated/grey — visibly "not enough data".
- Mean bars carry ±SE whiskers (bootstrap CI later if wanted).
- Heatmap cells below min-n are masked, never interpolated.
- Time basis is labeled on every time-bucketed chart ("UTC" today; "server
  time"/session labels when added). Hour analysis without a declared timezone
  is wrong by construction — MT5 server time vs UTC vs local differ by 2-3h.

## Data flow audit — events we already receive but never use

A survey of the ingest path (contract union → `collector/src/index.ts` →
`store/src/write.ts`) found that several "NEEDS-DATA" items are actually
already flowing — stored but unread, or parsed but dropped before disk.

### Stored and fully unread (prime unlocks)

- **`position_valuations` is a live MAE/MFE table with zero readers.**
  Every `state.positions` poll (~10s) inserts one row per open ticket —
  `profit`, `swap`, `current_price`, keyed `(instance_id, broker, ticket,
  ts)` (migration 010, writers at `write.ts:119-153` and `:437-445`). No
  reference exists in `queries.ts`, `analytics.ts`, or `apps/`. Max adverse /
  favorable excursion per closed trade = min/max of this series joined to
  `deals.position_ticket`. Phase B collapses into "write the query":
  `excursionStats` needs no new ingestion. Caveat: 10s cadence bounds
  fidelity (intrabar spikes between polls are invisible) — label it.
- **`order.submit` already carries the risk envelope** — `stopLoss`,
  `takeProfit`, `stopLossAst`/`takeProfitAst`, `trailAmount/Mode/Distance`,
  `mfeThreshold`, `entryPrice`, brackets/layers — but `orders` columnizes
  only state/qty/cum_qty/avg_price/side/type; the rest lives in the
  `events.payload` JSON blob, unqueried. Extracting SL at submit into
  columns (migration + fold in `write.ts`) makes **R-multiples DERIVE, not
  NEEDS-DATA**: R = realized / (|entry − stopLoss| × qty × contract value).
  Caveat: submit-time SL, not venue-modified SL — label "R at entry risk";
  trailed/modified stops need `order.modified.changes` replay (also in the
  blob) for exactness.
- **`risk_snapshots` and `position_reconciliations`**: populated, no
  readers. Risk-state history and reconciliation drift are free
  "ops-quality" panels.
- **`strategy.started.risk`** config sits whole in `strategies.metadata`
  JSON — per-strategy configured risk limits could annotate analytics
  (e.g. DD panels showing the configured cap) without new events.

### Received but dropped before disk

- **Margin history**: `state.account.margin/marginFree/marginLevel` parse
  and live only in the in-memory `LiveStateStore`; the per-minute
  `account_equity` rollup keeps balance/equity/openProfit only. Margin-level
  over time (leverage usage, distance-to-stop-out — a genuinely
  institutional risk view) needs three columns added to the rollup.
- **`snapshot.position`** envelopes are dropped entirely (`write.ts:276`)
  — redundant with `state.positions` on live; fine to leave.
- **Blob-only, no structured reader**: `signal*`, `balances.updated`,
  `broker.*`/`marketdata.*` connectivity, `gateway.unreachable`,
  `strategy.stopped`, fill `venueCosts`. Connectivity events could power an
  uptime/outage strip on Health; signal-vs-fill comparison could measure
  slippage-at-signal later.

### Flow summary

qkt emits → collector splits `state.*` (in-memory + rollup + valuations)
from the rest (`ingestEvents`: events blob + typed projections). Durable
read tables today: deals, orders, trade_closes, equity_snapshots,
account_equity, positions_current, risk_events, portfolio_equity, logs,
strategies. Write-only: position_valuations, risk_snapshots,
position_reconciliations, portfolio_allocations, portfolio_exposure.

### Dropped at qkt's translation layer (gateway already parses it)

The engine-side survey confirmed every gap below is a translation omission
in qkt, not missing gateway data — the MT5 client parses all of it:

- **Venue-side position SL/TP.** Gateway sends `sl`/`tp`
  (`MT5Client.kt:712-713`); `MT5Broker` carries them on
  `BrokerPositionTicket` as stopLoss/takeProfit + requestedStopLoss/TP —
  but `InsightsTranslate.statePositions` omits all four. Adding them to the
  `state.positions` envelope gives *venue-truth* stop distance per open
  position (better than submit-time SL for R-multiples, and it tracks
  trailing modifications). Zero gateway work.
- **Deal `fee`.** Parsed (`MT5Client.kt:477`) but `BrokerDeal` has no fee
  field, so `broker.deal` reports commission+swap only — realized-cost
  analytics are understated on fee-charging brokers. One field through the
  chain.
- **Position magic/comment and full `clientOrderId`** (untruncated
  placement id) parsed but dropped — would harden deal↔order linking.
- **Pending orders never egress at all.** `getPendingOrders` returns SL/TP,
  expiration, open price, magic — no `state.orders` envelope exists. Needed
  for resting-order/expiry views; new envelope type.
- **Dead gating bug found in passing:** the `DEAL` insights family exists in
  `InsightsConfig` but nothing gates on it — `broker.deal` emission actually
  rides the `STATE` family (poller start). A config enabling `deal` without
  `state` silently emits no deals. (SNAPSHOT is retired by design; DEAL is
  an orphan.) Worth a qkt issue.

### Revised R-multiple path

Two complementary sources, neither needing gateway changes: submit-time
SL from `order.submit` (already stored in the events blob — columnize) and
venue-truth SL from `state.positions` once qkt adds the fields (tracks
trails/modifications). Start with submit-time (insights-only change); add
venue-truth when the qkt egress PR ships.

## UI/UX direction — from good bones to quant-shop

The current shell is already right: dark, dense, JetBrains Mono numerals,
lime accent, red/green reserved for direction. Bloomberg-informed tightening:

- **Tables are first-class.** Attribution, drawdown periods, per-bucket stats
  ship as dense sortable tables beside their chart, not tooltips.
- **Diverging palette with neutral dark midpoint** for all PnL heatmaps;
  hue never the only encoding (print values in cells).
- **Every stat tile: value + change + n.**
- New ECharts types needed (greenfield in `EChart.tsx` conventions):
  `heatmap` + `visualMap`, `boxplot`, `radar`. All supported by the vendored
  build — verify `echarts.min.js` includes them; else swap the vendor bundle.
- Radar rules: outline-only strokes (filled areas distort — area grows with
  the square), max ~4 polygons, normalization labeled.
- **New "Edge" page** (nav group Performance) for time-of-edge analytics:
  DoW×hour heatmap (hero), weekday/hour bars with confidence, session
  overlays later. Strategy-detail keeps per-strategy panels; Edge answers
  account-level "when am I good".

## Implementation shape (matches existing patterns)

- Aggregations: new functions beside `tradeBreakdowns` in
  `packages/store/src/analytics.ts` — `dowHourMatrix`, `rollingStats`,
  `costDecomposition`, `contributionRanking`, `excursionStats`
  (valuation-joined, coverage-flagged), `strategyRadar`.
- API: new `include=` keys on `/performance` (existing pattern in
  `packages/api/src/rest.ts`).
- Client: interfaces in `apps/web/src/api.ts`; panels in
  `components/Performance.tsx`; Edge page in `pages/` + `App.tsx` nav.
- Contract-alignment rule applies (see `.claude/skills/qkt-insights`).

## Phasing

- **Phase A — no new data, highest value:** DoW×hour heatmap + min-n masking;
  weekday/hour bars upgraded with n/SE/grey-out; monthly-returns heatmap;
  rolling Sharpe/win-rate; cost decomposition (profit vs commission vs swap —
  pairs with qkt's swap-financing work); ranked contribution; strategy radar;
  drawdown span shading; box plots per category.
- **Phase B — unread-data unlocks (insights-only, no qkt changes):**
  MAE/MFE + exit efficiency from `position_valuations` (already accruing at
  ~10s cadence — just write `excursionStats`; coverage-flagged like the
  `approximate` precedent); R-multiples from submit-time SL (columnize the
  `order.submit` risk fields out of the events blob, migration + fold);
  margin-level history (add margin/marginFree/marginLevel to the
  `account_equity` rollup); risk-snapshot and reconciliation panels from
  their write-only tables.
- **Phase C — qkt egress additions (no gateway work — all parsed already):**
  venue-truth position SL/TP on `state.positions` (exact R even after
  trailing), deal `fee` on `broker.deal`, position magic/clientOrderId for
  linking, a new `state.orders` envelope for pending orders; fix the dead
  `DEAL` family gating while in there. Session tagging (London/NY/Tokyo)
  with a declared timezone model. Tick-fidelity MAE/MFE only if the 10s
  valuation cadence proves too coarse.

## Sources

Bloomberg PORT attribution + terminal design language (amber-on-black,
density, color accessibility); QuantStats/pyfolio tearsheet conventions
(monthly heatmap, underwater, rolling stats, drawdown periods); trade-journal
practice (Tradervue/TradeZella/TraderSync: PnL calendar, hour/day slicing,
MAE/MFE, exit efficiency); chart-choice literature (bars over radar for
comparisons; box over violin under n<30; calendar-heatmap guidance);
calendar-anomaly small-n literature. Codebase ground truth:
`packages/store/src/migrations/*.sql`, `packages/store/src/analytics.ts`,
`apps/web/src/components/Performance.tsx`.
