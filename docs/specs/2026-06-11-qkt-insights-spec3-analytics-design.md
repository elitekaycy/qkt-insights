# qkt-insights — Spec 3: performance analytics

Date: 2026-06-11
Status: approved, pre-implementation
Scope: the trading-performance layer — drawdown analysis, daily/calendar P&L, trade
statistics, streaks, and breakdowns. Adapted from an MT5 deal-history dashboard spec,
re-derived for qkt's event model. Two phases: phase 1 computes from data we already
store; phase 2 adds one qkt envelope (`trade.closed`) and upgrades approximate trade
stats to exact ones.

---

## 1. Data truths (what each metric is allowed to read)

qkt-insights is event-sourced, not deal-sourced. Three usable series exist per
(instance, strategy):

| Series | Table | Granularity | Trust |
|---|---|---|---|
| Equity snapshots | `equity_snapshots` | after every fill + 5s heartbeat | exact at each point; lossy between |
| Trades (fills) | `events` type `trade` | per fill | exact set of fills, **no P&L per fill** |
| Realized deltas | derived: `realized[i] − realized[i−1]` over snapshots | ≈ per close | merges closes that land between snapshots; the win-rate basis we already ship |

**Phase-1 rule:** money-shaped metrics derive from the snapshot series (exact curve),
count-shaped metrics from fills, and per-trade-P&L metrics from realized deltas,
labeled as approximate in the UI (a small `≈` next to the value, tooltip explaining
why). **Phase-2 rule:** once `trade.closed` lands, per-trade metrics switch to exact
and the `≈` disappears. Same components, same endpoints — only the store query
changes its source.

Not modeled, permanently out of scope here: swap (qkt doesn't track it),
deposits/withdrawals (account-level, not strategy-level), broker AccountInfo
equity. Commission exists as `venueCosts` on `order.filled` and is reported as
its own line, never silently folded.

---

## 2. Phase 1 — snapshot-derived analytics (no qkt changes)

### 2.1 Store: one new module, `packages/store/src/analytics.ts`

All functions take `(db, {instanceId, strategyId, from?, to?})` and read only the
three series above. Pure SQL + TS post-processing; no schema change.

```ts
interface DrawdownPeriod { peakTs: number; troughTs: number; recoveryTs: number | null;
  depth: number; depthPct: number; lengthDays: number; recoveryDays: number | null }

interface DayNet { day: string /* YYYY-MM-DD UTC */; net: number; trades: number }

interface PerformanceReport {
  // profitability (realized-delta based, phase-1 approximate)
  profitFactor: number | null;        // ∞ encoded as null+flag? NO — see §2.4: Infinity serialised as "inf"
  expectancy: number | null;
  avgWin: number | null; avgLoss: number | null; payoffRatio: number | null;
  kelly: number | null;
  grossProfit: number; grossLoss: number;
  largestWin: number | null; largestLoss: number | null;
  // risk (equity-curve based, exact)
  maxDrawdownPct: number | null; maxDrawdownAbs: number | null;
  drawdownDurationDays: number | null; recoveryFactor: number | null;
  sharpe: number | null; sortino: number | null; calmar: number | null;
  // counts & streaks
  wins: number; losses: number; winRate: number | null;
  maxWinStreak: number; maxLossStreak: number; currentStreak: number; // signed
  // days
  daysTraded: number; profitableDays: number;
  bestDay: number | null; worstDay: number | null; avgDayPnl: number | null;
  approximate: true;                  // phase-1 marker; false after phase 2
}

performanceReport(db, f): PerformanceReport
dailyNets(db, f): DayNet[]            // calendar grids, daily chart, monthly table
drawdownPeriods(db, f): DrawdownPeriod[]
postLossStats(db, f): { n: number; sample: number; nextWinRate: number; nextAvg: number }[]  // N=1..5, sample>0 only
openPositions(db, {instanceId, strategyId?}): { strategyId; symbol; legs }[]  // latest snapshot.position per (strategy, symbol)
```

Formulas (identical to the source spec where the data allows):

- **Daily returns** for Sharpe/Sortino/Calmar: last equity per UTC day;
  `r_i = eq_i/eq_{i−1} − 1`. Sharpe `(mean·252)/(std_{n−1}·√252)`; Sortino uses
  downside deviation `√(Σ min(0,r)² / N)` over all N (CFA convention); Calmar
  `annualisedReturn% / maxDD%`. All null under 5 daily points (existing honesty rule).
- **Drawdown periods**: walk the full snapshot curve (not daily buckets — we have the
  real curve); a period opens when equity < running peak and closes at recovery;
  open period has `recoveryTs: null`.
- **Realized-delta trade list**: ordered nonzero deltas of `realized` between
  consecutive snapshots — feeds PF, expectancy, avg win/loss, payoff, Kelly
  (`W − (1−W)/R`), streaks, and the post-loss table.
- **DayNet.net** = last realized of the day − last realized of the previous day
  (robust to intraday snapshot loss); `trades` = fill count that day.

### 2.2 API: two routes in `packages/api/src/rest.ts`

- `GET /performance?instance=&strategy=&from=&to=` → `{ report, dailyNets, drawdownPeriods, postLoss }` — one round trip for the whole analytics page.
- `GET /positions?instance=&strategy=` → openPositions.
- Existing `/stats` stays (Strategies cards use it); `/performance` is its deep sibling.

### 2.3 Web: where it renders (using the existing kit only)

No new visual language — `Panel` + `Stat` + `Pill` + `Delta` + `RangeSelect` +
`Sparkline` + `Table` + the `--color-up/down/warn` tokens and `rise` staggers.

1. **Strategy detail (`Strategies.tsx`) gains tabs**: Overview (today's content) ·
   **Performance** · **Calendar**. Driven by the existing `RangeSelect`.
   - *Performance tab*: three `Panel`s — Profitability (Stat grid: PF, expectancy,
     avg win/loss, payoff, Kelly, largest win/loss), Risk (max DD %/$, DD duration,
     recovery factor, Sharpe/Sortino/Calmar), Streaks (current streak with
     `warn` Pill at ≤ −3, max streaks, post-loss table as a small `Table`).
   - *Calendar tab*: month grid (7-col CSS grid, day cells tinted
     `color-mix(in srgb, var(--color-up) X%, transparent)` by |net| quantile, red
     mirror for losses — matches the token system), year switcher, and the
     monthly-returns `Table` (net, %, trades, YTD row).
2. **Equity page** gains a drawdown layer: underwater area chart under the existing
   comparison chart (same recharts idiom as `EquityChart`) + the drawdown-periods
   `Table`.
3. **Overview page** gains an **Open positions** `Panel` (symbol, side `SideTag`,
   qty, entry, age) and a Day P&L / Week P&L `Stat` pair with `Delta`.
4. Every approximate value renders with a trailing `≈` span (`text-faint`,
   `title=` explanation). One shared `<Approx/>` helper, deleted in phase 2.

### 2.4 Conventions (ported verbatim from the source spec)

- Division guards everywhere; no losses → Avg Loss/Payoff/Kelly render "—".
- Only wins → PF serialises as the JSON string `"inf"`; UI shows `∞`.
- `totalNet ≤ 0` → consistency-style values "—", never negative percentages of a loss.
- Win/loss defined on **net** realized deltas (commission already inside qkt's
  realized accounting; reported separately only as venueCosts totals).
- Unrecovered drawdown: `recoveryTs null`, duration measured peak→latest snapshot.

---

## 3. Phase 2 — `trade.closed` (one qkt PR, the exactness upgrade)

qkt already computes per-close realized P&L: `LiveSession.onTrade(trade, realized,
strategyId)`. Phase 2 publishes it:

- **qkt**: in the session's onTrade path, when the insights sink is wired and the
  TRADE family is enabled, offer a `trade.closed` envelope:
  `{ orderId, symbol, side, qty, price, realized, entryTs?, ts }`
  (`entryTs` from the closed leg when the engine knows it — enables hold-time).
  Same sink, same families, no new config.
- **contract**: add `"trade.closed"` payload `{ orderId, symbol, side: BUY|SELL,
  qty, price, realized, entryTs? }` (all z.number()/z.string(), entryTs optional).
- **store**: `trade_closes` table (instance, strategy, symbol, qty, price, realized,
  entry_ts, ts, id PK per instance) + fold into ingest. `analytics.ts` switches its
  trade list source to this table when it has rows, falling back to realized deltas
  for history that predates the upgrade; `approximate` flag reflects which source fed
  the report.
- **unlocked exactly**: P&L distribution histogram, symbol/hour/day-of-week/volume
  breakdowns **by net**, hold-time buckets, duration-vs-net scatter, exact largest
  win/loss and streak dollars. These charts ship in phase 2 only — no approximate
  versions, so nothing in the UI ever silently changes meaning.
- **compatibility**: collector deploys before the qkt release (same lockstep rule as
  the `log` type, spec 2 §7). Older qkt simply never sends it.

---

## 4. Explicitly skipped (and why)

| From the source spec | Why not |
|---|---|
| Swap | qkt doesn't model swap; showing 0 would be a lie |
| Account Balance/Equity, Account P&L vs initialBalance, BALANCE deals | account-level truth lives at the broker; qkt-insights is strategy-level. `balances.updated` already streams for the curious |
| Prop-firm monitor | real feature, different data (risk limits + headroom from the risk engine); needs its own `risk.snapshot` envelope — candidate Spec 4 |
| Magic-number breakdown | we have `strategyId`; strictly better |
| Composite "Axiom" score | deferred until phase 2 makes its inputs exact; a score on approximations invites false confidence |

---

## 5. Testing

- `analytics.ts`: numeric fixtures with hand-computed PF/expectancy/Kelly/Sortino/
  Calmar/drawdown-periods (same style as the existing `strategyStats` test); edge
  fixtures: only-wins (PF "inf"), no-losses, net ≤ 0, unrecovered DD, single day.
- API: `/performance` and `/positions` through real Fastify + real SQLite.
- Phase 2: contract round-trip, fold test, source-switch test (delta fallback vs
  trade_closes), and a qkt-side `LiveSessionInsightsTest` extension asserting a
  `trade.closed` envelope with the realized amount arrives over real HTTP.

## 6. Sequencing

1. `analytics.ts` + tests → 2. `/performance` + `/positions` → 3. Strategy-detail
tabs + Calendar → 4. Equity drawdown layer + Overview positions → 5. qkt
`trade.closed` PR → 6. `trade_closes` fold + source switch → 7. distribution/
breakdown/hold-time charts → 8. e2e against a real session.
