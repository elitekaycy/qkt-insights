# Screens

A tour of every page in the dashboard. Screenshots are from a live instance; the
account number, broker name, and account holder on **Overview** and **Health** are
placeholders — everything else (balance, positions, strategies, trades, logs) is real.

## Overview

Everything the selected instance is doing right now: account snapshot, open
positions, account performance (net P&L, win rate, expectancy, drawdown), a
trading calendar, monthly returns, and a full performance dashboard —
daily/cumulative P&L, strategy equity, trade excursion, outcomes, risk budget,
trading behavior, and execution quality — down to every reporting instance.

![Overview](assets/screenshots/overview.png)

## Equity

Broker account equity over time, per-strategy equity normalized to % change,
underwater curve, and drawdown periods.

![Equity](assets/screenshots/equity.png)

## Strategies

Every standalone and portfolio strategy on the instance, with live P&L and return.
A strategy the engine has halted (`risk.halted` with no later `risk.resumed`) carries a
`halted` badge; hovering it gives the reason, when it tripped and how it clears, and the
strategy page spells it out, with `qkt resume <name>` for a persistent halt.
A session-level halt covers the strategies its session runs (`sessionStrategies`, qkt#1244);
from older engines, which do not name them, it covers every strategy of the instance.
A session start sends each strategy's own halt state (`risk.snapshot`, qkt v0.52.4); that
replaces whatever the earlier halt events implied for the strategy.

![Strategies](assets/screenshots/strategies.png)

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

## Search

Full-text search across every event and log line — symbols, order ids, halt
reasons, log text.

![Search](assets/screenshots/search.png)
