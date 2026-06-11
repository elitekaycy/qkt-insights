# qkt-insights — Spec 2: analytics, logs, search

Date: 2026-06-11
Status: approved (autonomous /goal), builds on the proven Spec 1 spine.
Scope: turn every disabled sidebar stub into a real page backed by real data, and
add the one missing data source (logs). No new infrastructure — same SQLite,
same single process, same contract discipline.

## 1. What ships

| Page | Backed by |
|---|---|
| **Strategies** | strategy list + per-strategy detail: equity chart, stats (trades, win rate, realized PnL, max drawdown, Sharpe), recent trades, recent logs |
| **Trades** | `/trades` with strategy/symbol filters + FTS search box |
| **Logs** | new logs pipeline: level filter, text search (FTS), live WS tail |
| **Search** | global FTS over events + logs, grouped by type |
| **Equity** | multi-strategy equity comparison chart (normalized %) |

## 2. Contract additions (`packages/contract`)

- New event type `log`: `{ level: "DEBUG"|"INFO"|"WARN"|"ERROR", logger: string, message: string }`.
  Flows through the same envelope/batch as everything else — one ingest path, one auth.

## 3. Store additions (`packages/store`)

- Migration `002_logs.sql`: `logs (instance_id, id, strategy_id, level, logger, message, ts, seq)`
  + `logs_fts` (FTS5 over message+logger). `log` envelopes route here, NOT into `events`
  (volume; events stays the trading record).
- `listLogs(db, {instanceId, strategyId?, level?, q?, limit})` — FTS when `q` present.
- `strategyStats(db, {instanceId, strategyId})` — computed from `events` (trades) and
  `equity_snapshots`: tradeCount, volume, realized PnL (last snapshot), winRate
  (per round-trip approximation: SELL trades with positive realized delta), maxDrawdownPct
  and **Sharpe** from per-snapshot equity returns (sampled to daily buckets,
  annualized √252; null when < 5 points — honesty over fake precision).
- `listTrades` gains strategy attribution fallback: a trade with NULL strategy_id takes
  the strategy of its order (join on orderId) — TradeEvent doesn't carry strategyId in qkt.

## 4. API additions (`packages/api`)

- `GET /logs?instance=&strategy=&level=&q=&limit=`
- `GET /stats?instance=&strategy=` → strategyStats
- WS `/live` already forwards `log` envelopes (they ride the same bus).

## 5. qkt side (separate PR)

`InsightsLogAppender` — a logback `AppenderBase<ILoggingEvent>` the daemon attaches to
the root logger only when insights is enabled and the `log` family is allow-listed.
Each event → `log` envelope → the existing shared `InsightsSink` (same bounded queue,
same drop-oldest; a log flood can never block trading). INFO and above only; the
appender filters below-threshold events itself. New `InsightsEventFamily.LOG`
(config name `log`).

## 6. Web (`apps/web`)

- Charting: `recharts` (equity area/line charts). Dark zinc theme as Spec 1.
- Sidebar stubs become routes; per-strategy drill-down from the Strategies page.
- Live tail on Logs reuses `useLiveStream` filtered to `types=log`.
- Search page queries `/search` + `/logs?q=` and groups hits.

## 7. Compatibility

`log` is a new envelope type: an older collector rejects batches containing it (Zod).
The qkt appender therefore ships in lockstep: the collector deploys first (this repo),
then the qkt PR. Same `v: 1` — additive change, no migration of existing rows.

## 8. Testing

Same rules: real SQLite, real HTTP, no mocks. Store stats get numeric fixtures with
hand-computed Sharpe/drawdown; logs route + FTS tested; API endpoints tested through
real Fastify; qkt appender tested against a captured real HTTP server; final
cross-system check via the env-gated local-stack test.
