# qkt-insights Spec 2 Implementation Plan

> Executed inline (autonomous /goal). Spec: `docs/specs/2026-06-11-qkt-insights-spec2-design.md`.

**Goal:** Real Strategies / Trades / Logs / Search / Equity pages on real data; logs pipeline from qkt.

**Order of work** (each task = tests first, commit on green):

1. **contract**: add `log` payload type. Test: valid/invalid log envelope.
2. **store**: migration `002_logs.sql` (logs + logs_fts); route `log` envelopes in
   `ingestEvents` (into logs, not events); `listLogs` (filters + FTS); test routing,
   filtering, search.
3. **store**: `strategyStats` (tradeCount, volume, realizedPnl, winRate, maxDrawdownPct,
   sharpe from equity snapshots — daily buckets, √252, null under 5 points);
   `listTrades` strategy fallback via orders join. Numeric fixture tests.
4. **api**: `GET /logs`, `GET /stats` behind the session guard. Tests through real Fastify.
5. **web**: `recharts`; pages Strategies (+detail), Trades, Logs (live tail), Search,
   Equity comparison; sidebar routes replace stubs. Build green (`tsc --noEmit` + vite).
6. **qkt PR** (branch `feat-insights-log-egress` off dev): `InsightsEventFamily.LOG`;
   `InsightsLogAppender` (logback `AppenderBase`, level >= INFO, builds `log` envelopes,
   offers to the shared sink); attached/detached by `DaemonCommand` when enabled.
   Tests: appender→sink→real HTTP capture; family parsing.
7. **e2e**: full suites both repos; docker rebuild; local stack: qkt session +
   log emission → container → verify pages show stats/chart/logs/search. Ship:
   qkt-insights PR → dev → main (CI + ghcr); qkt PR CI green.
