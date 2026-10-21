# Screens

A tour of every page in the dashboard. The left rail (a bottom tab bar on phones) holds
Home, Strategies, Trades, Calendar, Equity & risk, Edge, Logs and Health, with Settings at the
bottom. Every page, strategy, tab, instance, date range and filter is in the URL, so links,
Back and reload work; shared links nest their pages under `/p/<token>/`. Dark is the default
theme; a light theme is one click away and remembered per device. All times are UTC. Screenshots are from a live instance; the
account number, broker name, and account holder on **Home** and **Health** are
placeholders — everything else (balance, positions, strategies, trades, logs) is real.

## Home

Everything the selected instance is doing right now: account snapshot, open
positions, account performance (net P&L, win rate, expectancy, drawdown), a
trading calendar, monthly returns, daily/cumulative P&L, trade excursion, risk
budget, long/short performance and trading behavior. Strategy equity lives on
Equity & risk; instance status lives on Health.

![Overview](assets/screenshots/overview.png)

## Equity & risk

Broker account equity over time, per-strategy equity normalized to % change,
underwater curve, and drawdown periods.

![Equity](assets/screenshots/equity.png)

## Strategies

Every standalone and portfolio strategy on the instance, with live P&L and return.
A strategy the engine has halted (`risk.halted` with no later `risk.resumed`) carries a
`halted` badge; clicking or tapping it gives the reason, when it tripped and how it clears, and the
strategy page spells it out, with `qkt resume <name>` for a persistent halt.
A session-level halt covers the strategies its session runs (`sessionStrategies`, qkt#1244);
from older engines, which do not name them, it covers every strategy of the instance.
A session start sends each strategy's own halt state (`risk.snapshot`, qkt v0.52.4); that
replaces whatever the earlier halt events implied for the strategy.

![Strategies](assets/screenshots/strategies.png)

## Calendar

The account's P&L calendar: Monday-first weeks with a week column, each day shaded by its
size, today marked in progress, and monthly returns on the account's base. Click a day or a
month for its breakdown.

## Edge

When a strategy makes money: day-of-week × hour P&L heatmap, weekday/hour bars with
per-bucket sample size, and rolling edge stability. Buckets under 30 trades render
desaturated — thin slices are noise, and the UI says so.

![Edge](assets/screenshots/edge.png)

## Trades

Every executed fill, sourced from broker deal history, filterable by strategy and
symbol.

![Trades](assets/screenshots/trades.png)

## Logs

Engine logs shipped from the instance, with level filters and full-text search.

![Logs](assets/screenshots/logs.png)

## Health

Fleet at a glance, then uptime: one heartbeat monitor per daemon, one market-data
monitor per daemon when `INSIGHTS_MARKETDATA_MONITOR` is on, and every declared HTTP
probe, each with a 24h strip (30-minute bars, red on any failed check, grey when
nothing was checking), uptime over 24h and 30d, latency or the failure reason, and
how long it has held its current status. Incidents lists every up/down transition.
Below that, runtime status for every reporting instance: last event age, sequence
position, sink delivery counters, journal backlog, and broker account truth.

![Health](assets/screenshots/health.png)

## Settings

Sharing (public or private per overview, portfolio and strategy, with copy and rotate),
Viewership of shared links, the theme, installing the app, and signing out.

Old `/find` links (the retired Search page) open Logs.
