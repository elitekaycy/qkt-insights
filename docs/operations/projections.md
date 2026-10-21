# Write-time projections

The dashboard's figures are read from tables kept up to date as data arrives, instead of being
rebuilt from the raw deals, marks and account minutes on every request. Each projection can be
rebuilt from its source tables at any time; nothing in it is the only copy of anything.

| Projection | Tables | Source | Kept up to date | Serves |
|---|---|---|---|---|
| `closed_trades` | `closed_trades`, `position_closures`, `deals.canonical` | `deals` | per position, on every deal stored, attributed or changed: O(legs) | every closed-trade list and figure, the public cutoff rule, costs |
| (same) `round_trips` | `round_trips` | `deals`, `orders`, `order.submit` / `order.accepted` / `order.filled` / `bot.close` events; `trade_closes` for an instance without deals | per position, with its closed trades (per engine close, `source=ledger`, while the instance has no deals); ingest re-marks a position when an order fill names its broker ticket or an event closes it | the Trades page: one row per position, entry to exit |
| `strategy_daily` | `strategy_daily`, `strategy_totals` | `closed_trades`, `trade_closes` | in the same transaction, from the first changed day | daily nets, calendar, rolling stats, the strategy list |
| `position_excursions` | `position_excursions` | `closed_trades`, `position_valuations` | per mark: O(1); a pruned mark recomputes its ticket | MAE/MFE |
| `account_drawdown` | `account_drawdown_state`, `account_labels`, `account_minute_labels`, `account_label_pairs`, `account_groups` | `account_equity` | per minute rollup | `/account/drawdown`, `/account/risk`, month bases, `/account/equity` sampling |

Triggers on the source tables queue what changed (`projection_dirty`); the queue is folded in by
the writer's own transaction (ingest, the minute rollup) or by the next read, so rows written any
other way (another process, plain SQL) are picked up too. Each figure served from a projection is
bit-for-bit the one the full computation gives: sums are added in the same order, and when an
input is one only the full computation answers exactly (an account minute without equity, a
minute three broker labels share), the reader falls back to the full computation for it.

## Versions and rebuilds

`projections(name, version, cursor, rebuilt_at)` records the reducer version each projection was
built by. When a release changes a reducer it bumps the version, and the next start rebuilds that
projection from its source tables before serving. A rebuild works in batches, each committed with
its progress in `cursor`, so a start interrupted part way resumes where it stopped.

Measured on a copy of a production database (6.5k deals, 107k marks, 112k account minutes), the
first start after the upgrade spends about 1 s on it: closed trades and round trips 0.2 s (32k
deals/s), daily rollup 9 ms, excursions 21 ms, account walks 0.7 s (160k minutes/s). The account walks dominate and grow
with the stored minutes: about 7 s per million.

To rebuild by hand, for example after restoring a backup taken by another version or after the
`VACUUM INTO` conversion in `storage-maintenance.md` (it may renumber row ids the projections
point at), stop the server and run:

```bash
docker compose run --rm --no-deps qkt-insights rebuild all
# or one projection: rebuild closed_trades (with round_trips) | strategy_daily | position_excursions | account_drawdown
```

Run it with the server stopped: a rebuild empties the projection first, and a running server
would serve the partial tables until it finishes.
