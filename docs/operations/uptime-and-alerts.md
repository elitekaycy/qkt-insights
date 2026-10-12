# Uptime and alerts

Every 30s the collector checks one **heartbeat** monitor per reporting instance (down after
90s of silence — three missed pulses), every **http** monitor declared in
`INSIGHTS_MONITORS`, and, when `INSIGHTS_MARKETDATA_MONITOR` is on, one **market data**
monitor per instance (named `<instance> market data`). A monitor goes down after three straight failures and comes back on the
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

# Market data: down while any symbol has been stale longer than the threshold (default 180s).
# Needs a qkt that sends marketdata.recovered; leave it off for older engines (see below).
INSIGHTS_MARKETDATA_MONITOR=0
INSIGHTS_MARKETDATA_ALERT_AFTER_S=180

# Dead-man: GET on every tick. Point it at healthchecks.io or an Uptime Kuma push monitor and the
# outside world pages when this box, not just a daemon on it, goes dark.
DEADMAN_URL=
```

`INSIGHTS_NAME` prefixes every alert, so several boxes can share one chat. Monitoring runs in
`collect` and `run` modes, next to the collector that receives the heartbeats.

What to expect, and the edges that are deliberate:

- **First boot says UP once per monitor.** That is the monitor being created, not a recovery.
  Restarts are silent: the last transition is restored from the database.
- **Heartbeats are judged on the collector's clock**, not the instance's. A VPS whose clock
  drifts by minutes still reads as alive as long as the collector keeps hearing from it.
- **An instance silent for 30 days leaves the monitor list** (its outage was announced long
  ago) rather than staying red forever; it is still listed under Runtime health.
- **Three failures, then down; one success, then up.** A gateway that flaps every couple of
  minutes will send a message each way every time. There is no cooldown yet; if that happens
  the fix is on the gateway side, not a quieter alert.
- **`DEADMAN_URL` means "the collector is alive", nothing more.** It is pinged even while
  every monitor is down; the outside service pages only when the pings stop, which is what
  catches the whole box going dark.
- **A malformed `INSIGHTS_MONITORS` refuses to start** with a message naming the field, the
  same way a bad guardian config does. A monitoring stack that silently ignores half its
  config is worse than one that fails loudly at boot.
- **Weekends stay quiet.** Heartbeats keep flowing and the gateway stays logged in while the
  market is closed, so neither monitor kind fires on a Saturday. The market-data monitor
  relies on qkt only reporting in-session staleness (24/7 crypto included).
- **Market data is judged from qkt's own reports.** An episode opens on `marketdata.stale` for
  a symbol and closes on a later `marketdata.recovered` for it, or on a later
  `marketdata.connected` from the same source naming it (qkt sends that once per session
  start, and a fresh session re-reports anything still stale, so a restart mid-episode does
  not page forever). `marketdata.reconnected` does not close an episode: qkt keeps its
  quote-health state across a feed reconnect and would not report a still-stale symbol
  again. The monitor is down while any episode has been open longer than
  `INSIGHTS_MARKETDATA_ALERT_AFTER_S`, then the usual three failed checks confirm it, so the
  first message lands about a minute after the threshold. It names each overdue symbol, how
  long, and why: `market data stale: PROP_S01:EURUSD 12m (quote age), PROP_S01:XAUUSD 12m
  (clock skew)`. Episodes are aged on the instance's clock, the time qkt reported them.
- **The market-data monitor needs a qkt that sends `marketdata.recovered`** (the first release
  after v0.53.0 that ships it). Older engines never report recovery, so a stale symbol would
  only clear at the next session start; that is why the monitor is off unless
  `INSIGHTS_MARKETDATA_MONITOR=1`. Collectors accept both the older and the current payloads.
- **Probes send `headers` verbatim and follow redirects; 5s timeout; 2xx required.** Assert on
  `expect` fields rather than status alone whenever the endpoint can answer 200 while degraded.
