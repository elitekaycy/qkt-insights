# qkt-insights

Observability dashboard for the qkt trading engine family. qkt instances stream
their bus events here (opt-in, best-effort, never blocking the engine); this
service persists them in SQLite and serves a queryable REST + WebSocket API and
a React dashboard behind a single admin login.

## Architecture

```
qkt instance(s)              qkt-insights (one Node process)               browser
EventBus tap ── batched ──▶  collector → store (SQLite+FTS5) → api(+WS) ──▶ React app
InsightsSink    POST /ingest          single writer, one file
```

- `packages/contract` — Zod event schema, the shared truth for validation and types.
- `packages/store` — the only SQLite writer: WAL, FTS5 search, migrations, order-state folding, queries.
- `packages/collector` — `POST /ingest` (bearer token, Zod-validated, idempotent on event id).
- `packages/api` — REST + WS `/live` behind an argon2 admin login with a signed session cookie.
- `apps/web` — React + Vite dashboard (login, health, live orderflow).
- `src/server.ts` — one entry, three modes.

## Run-modes

| mode | what runs |
|---|---|
| `collect` | store + `/ingest` only — headless recorder |
| `serve` | collect + REST/WS API |
| `run` | serve + the built web app (default) |

## Quick start

```bash
pnpm install
pnpm build:all
ADMIN_PASSWORD_HASH=$(node -e 'import("argon2").then(a=>a.hash(process.argv[1]).then(console.log))' 'your-password')
INSIGHTS_DB=./insights.db INGEST_TOKEN=changeme \
  ADMIN_PASSWORD_HASH="$ADMIN_PASSWORD_HASH" SESSION_SECRET=a-long-random-string \
  node dist/src/server.js run
# open http://localhost:8420
```

Docker:

```bash
docker build -t qkt-insights .
INGEST_TOKEN=changeme ADMIN_PASSWORD_HASH='...' SESSION_SECRET='...' docker compose up
```

## Pointing a qkt instance here

In `qkt.config.yaml`:

```yaml
insights:
  enabled: true
  url: "http://insights-host:8420/ingest"
  instance_id: "qkt-prod"
  token: "${INGEST_TOKEN}"
  events: [trade, order, signal, risk, position, snapshot]
```

The qkt engine thread only enqueues onto a bounded in-memory queue; a daemon
thread batches and POSTs. If this service is down, qkt drops events and keeps
trading — egress is an observability control, never a trading dependency.

## Development

```bash
pnpm test          # vitest, real SQLite + real HTTP, no mocks
pnpm build:all     # tsc project references + vite web build
pnpm --filter @qkt-insights/web dev   # web dev server proxying to :8420
```
