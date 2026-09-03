<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/qkt-insights-logo-dark.svg">
    <img alt="qkt-insights" src="docs/assets/qkt-insights-logo-light.svg" width="380">
  </picture>
</p>

<h3 align="center">A self-hosted observability dashboard for the <a href="https://github.com/elitekaycy/qkt">qkt</a> trading engine.<br/>Every trade, order, log line, and equity curve — from every instance — in one place.</h3>

<p align="center">
  <a href="https://github.com/elitekaycy/qkt-insights/actions/workflows/ci.yml"><img src="https://github.com/elitekaycy/qkt-insights/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license"></a>
  <a href="https://github.com/elitekaycy/qkt-insights/pkgs/container/qkt-insights"><img src="https://img.shields.io/badge/ghcr.io-qkt--insights-2496ED?logo=docker&logoColor=white" alt="container"></a>
</p>

<p align="center">
  <img src="docs/assets/qkt-insights-demo.gif" alt="Clone qkt-insights, install, build, and start the server — all from the terminal" width="880">
</p>

---

> Live dashboard for [qkt](https://github.com/elitekaycy/qkt). Sibling project — same brand, same engineering style.

**qkt-insights** ingests the event stream a running [qkt](https://github.com/elitekaycy/qkt) instance already produces — signals, order lifecycle, fills, risk halts, equity snapshots, engine logs — persists it in SQLite, and serves a clean React dashboard behind a single admin login. Point any number of qkt instances (different accounts, different boxes) at one collector and switch between them from the sidebar.

The design promise: **observability never touches the trading hot path.** The qkt side enqueues onto a bounded in-memory queue and a background thread ships batches; if the collector is slow or down, events are dropped and the engine keeps trading. Telemetry is a best-effort tap, not a dependency.

```
qkt instance(s)               qkt-insights (one Node process)                browser
EventBus tap ── batched ───▶  collector → store (SQLite + FTS5) → api(+WS) ──▶ React app
InsightsSink   POST /ingest             single writer, one file
```

## Features

- **Health** — every reporting instance, last-event age, sequence position, sink counters, journal backlog, live/idle status.
- **Uptime** — a heartbeat monitor per daemon and HTTP probes for anything else on the box (the MT5 gateway, with `mt5_status: connected` asserted); 24h strip, uptime %, incident timeline, and a Telegram/webhook alert on every down and recovery. A dead-man ping tells an outside service the collector itself is alive.
- **Strategies** — per-strategy drill-down: equity chart, Sharpe, win rate, max drawdown, return, trades, recent logs.
- **Trades** — every fill, filterable by strategy and symbol.
- **Logs** — engine logs shipped from qkt with level filters, full-text search, and a live tail.
- **Search** — FTS5 full-text search across all events and logs: symbols, order ids, halt reasons, log text.
- **Equity** — all strategies on one normalized comparison chart; drawdown periods shaded on the focused curve.
- **Edge** — when a strategy makes money: day-of-week × hour P&L heatmap (UTC), weekday/hour bars with per-bucket n and ±SE, rolling Sharpe/win-rate stability, strategy-comparison radar. Buckets under 30 trades render greyed — thin slices are noise, and the UI says so.
- **Single-admin auth** — username + password from env, hashed with argon2 at startup, signed httpOnly session cookie; ingest guarded by a bearer token.

<p align="center">
  <img src="docs/assets/screenshots/overview-hero.png" alt="qkt-insights Overview page" width="880">
</p>

See [`docs/PAGES.md`](docs/PAGES.md) for a screenshot of every page.

## Prerequisites

qkt-insights is a collector and dashboard — on its own it has nothing to show. You need
a running [**qkt**](https://github.com/elitekaycy/qkt) instance to feed it, and if that
instance trades live on MetaTrader 5, qkt talks to the broker through
[**mt5-gateway**](https://github.com/elitekaycy/mt5-gateway).

<p align="center">
  <a href="https://github.com/elitekaycy/qkt"><img src="https://img.shields.io/badge/qkt-trading%20engine-c8f74a?style=for-the-badge&logo=github&logoColor=black" alt="qkt on GitHub"></a>
  <a href="https://github.com/elitekaycy/mt5-gateway"><img src="https://img.shields.io/badge/mt5--gateway-MT5%20broker%20bridge-5cb8ff?style=for-the-badge&logo=github&logoColor=black" alt="mt5-gateway on GitHub"></a>
</p>

Set up qkt (and mt5-gateway, if you're trading live) first, then come back here and
point it at this collector — see [Connecting a qkt instance](#connecting-a-qkt-instance).

## Quick start (Docker)

```bash
# 1. Run it
docker run -d --name qkt-insights \
  -p 8420:8420 \
  -v insights-data:/data \
  -e INSIGHTS_DB=/data/insights.db \
  -e INGEST_TOKEN=change-me \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='<your password>' \
  -e SESSION_SECRET='<long random string>' \
  ghcr.io/elitekaycy/qkt-insights:latest run

# 2. Open http://localhost:8420 and sign in
```

Or with compose: copy `docker-compose.yml`, set the four env vars, `docker compose up -d`. The production image exposes `GET /healthz` and includes a Docker `HEALTHCHECK`; use an immutable `:v*` or `:sha-*` tag for pinned deployments and `:latest` only for tracking `main`.

<p align="center">
  <img src="docs/assets/qkt-insights-demo-docker.gif" alt="Clone qkt-insights, build the image, and run it with Docker — all from the terminal" width="880">
</p>

## Install it on your phone

The dashboard is a PWA. Open it in a mobile browser and use **Install app** — on the
login screen, or at the bottom of the sidebar once you're in. Chrome and Edge show the
native install prompt; iOS Safari has no such prompt, so the button explains the
**Share → Add to Home Screen** route instead. Installed, it launches standalone with no
browser chrome, its own icon, and the notch/home-indicator insets respected.

> **It must be served over HTTPS.** Browsers only expose service workers and
> installability on a secure origin (`https://`, or `localhost` for development). Over
> plain `http://` to a LAN or Tailscale address the dashboard still works, but
> `navigator.serviceWorker` is absent and no install option appears. If you reach your
> instance over Tailscale, `tailscale serve https / http://localhost:8420` gives it a
> real certificate on your tailnet — that URL is installable.

Live trading figures are never cached: the service worker precaches the app shell only,
so a screen you open is always talking to the collector, never replaying a stale number.

**Running several dashboards?** Set `INSIGHTS_NAME` on each (`-e INSIGHTS_NAME=hypergrowth`).
It becomes the home-screen label and app name for that install, the browser-tab title,
and a tag on the login card and sidebar — so three installed dashboards are not three
identical `qkt-insights` icons. Keep it short; home screens truncate past ~12 characters.

## Run modes

One image, one entrypoint, three shapes — pick with the container command:

| mode | what runs | use it for |
|---|---|---|
| `collect` | store + `POST /ingest` | headless recorder on a separate box |
| `serve` | collect + REST/WS API | API-only, UI hosted elsewhere |
| `run` *(default)* | serve + the web app | the full thing on one port |

## Connecting a qkt instance

In your `qkt.config.yaml` (requires qkt ≥ 0.40.0):

```yaml
insights:
  enabled: true
  url: "http://insights-host:8420/ingest"
  instance_id: "qkt-prod"          # how this instance appears in the sidebar
  token: "${INGEST_TOKEN}"
  events: [trade, order, signal, risk, position, state, deal, lifecycle, log] # sink health is emitted automatically while insights is enabled
```

Each family is opt-in. Sink health snapshots report sent/failed/dropped/queued telemetry automatically; qkt versions with the local insights journal also report whether replay is enabled and how many rows are pending. `state` polls broker account/position truth, `deal` backfills durable broker deal history where the broker supports it, `lifecycle` streams strategy start/stop events, and `log` attaches a logback appender that streams INFO+ engine logs. The old `snapshot` family is accepted by older configs but no longer wires an emitter in current qkt. Omit `enabled` or set it `false` and qkt wires nothing: no thread, no queue, zero overhead.

## Uptime and alerts

Every 30s the collector checks one **heartbeat** monitor per reporting instance (down after
90s of silence — three missed pulses) and every **http** monitor declared in
`INSIGHTS_MONITORS`. A monitor goes down after three straight failures and comes back on the
first success; each transition is stored, shown on Health, and pushed to every configured
channel. All of it is optional and off by default — with nothing set you still get the
heartbeats and the Health page, just no alerts.

```dotenv
# HTTP probes: 2xx required; `expect` asserts top-level JSON fields, which is how a gateway
# that answers but has lost its MT5 login still counts as down. `headers` go out with the
# probe: mt5-gateway keeps /health behind its API key.
INSIGHTS_MONITORS=[{"name":"mt5-gateway","url":"http://mt5-gateway:5001/health","expect":{"mt5_status":"connected"},"headers":{"Authorization":"Bearer <MT5_API_KEY>"}}]

# Alerts. Same bot and chat qkt and qkt-guardrails use; the webhook receives the transition as JSON.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ALERT_WEBHOOK_URL=

# Dead-man: GET on every tick. Point it at healthchecks.io or an Uptime Kuma push monitor and the
# outside world pages when this box, not just a daemon on it, goes dark.
DEADMAN_URL=
```

`INSIGHTS_NAME` prefixes every alert, so several boxes can share one chat. Monitoring runs in
`collect` and `run` modes, next to the collector that receives the heartbeats.

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

Design notes live in [`docs/specs/`](docs/specs/) and the implementation plans in [`docs/plans/`](docs/plans/).

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

## Contributing

Issues and PRs welcome. Branch off `dev` (the default branch), keep PRs focused, and
make sure `pnpm test` and `pnpm build:all` pass. If you're adding an event type,
start in `packages/contract` — the schema is the contract both sides compile against.

## License

[Apache 2.0](LICENSE) © Dickson Anyaele
