# Strategy Capital

Every per-strategy percentage in qkt-insights — return %, max drawdown, drawdown
periods, the equity curve, calendar returns — is measured against one number: the
strategy's **base**. This runbook explains where that number comes from and how to
set it for standalone strategies.

## Where the base comes from

Resolved per strategy, first match wins:

| Source | Applies to | Set by |
|---|---|---|
| `metadata.allocatedCapital` | portfolio children | the daemon's `strategy.started` (portfolio capital × weight) — used by the web UI |
| `STRATEGY_CAPITAL` | any strategy you list | the operator, in the insights container env |
| `strategies.starting_balance` | everything else | the daemon's `risk.startingBalance` on `strategy.started` |

Server-side math (stats, curves, drawdowns) uses `STRATEGY_CAPITAL`, else
`starting_balance`. The web UI shows the portfolio allocation first where one exists.

The problem `STRATEGY_CAPITAL` solves: a standalone deploy only reports the
daemon's `risk.startingBalance`, which is a daemon-wide, venue-scale figure (2.2M
on bot2), not what the strategy trades with. Against that base a $300 loss reads as
0.01%, so return and drawdown say nothing.

## How the equity curve is built

- **Strategies with broker deals:** base, then base + cumulative realized P&L at
  each closing deal (commission, swap and fee included). Realized only.
- **Strategies without deals:** from `equity_snapshots`, rebuilt as
  base + realized + unrealized. The snapshot's own `equity` column is **ignored**:
  under `risk.liveEquityBasis: VENUE` the daemon writes the whole account's equity
  into every strategy's snapshot (bot2 showed ~$4.999M for a strategy that never
  traded).

Either way the curve is this strategy's money only, never the shared account.

## Setting it

```dotenv
STRATEGY_CAPITAL={"gold_gaparmor_calm_v31":5000}
```

- Keys are strategy ids exactly as the dashboard shows them in the tooltip / URL
  (not display names). One id applies across every instance that runs it.
- Values are positive numbers in account currency.
- Pick the capital the strategy is actually meant to work out of — the figure its
  sizing and risk caps were designed around — not the account balance.
- The map is written to the `strategy_capital` table at every boot and replaces
  the previous contents: remove an id and it falls back to its starting balance.
- A `strategy.started` re-announce (daemon restart) never touches it, and the
  stale-strategy prune does not delete it.
- A malformed map (bad JSON, non-object, zero/negative/non-number value) stops the
  server at boot with a message naming the key.

## Applying a change

`STRATEGY_CAPITAL` is read at boot, so a change needs a container restart:

```bash
cd /root/forward-stack
# edit .env: STRATEGY_CAPITAL={"<strategyId>":<capital>}
docker compose up -d qkt-insights    # recreates the container with the new env
```

The compose service must pass the variable through (`STRATEGY_CAPITAL: ${STRATEGY_CAPITAL:-}`
under `environment:`), as the repo's `docker-compose.yml` does.

## Verifying

```bash
# the row carries the declared capital
curl -s -b cookies 'http://localhost:8420/strategies?instance=<instance>' | jq '.[] | {strategyId, startingBalance, definedCapital}'
# stats and the curve use it as the base
curl -s -b cookies 'http://localhost:8420/stats?instance=<instance>&strategy=<id>' | jq '{startingBalance, equity, returnPct, maxDrawdownPct}'
```

In the UI the strategy page's **Capital** card shows the figure and its source
(`defined`, `portfolio allocation`, or `starting balance`).

## Current values

| Box | Strategy | Capital | Basis |
|---|---|---|---|
| bot2 (forward-bench) | `gold_gaparmor_calm_v31` | 5,000 | The only base consistent with the daemon's live per-strategy caps: `perStrategyMaxDailyLoss` 300 = `perStrategyMaxDailyDrawdownPct` 0.06 × 5,000; `perStrategyMaxDrawdownPct` 0.15 = 750, above one full losing burst (20 × $30 = $600). The strategy trades fixed lots (0.01 × 20), so its dollar P&L does not depend on this figure — only the percentages do. Chosen 2026-09-10. |

Keep this table in step with each box's `.env` when a value changes.
