---
name: qkt-insights-chart-design
description: Design, add, or revise qkt-insights charts, dashboard widgets, metric cards, chart tooltips, chart filters, and visualization layouts. Use for any change under apps/web that introduces or materially changes an ECharts option, a trading-performance visualization, a dashboard widget, or the shared chart theme.
---

# qkt-insights chart design

Build calm, accurate trading visualizations that remain readable before they
become interactive. Preserve qkt's statistical honesty and broker-truth labels.

## Workflow

1. State the trader question the view answers. Do not add a chart whose only
   rationale is that the data exists.
2. Confirm source, unit, aggregation, time basis, and sample size in the store
   and API. Never repair an ambiguous metric with presentation alone.
3. Reuse `EChart`, the shared theme builders (`qktChartGrid`, `qktXAxis`,
   `qktChartAxis`, `qktChartTooltip`, `tipHtml`, `zeroLine`, `areaFade`,
   `chartColors`, `tok`), `ChartCard`, the `format.ts` helpers, and existing
   query/range controls. Do not duplicate grid, axis, tooltip, color, zoom, or
   empty-state configuration in a feature component.
4. Choose the smallest honest encoding:
   - line for ordered change over time;
   - diverging bars for signed category comparisons;
   - histogram for distributions;
   - scatter for relationships;
   - heatmap for a genuinely two-dimensional matrix;
   - table when exact comparison matters more than shape.
5. Implement loading, error, empty, sparse-data, mobile, keyboard, and expanded
   states with the normal data state.
6. Add fixture-backed aggregation tests when numbers change and focused web
   tests for pure layout/configuration logic.
7. Run the acceptance checklist, then the repository's Node 22 build and tests.

## Visual contract

The look is the qkt-backtester journal's, copied (not shared) the way labs
did: tokens in `apps/web/src/index.css`, chart base in `components/EChart.tsx`.

- Use sentence-case titles and one short muted description. Put filters and
  view toggles at the right edge of the header.
- Use Inter (tabular figures) for titles, axes, legends, tooltips and every
  number. JetBrains Mono is only for IDs, tickets, hashes and log lines.
- Colours are theme tokens, never hex: write `tok("gain-fill")` or
  `chartColors.*` in options (the host resolves them for the active theme and
  re-resolves on a theme switch), and `var(--color-*)` in tooltip HTML.
- Quiet axes: the x axis keeps one hairline baseline, no ticks, no split lines;
  value axes have no line, no ticks, at most five labels and faint gridlines.
  Draw a dashed `zeroLine()` on signed charts.
- Format axis values compactly (`8.4k`, `−56k`, true minus). The host applies
  `compact` to value axes without their own formatter. Put the exact figure in
  the tooltip via `tipHtml` (muted title with the time zone, one signed headline
  with its glyph, aligned rows, a hint when a click does something).
- Use one stable primary-series color (`chartColors.primary`). Gains are blue,
  losses red (`chartColors.gain`/`loss`), always paired with a sign or glyph;
  never recolor a whole equity curve based on its last point. Comparison lines
  and stacked parts use `chartColors.series`.
- Do not smooth equity, P&L, balance, exposure, drawdown, or step-like accounting
  series. Every visible point or segment must correspond to stored truth.
- Use area fill only for a single primary series and keep it subtle
  (`areaFade`, 18% to transparent). Never fill strategy-comparison lines.
- Zoom is the host's job, not the chart's: line/bar charts on a time or
  category axis get drag-to-pan, a wheel that zooms only after the chart is
  clicked (or with Ctrl/⌘ held) so the page keeps scrolling, a Reset zoom
  button while zoomed, and a slider under the plot from 40 points
  (`SLIDER_MIN_POINTS`). On touch screens panning starts after a tap. Do not add
  `dataZoom` to an option unless the chart needs something different.
- Prefer direct labels or a compact clickable legend. Limit simultaneous
  comparison lines to four unless the user selected more deliberately.
- Tooltips show time/category first, then marker + label + formatted value; add
  `n`, unit, source, and approximation/coverage warnings when relevant.
- Empty states explain what data is missing and how it arrives. Do not leave a
  large blank plotting rectangle.

## Statistical and trading contract

- Declare money, percent, R, ticks, pips, contracts/lots, or milliseconds.
  Never compare unlike units on one axis without explicit normalization.
- Label the timezone on every hour/day/session grouping.
- Print `n` on bucketed views. Desaturate buckets below the established minimum
  sample size and state that threshold in the panel.
- Preserve null as unknown. Never render missing, warmup, or unavailable values
  as zero.
- Label approximate, sampled, reconstructed, stale, and broker-reported values.
- Pair a risk or cost chart with an exact table when the chart cannot expose all
  values safely.
- Use normalized metrics for cross-strategy comparisons when capital or sizing
  differs. Explain the normalization.
- Keep red/green from being the sole encoding: use sign, position, labels, or
  shape as a second channel.

## Shared implementation rules

- Extend the shared chart theme before adding one-off option fragments.
- Keep chart math out of React. Aggregation belongs in `packages/store`; API
  transport types belong in `apps/web/src/api.ts`; rendering belongs in
  `apps/web/src/components`.
- Keep the curated Overview complete: every relevant core widget renders by
  default in a deliberate responsive order. Do not introduce a user-configured
  widget picker or canvas unless the user explicitly requests one.
- Preserve Overview's bounded fetch model. Prefer one aggregate endpoint over a
  request per widget when adding account-level cards.

## Acceptance checklist

- The trader question, source, unit, range, timezone, and `n` are clear.
- The normal, loading, error, empty, sparse, and stale states are intentional.
- The chart is readable at 390 px and 1280 px without page-level horizontal
  scrolling.
- Color is semantic, accessible, and not the only carrier of meaning.
- Axes are quiet; values are compact; the tooltip gives exact detail.
- No accounting series is smoothed and no missing value became zero.
- Shared primitives were reused; no chart-theme constants were duplicated.
- A test protects new math or nontrivial pure configuration.
