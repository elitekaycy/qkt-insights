import type { BreakdownRow, ContributionRanking, CostDecomposition, DowHourCell, PerformanceReport, RollingPoint } from "../api";
import { money } from "../format";
import { EChart, qktBottomLegend, qktChartAxis, qktChartGrid, qktChartTooltip, useNarrowChart, type QktChartOption } from "./EChart";

/*
 * Edge-analytics charts. Shared design rules (the institutional contract):
 * every bucketed mark carries n; buckets under MIN_N render desaturated;
 * diverging red<->green with a neutral dark midpoint; hue is never the only
 * encoding (values print in cells/labels); the time basis is labeled UTC.
 */

/** Buckets with fewer trades than this are visually "not enough data". */
export const MIN_N = 30;

const MONO = "JetBrains Mono, ui-monospace, monospace";
const UP = "#3fe08c";
const DOWN = "#ff6b6b";
const MUTED = "#5b636d";
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Symmetric diverging range so 0 always sits on the neutral midpoint. */
function symExtent(values: number[]): number {
  const m = Math.max(...values.map((v) => Math.abs(v)), 1e-9);
  return m;
}

/** 7×24 day-of-week × hour heatmap. Cell color = mean P&L; label = net; sub-MIN_N cells desaturate. */
export function DowHourHeatmap({ cells, height = 320 }: { cells: DowHourCell[]; height?: number }) {
  const narrow = useNarrowChart();
  const ext = symExtent(cells.map((c) => c.mean));
  // A phone cannot fit 24 labelled columns plus a side legend: the legend drops
  // below, every third hour is labelled, and cells rely on color alone — the
  // tooltip still carries n and the exact numbers.
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: narrow ? { ...qktChartGrid, left: 40, right: 6, top: 10, bottom: 74 } : { ...qktChartGrid, left: 58, right: 76, top: 24, bottom: 36 },
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const p = params as { data?: { value: [number, number, number]; cell: DowHourCell } };
        const c = p.data?.cell;
        if (!c) return "";
        const warn = c.n < MIN_N ? ` — under ${MIN_N} trades, treat as noise` : "";
        return `${DOW[c.dow]} ${String(c.hour).padStart(2, "0")}:00 UTC<br/>n ${c.n}${warn}<br/>net ${money(c.net)} · mean ${money(c.mean)}<br/>win rate ${c.winRate.toFixed(0)}%`;
      },
    },
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
      ...qktChartAxis,
      axisLabel: { ...qktChartAxis.axisLabel, interval: narrow ? 2 : "auto", fontSize: narrow ? 10 : 11 },
      splitLine: { show: false },
      name: "hour (UTC)",
      nameLocation: "middle",
      nameGap: 22,
    },
    yAxis: { type: "category", data: DOW, inverse: true, ...qktChartAxis, splitLine: { show: false } },
    visualMap: narrow
      ? {
          min: -ext,
          max: ext,
          calculable: false,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          itemWidth: 10,
          itemHeight: 140,
          text: ["mean +", "mean −"],
          textStyle: { color: "#f2f4f6", fontFamily: MONO, fontSize: 10 },
          inRange: { color: [DOWN, "#22272d", UP] },
        }
      : {
          min: -ext,
          max: ext,
          calculable: false,
          orient: "vertical",
          right: 0,
          top: "center",
          itemHeight: 120,
          text: ["mean +", "mean −"],
          textStyle: { color: "#f2f4f6", fontFamily: MONO, fontSize: 10 },
          inRange: { color: [DOWN, "#22272d", UP] },
        },
    series: [
      {
        type: "heatmap",
        label: {
          show: !narrow,
          fontFamily: MONO,
          fontSize: 9,
          color: "#f2f4f6",
          formatter: (p: unknown) => {
            const cell = (p as { data: { cell: DowHourCell } }).data.cell;
            return cell.n >= MIN_N ? money(cell.net) : `n${cell.n}`;
          },
        },
        itemStyle: { borderColor: "#12161a", borderWidth: narrow ? 1 : 2 },
        data: cells.map((c) => ({
          value: [c.hour, c.dow, c.mean],
          cell: c,
          // Sub-MIN_N cells: flatten toward the panel color so thin evidence never shouts.
          itemStyle: c.n < MIN_N ? { opacity: 0.28 } : undefined,
        })),
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

/**
 * Bucket bars with the honesty upgrades: n printed above each bar, ±SE
 * whiskers on the mean, and sub-MIN_N buckets desaturated. `measure` picks
 * net (bar) — the whisker always describes the per-trade mean.
 */
export function HonestBucketBars({ rows, height = 260 }: { rows: BreakdownRow[]; height?: number }) {
  const means = rows.map((r) => (r.trades > 0 ? r.net / r.trades : 0));
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: qktChartGrid,
    tooltip: {
      ...qktChartTooltip(),
      trigger: "axis",
      formatter: (params: unknown) => {
        const list = params as { dataIndex: number }[];
        const r = rows[list[0]?.dataIndex ?? 0];
        if (!r) return "";
        const mean = r.trades > 0 ? r.net / r.trades : 0;
        const se = r.se != null ? ` ± ${money(r.se)} SE` : "";
        const warn = r.trades < MIN_N ? `<br/><span style="color:${MUTED}">n < ${MIN_N} — not enough data for a verdict</span>` : "";
        return `${r.key} (UTC)<br/>n ${r.trades} · win ${((r.wins / r.trades) * 100).toFixed(0)}%<br/>net ${money(r.net)}<br/>mean ${money(mean)}${se}${warn}`;
      },
    },
    xAxis: { type: "category", data: rows.map((r) => r.key), ...qktChartAxis },
    yAxis: { type: "value", ...qktChartAxis },
    series: [
      {
        name: "net",
        type: "bar",
        data: rows.map((r) => ({
          value: r.net,
          itemStyle: {
            color: r.net >= 0 ? UP : DOWN,
            opacity: r.trades < MIN_N ? 0.3 : 0.95,
          },
          label: {
            show: true,
            position: r.net >= 0 ? "top" : "bottom",
            fontFamily: MONO,
            fontSize: 9,
            color: r.trades < MIN_N ? MUTED : "#f2f4f6",
            formatter: () => `n${r.trades}`,
          },
        })),
      },
      {
        // Mean ± SE whiskers, drawn on the per-trade mean scaled to trade count so
        // they live on the same axis as the net bar (mean*n = net; se*n spans it).
        name: "mean ± SE",
        type: "custom",
        renderItem: (params: unknown, api: unknown) => {
          const a = api as { value: (i: number) => number; coord: (v: [number, number]) => [number, number]; style: () => object };
          const i = a.value(0);
          const r = rows[i]!;
          if (r.se == null) return null;
          const lo = a.coord([i, r.net - r.se * r.trades]);
          const hi = a.coord([i, r.net + r.se * r.trades]);
          const w = 6;
          const line = (x1: number, y1: number, x2: number, y2: number) => ({
            type: "line" as const,
            shape: { x1, y1, x2, y2 },
            style: { stroke: "#f2f4f6", lineWidth: 1, opacity: r.trades < MIN_N ? 0.3 : 0.8 },
          });
          return {
            type: "group" as const,
            children: [line(hi[0], hi[1], lo[0], lo[1]), line(hi[0] - w, hi[1], hi[0] + w, hi[1]), line(lo[0] - w, lo[1], lo[0] + w, lo[1])],
          };
        },
        data: rows.map((_, i) => [i]),
        z: 3,
        silent: true,
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

/** Rolling Sharpe + win rate on twin axes; warmup nulls leave visible gaps. */
export function RollingChart({ points, height = 260 }: { points: RollingPoint[]; height?: number }) {
  const narrow = useNarrowChart();
  const below = qktBottomLegend(true);
  const option: QktChartOption = {
    backgroundColor: "transparent",
    color: ["#c8f74a", "#5cb8ff"],
    // the top-right legend would sit on the left axis name once the plot is phone-wide
    grid: narrow ? { ...qktChartGrid, left: 46, right: 44, top: 24, bottom: below.gridBottom } : { ...qktChartGrid, right: 58 },
    tooltip: { ...qktChartTooltip(), trigger: "axis" },
    legend: narrow ? below.legend : { top: 0, right: 0, textStyle: { color: "#f2f4f6", fontFamily: MONO } },
    xAxis: { type: "category", data: points.map((p) => p.day), ...qktChartAxis },
    yAxis: [
      { type: "value", name: "sharpe", ...qktChartAxis },
      {
        type: "value",
        min: 0,
        max: 100,
        ...qktChartAxis,
        axisLabel: { ...qktChartAxis.axisLabel, formatter: "{value}%" },
        splitLine: { show: false },
      },
    ],
    series: [
      { name: "rolling Sharpe", type: "line", showSymbol: false, connectNulls: false, data: points.map((p) => p.sharpe) },
      { name: "rolling win rate", type: "line", yAxisIndex: 1, showSymbol: false, connectNulls: false, data: points.map((p) => p.winRate) },
    ],
  };
  return <EChart option={option} height={height} />;
}

/** Gross profit vs commission vs swap per month — what trading actually cost. */
export function CostStack({ costs, height = 260 }: { costs: CostDecomposition; height?: number }) {
  const rows = costs.byMonth;
  const option: QktChartOption = {
    backgroundColor: "transparent",
    color: [UP, "#ffb86b", "#5cb8ff", "#a78bfa"],
    grid: qktChartGrid,
    tooltip: {
      ...qktChartTooltip(),
      trigger: "axis",
      formatter: (params: unknown) => {
        const list = params as { dataIndex: number }[];
        const r = rows[list[0]?.dataIndex ?? 0];
        if (!r) return "";
        return `${r.key}<br/>gross ${money(r.grossProfit)}<br/>commission ${money(r.commission)}<br/>swap ${money(r.swap)}<br/>fee ${money(r.fee)}<br/><b>net ${money(r.net)}</b> · ${r.trades} closes`;
      },
    },
    legend: { top: 0, right: 0, textStyle: { color: "#f2f4f6", fontFamily: MONO } },
    xAxis: { type: "category", data: rows.map((r) => r.key), ...qktChartAxis },
    yAxis: { type: "value", ...qktChartAxis },
    series: [
      { name: "gross", type: "bar", data: rows.map((r) => r.grossProfit), itemStyle: { color: UP, opacity: 0.9 } },
      { name: "commission", type: "bar", stack: "cost", data: rows.map((r) => r.commission), itemStyle: { color: "#ffb86b" } },
      { name: "swap", type: "bar", stack: "cost", data: rows.map((r) => r.swap), itemStyle: { color: "#5cb8ff" } },
      { name: "fee", type: "bar", stack: "cost", data: rows.map((r) => r.fee), itemStyle: { color: "#a78bfa" } },
    ],
  };
  return <EChart option={option} height={height} />;
}

/** Ranked net contribution bars (horizontal), expectancy in the tooltip. */
export function ContributionBars({ ranking, height = 260 }: { ranking: ContributionRanking; height?: number }) {
  const rows = [...ranking.bySymbol].reverse(); // horizontal bars read bottom-up
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: { ...qktChartGrid, left: 110 },
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const p = params as { dataIndex: number };
        const r = rows[p.dataIndex];
        if (!r) return "";
        const share = r.share != null ? ` · ${(r.share * 100).toFixed(0)}% of net` : "";
        return `${r.key}<br/>net ${money(r.net)}${share}<br/>n ${r.trades} · win ${r.winRate.toFixed(0)}% · expectancy ${money(r.expectancy)}`;
      },
    },
    xAxis: { type: "value", ...qktChartAxis },
    yAxis: { type: "category", data: rows.map((r) => r.key), ...qktChartAxis, splitLine: { show: false } },
    series: [
      {
        type: "bar",
        data: rows.map((r) => ({
          value: r.net,
          itemStyle: { color: r.net >= 0 ? UP : DOWN, opacity: r.trades < MIN_N ? 0.35 : 0.95 },
          label: { show: true, position: r.net >= 0 ? "right" : "left", fontFamily: MONO, fontSize: 9, color: "#f2f4f6", formatter: () => `n${r.trades}` },
        })),
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

export interface RadarEntry { strategyId: string; report: PerformanceReport }

const RADAR_COLORS = ["#c8f74a", "#5cb8ff", "#ff9ff3", "#ffb86b"];

/**
 * Strategy-comparison radar: outline-only (filled areas distort quadratically),
 * capped at 4 polygons, min-max normalized across the shown strategies — the
 * shape is only meaningful relative to the other polygons on screen.
 */
export function StrategyRadar({ entries, height = 320 }: { entries: RadarEntry[]; height?: number }) {
  const narrow = useNarrowChart();
  const shown = entries.slice(0, 4);
  const axes = [
    { name: "win rate", get: (r: PerformanceReport) => r.winRate ?? 0 },
    { name: "profit factor", get: (r: PerformanceReport) => (r.profitFactor === "inf" ? 10 : r.profitFactor ?? 0) },
    { name: "sharpe", get: (r: PerformanceReport) => r.sharpe ?? 0 },
    { name: "low drawdown", get: (r: PerformanceReport) => -(r.maxDrawdownPct ?? 100) },
    { name: "expectancy", get: (r: PerformanceReport) => r.expectancy ?? 0 },
  ];
  const norm = axes.map((a) => {
    const vs = shown.map((e) => a.get(e.report));
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    return (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  });
  const option: QktChartOption = {
    backgroundColor: "transparent",
    color: RADAR_COLORS,
    tooltip: qktChartTooltip(),
    legend: narrow
      ? { ...qktBottomLegend(true).legend, type: "plain", itemGap: 8 }
      : { top: 0, textStyle: { color: "#f2f4f6", fontFamily: MONO } },
    radar: {
      // phone: at most four names wrap under the plot (no paging), and the
      // polygon shrinks so the axis names ("profit factor", "expectancy") stay
      // inside the card
      center: ["50%", narrow ? "42%" : "58%"],
      radius: narrow ? "46%" : "62%",
      indicator: axes.map((a) => ({ name: a.name, max: 1 })),
      axisName: { color: "#f2f4f6", fontFamily: MONO, fontSize: narrow ? 9 : 10 },
      splitLine: { lineStyle: { color: "#22272d" } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: "#2f363e" } },
    },
    series: [
      {
        type: "radar",
        symbolSize: 3,
        data: shown.map((e, i) => ({
          name: e.strategyId,
          value: axes.map((a, ai) => norm[ai]!(a.get(e.report))),
          lineStyle: { width: 2, color: RADAR_COLORS[i % RADAR_COLORS.length] },
          areaStyle: undefined,
          itemStyle: { color: RADAR_COLORS[i % RADAR_COLORS.length] },
        })),
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

/** Per-bucket P&L box plots (box over violin under small n); whiskers = min/max. */
export function BucketBoxplot({ groups, height = 260 }: { groups: { key: string; values: number[] }[]; height?: number }) {
  const boxRow = (values: number[]): [number, number, number, number, number] => {
    const s = [...values].sort((a, b) => a - b);
    const q = (p: number) => {
      const idx = (s.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
    };
    return [s[0]!, q(0.25), q(0.5), q(0.75), s[s.length - 1]!];
  };
  const usable = groups.filter((g) => g.values.length >= 2);
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: qktChartGrid,
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const p = params as { dataIndex: number; data?: number[] };
        const g = usable[p.dataIndex];
        if (!g || !p.data) return "";
        const [minV, q1, med, q3, maxV] = p.data.slice(1) as [number, number, number, number, number];
        const warn = g.values.length < MIN_N ? `<br/><span style="color:${MUTED}">n < ${MIN_N}</span>` : "";
        return `${g.key} (n ${g.values.length})<br/>max ${money(maxV)}<br/>q3 ${money(q3)}<br/>median ${money(med)}<br/>q1 ${money(q1)}<br/>min ${money(minV)}${warn}`;
      },
    },
    xAxis: { type: "category", data: usable.map((g) => `${g.key} n${g.values.length}`), ...qktChartAxis },
    yAxis: { type: "value", ...qktChartAxis },
    series: [
      {
        type: "boxplot",
        itemStyle: { color: "rgba(200,247,74,0.12)", borderColor: "#c8f74a" },
        data: usable.map((g) => ({
          value: boxRow(g.values),
          itemStyle: g.values.length < MIN_N ? { borderColor: MUTED, color: "rgba(91,99,109,0.1)" } : undefined,
        })),
      },
    ],
  };
  return <EChart option={option} height={height} />;
}
