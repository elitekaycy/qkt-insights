# Granular trader analytics — Phase A implementation plan

Executor notes: update checkboxes as work lands. Each task ends in a commit.
Phase A uses ONLY data already aggregatable from existing tables — no
migrations, no qkt changes (those are Phase B/C; qkt egress gaps tracked as
qkt#780-#783).

**Goal:** ship the time-of-edge and attribution analytics a trader actually
asks for — day×hour heatmap, statistically honest weekday/hour bars, monthly
returns heatmap, rolling edge stability, cost decomposition, ranked
contribution, strategy radar, drawdown span shading — institutional in both
accuracy framing and visual language.

**Spec:** `docs/specs/2026-07-12-granular-trader-analytics-design.md`

**Core contract:** every bucketed view carries n; buckets with n < 30 render
greyed; every time-bucketed chart labels its time basis ("UTC"); hue is never
the only encoding. Statistical honesty is a feature, not a caveat.

**Global constraints**

- Contract-alignment rule: contract → collector/store/api/web updated
  together (see `.claude/skills/qkt-insights`).
- Tests: vitest, real SQLite; every new aggregation gets fixture-backed
  tests with hand-computed expected values (no snapshot-only tests).
- Verify build via mise Node 22 PATH prefix; `pnpm build:all && pnpm test`.
- ECharts additions follow `EChart.tsx` conventions (`ECHART_GRID`, dark
  theme, JetBrains Mono axis fonts, existing color tokens).
- No new pages/panels without loading/error isolation (`Skeleton`/`Loadable`
  per panel, per the live-truth precedent).

## Task 1: `dowHourMatrix` aggregation

- [ ] `packages/store/src/analytics.ts`: `dowHourMatrix(db, f)` → 7×24
      cells `{dow, hour, n, net, mean, winRate}` from `dealClosedTrades`
      (UTC bucketing on close ts, consistent with `tradeBreakdowns`), plus
      `trade_closes` fallback for paper instances (same source-selection
      logic as existing report).
- [ ] Empty cells omitted (client masks); no interpolation anywhere.
- [ ] Tests: fixture with trades pinned to known UTC dow/hour; assert exact
      cell values, cross-dow boundary (Sun 23:00 vs Mon 00:00), empty range.
- [ ] Export via `packages/store/src/index.ts`.

## Task 2: statistical fields on existing breakdowns

- [ ] Extend `tradeBreakdowns` byDow/byHour entries with `se` (standard
      error of mean PnL) and keep `n` (already present as trades count —
      verify field name consistency).
- [ ] Tests: hand-computed SE on a 3-trade fixture; single-trade bucket
      (se null, not 0); zero-variance bucket.

## Task 3: `rollingStats` aggregation

- [ ] `rollingStats(db, f, windowDays)` → per-day rolling Sharpe (√252
      annualized, matching `/stats` convention), rolling win rate, rolling
      mean daily net, computed over `dailyNets`. Window default 30d, param
      capped (e.g. 7-180).
- [ ] Emit null (not 0) for days with fewer than windowDays observations —
      the "cannot compute" rule.
- [ ] Tests: known 5-day series with hand-computed 3-day window; warmup
      nulls asserted.

## Task 4: `costDecomposition` aggregation

- [ ] `costDecomposition(db, f)` → per-month and per-strategy
      `{grossProfit, commission, swap, net}` from `deals` columns (deals
      source only — trade_closes has no cost split; mark source in payload).
- [ ] Tests: fixture deals with nonzero commission/swap; assert gross vs
      net reconciles with existing `realized` totals.

## Task 5: `contributionRanking` aggregation

- [ ] `contributionRanking(db, f)` → ranked rows by symbol, by strategy,
      by direction: `{key, net, n, expectancy, winRate, share}` where share
      = net / totalNet (signed).
- [ ] Tests: two-symbol fixture; sign handling when total is negative.

## Task 6: API surface

- [ ] New `include=` keys on `/performance` in `packages/api/src/rest.ts`:
      `dowHour`, `rolling`, `costs`, `contribution` — each with its own
      cache key + TTL, matching the `perf-daily`/`perf-closes` pattern.
      `rolling` accepts `window` query param.
- [ ] Route tests: shape assertions + cache-key distinctness + param
      validation (window bounds).

## Task 7: client types + chart primitives

- [ ] `apps/web/src/api.ts`: interfaces for the four new payloads.
- [ ] Verify vendored `/vendor/echarts.min.js` includes `heatmap`,
      `boxplot`, `radar` + `visualMap` component; if absent, swap in a
      build that does (document the bundle provenance in the file header).
- [ ] `components/`: `HeatmapChart` (visualMap diverging red↔green around a
      neutral dark midpoint, min-n mask renders as flat panel color, cell
      tooltip = n/net/mean/winRate, values printed in cells at zoom),
      `RadarChart` (outline-only, max 4 series, normalization labeled),
      box-plot option builder. All reuse `ECHART_GRID`/tokens.

## Task 8: Edge page

- [ ] `pages/Edge.tsx` + nav entry in `App.tsx` (Performance group):
      hero = DoW×hour heatmap (account-level, strategy filter toolbar);
      weekday bars + hour bars upgraded with n labels, ±SE whiskers,
      grey-out under n<30; time-basis "UTC" label on every panel.
- [ ] Rolling-stability panel (Sharpe + win rate, window selector 30/60/90).
- [ ] Panel-level Skeleton/Loadable isolation; react-query keys per include.

## Task 9: existing-view upgrades

- [ ] Monthly-returns heatmap on the Calendar view (year×month grid from
      existing dailyNets — client-side aggregation; values printed in
      cells; YTD column kept).
- [ ] Equity page: shade `drawdownPeriods` spans onto the equity curve
      (markArea), top-N table already exists — link hover table↔chart.
- [ ] Strategies page: cost-decomposition stacked bars (per month) +
      contribution ranked bars with side table (net + expectancy + n).
- [ ] Strategy radar panel on Overview/Strategies: win rate, PF, Sharpe,
      DD⁻¹, expectancy — min-max normalized across shown strategies,
      normalization note in panel hint, cap 4 strategies with picker.
- [ ] PnL box plots per weekday/strategy beside the existing histogram
      (box not violin; n per box).

## Task 10: verification + docs

- [ ] `pnpm build:all && pnpm test` green (mise PATH prefix).
- [ ] Manual pass against the live prod DB copy: numbers on Edge page
      reconcile with existing Performance totals for the same filter
      (sum over heatmap cells == report net for the range).
- [ ] Every new chart eyeballed in dark theme at 1280px and mobile width;
      wide tables scroll in-panel.
- [ ] Spec status flipped to implemented-Phase-A; README feature list
      updated; this plan's boxes all checked.

## Out of scope (tracked)

- MAE/MFE from `position_valuations`, submit-time SL columnization
  (R-multiples), margin-history rollup columns — Phase B.
- qkt egress additions (venue SL/TP, deal fee, `state.orders`, DEAL-family
  gating fix) — qkt#780, #781, #782, #783.
- Session tagging / timezone model beyond labeled UTC — Phase C.
