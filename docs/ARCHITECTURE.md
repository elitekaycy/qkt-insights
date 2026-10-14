# Features and architecture

## Features

- **Health** — every reporting instance, last-event age, sequence position, sink counters, journal backlog, live/idle status.
- **Uptime** — a heartbeat monitor per daemon and HTTP probes for anything else on the box (the MT5 gateway, with `mt5_status: connected` asserted); 24h strip, uptime %, incident timeline, and a Telegram/webhook alert on every down and recovery. A dead-man ping tells an outside service the collector itself is alive.
- **Strategies** — per-strategy drill-down against the strategy's own capital: its equity curve (never the shared account), Sharpe, win rate, max drawdown, return, trades, the latest logs, and the deploy's runtime details one click from the name.
- **Trades** — every fill, filterable by strategy and symbol.
- **Logs** — engine logs shipped from qkt with level filters, full-text search, and a live tail.
- **Search** — FTS5 full-text search across all events and logs: symbols, order ids, halt reasons, log text.
- **Equity** — all strategies on one normalized comparison chart; drawdown periods shaded on the focused curve.
- **Edge** — when a strategy makes money: day-of-week × hour P&L heatmap (UTC), weekday/hour bars with per-bucket n and ±SE, rolling Sharpe/win-rate stability, strategy-comparison radar. Buckets under 30 trades render greyed — thin slices are noise, and the UI says so.
- **Single-admin auth** — username + password from env, hashed with argon2 at startup, signed httpOnly session cookie; ingest guarded by a bearer token.

See [Screens](PAGES.md) for a screenshot of every page.

## Architecture

A pnpm workspace of small, single-purpose packages:

| package | responsibility |
|---|---|
| `packages/contract` | the wire truth — Zod schemas for every envelope type; validation at the boundary, types everywhere else |
| `packages/store` | the only SQLite writer — WAL, FTS5, forward-only migrations, order-state folding, stats (Sharpe, drawdown, win rate) |
| `packages/collector` | `POST /ingest` — bearer auth, Zod-validated, idempotent on event id, timestamp/seq-aware order folding |
| `packages/api` | REST + WS `/live` behind the session guard |
| `apps/web` | React + Vite + Tailwind dashboard |
| `src/server.ts` | one entry, boots subsystems by mode |

Design notes live in [`specs/`](specs/) and the implementation plans in [`plans/`](plans/).

## Development

```bash
pnpm install
pnpm test            # vitest — real SQLite, real HTTP, no mocks
pnpm build:all       # tsc project references + vite web build
pnpm --filter @qkt-insights/web dev    # web dev server proxying to :8420
node dist/src/server.js serve          # backend against ./insights.db
```

Conventions: TypeScript strict, smallest reasonable change, no mocks in e2e tests,
commit subjects only. CI runs the full suite on every push and PR; merges to `main`
publish `ghcr.io/elitekaycy/qkt-insights:latest`.
