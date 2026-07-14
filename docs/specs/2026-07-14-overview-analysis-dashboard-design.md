# Overview analysis dashboard design

## Purpose

The Overview is a curated, read-only analysis surface. It answers what is
happening, how the account and strategies are performing, where risk is being
consumed, and which evidence deserves review. It does not provide a widget
canvas, layout picker, or data-entry workflow.

## Default information hierarchy

Every applicable panel renders in a fixed responsive order:

1. daily and cumulative realized P&L;
2. outcomes and current risk budget;
3. behavior and long/short contribution;
4. normalized strategy equity;
5. size-normalized performance and execution quality;
6. sampled MAE/MFE excursion analysis;
7. deterministic review focus and system health.

Unavailable analysis remains visible with an explanatory empty state. A user
should not have to discover or enable a core panel.

## Visual language

Charts use the shared quiet ECharts theme and `ChartCard`. Accounting series
are unsmoothed, axes are low contrast, visible slider controls are excluded
from the default view, and tooltips carry exact values. Blue identifies the
primary series; green and red retain positive and negative meaning.

## Data contracts

- Daily P&L is grouped by UTC close date.
- Equity comparison is normalized to percentage change from each strategy's
  first available point.
- Net per unit divides exact realized net by absolute closed quantity.
- Planned reward/risk is calculated only from numeric entry, stop, and target
  values on order submissions and exposes its sample size.
- Excursion data is sampled from stored broker position valuations. Coverage
  and sample counts remain visible because moves between polls are unknown.
- Execution quality reconstructs order lifecycle timestamps and reports
  rejection rate, acceptance latency, fill latency, and directional adverse
  price slippage.
- Review focus is deterministic exception text, not an AI judgment or trading
  recommendation.

## Non-goals

- user-configurable widget layout;
- free-form notes or any other write-side workflow;
- fabricated values for unavailable metrics;
- claims that sampled excursions are tick-exact.
