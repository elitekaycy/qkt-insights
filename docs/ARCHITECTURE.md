# Features and architecture

## Features

- **Health** — every reporting instance, last-event age, sequence position, sink counters, journal backlog, quarantined envelopes by type, live/idle status.
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
| `packages/collector` | `POST /ingest` — bearer auth, Zod-validated per envelope, idempotent on event id, quarantines what it cannot read, timestamp/seq-aware order folding |
| `packages/api` | REST + WS `/live` behind the session guard |
| `apps/web` | React + Vite + Tailwind dashboard |
| `src/server.ts` | one entry, boots subsystems by mode |

## Ingest contract

`POST /ingest` takes `{instanceId, events: [...]}` with `Authorization: Bearer <INGEST_TOKEN>`. The batch is checked
only for that shape; each envelope is then checked on its own, so one envelope the collector cannot read never
costs the rest of the batch (qkt's journal retries a rejected batch forever, which would freeze that bot's telemetry).

Each envelope goes through, in order:

1. **Envelope base** — `v` (integer), `instanceId`, `id`, `seq` (integer ≥ 0), `ts` (integer ms), `type` (string),
   optional `strategyId`, and a `payload`.
2. **Major version** — `v` must be a supported major (`1`).
3. **Type and payload** — `type` must be in `packages/contract/src/payloads.ts` and the payload must match its schema.
   Payload objects are passthrough: a field the contract does not know is kept in the stored JSON.

An envelope that passes is stored exactly as before. One that fails any step is **quarantined**: stored raw in
`quarantined_events` (keyed by instance and envelope id, so redelivery writes one row; an envelope with no id is
keyed `sha256:<hex>` of its JSON) with the reason, acknowledged with 200, and counted per type and major on Health
(`quarantined` on `GET /health/instances`).

| change from qkt | result |
|---|---|
| new payload field | accepted, kept in the payload JSON |
| unknown type | quarantined, the rest of the batch is stored |
| `v` other than 1 | quarantined |
| renamed required field, numeric sent as a string | quarantined (projections need the typed field) |
| unknown `side` (e.g. `SHORT`) | quarantined: side sets the sign of P&L, so it is never guessed |
| unknown log `level` (e.g. `TRACE`) | accepted as sent: logs are display-only |

The response is 400 only for a body that is not JSON or not a batch (`invalid batch`) and for an envelope whose
`instanceId` differs from the batch's (`instance mismatch`); 401/429 cover auth. A 200 response:

```json
{
  "accepted": 1,
  "quarantined": 1,
  "envelopes": [
    { "id": "t1", "status": "accepted" },
    { "id": "f1", "status": "quarantined", "reason": "unknown type \"signal.future\"" }
  ],
  "ack": { "instanceId": "demo", "lastSeq": 1, "observations": [], "received": 2, "acknowledgedIds": ["t1", "f1"] }
}
```

`status` is `accepted`, `duplicate` (the id was already stored) or `quarantined`; a redelivered quarantined envelope
is reported `quarantined` again. `accepted`, `ack` and `acknowledgedIds` keep their earlier meaning; every envelope
in a 200 batch is acknowledged.

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
