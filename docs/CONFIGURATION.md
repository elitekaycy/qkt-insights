# Configuration

How to run the collector and connect qkt to it. For the first five minutes, start with the
[README quick start](../README.md#quick-start).

## Docker

```bash
docker run -d --name qkt-insights \
  -p 127.0.0.1:8420:8420 \
  -v insights-data:/data \
  -e INSIGHTS_DB=/data/insights.db \
  -e INGEST_TOKEN='<random, at least 24 characters>' \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='<at least 12 characters>' \
  ghcr.io/elitekaycy/qkt-insights:latest run
```

Or with compose: copy `docker-compose.yml`, set the three env vars, `docker compose up -d`.

The collector refuses to start with an ingest token under 24 characters or an admin
password under 12. The port binds to loopback on purpose: to reach the dashboard from
anywhere, put an HTTPS reverse proxy in front and follow
[Exposing the dashboard to the internet](operations/internet-exposure.md), which
covers the proxy, two-factor sign-in and sign-in alerts. The production image exposes `GET /healthz` and includes a Docker `HEALTHCHECK`; use an immutable `:v*` or `:sha-*` tag for pinned deployments and `:latest` only for tracking `main`.

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

## Prerequisites

qkt-insights is a collector and dashboard — on its own it has nothing to show. You need
a running [**qkt**](https://github.com/elitekaycy/qkt) instance to feed it, and if that
instance trades live on MetaTrader 5, qkt talks to the broker through
[**mt5-gateway**](https://github.com/elitekaycy/mt5-gateway).

