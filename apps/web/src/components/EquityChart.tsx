import type { DrawdownPeriod, EquityPoint } from "../api";
import { axisTick, money, pctValue, signedPct, tsShort } from "../format";
import {
  areaFade,
  chartColors,
  EChart,
  qktBottomLegend,
  qktChartAxis,
  qktChartGrid,
  qktChartTooltip,
  qktLegend,
  qktXAxis,
  tipHtml,
  tok,
  useNarrowChart,
  type QktChartOption,
} from "./EChart";

const empty = <div className="flex h-40 items-center justify-center text-sm text-muted">No equity snapshots yet</div>;

export function EquityChart({ points, shade, height = 260 }: { points: EquityPoint[]; shade?: DrawdownPeriod[]; height?: number }) {
  if (points.length === 0) return empty;
  const color = chartColors.primary;
  const lastTs = points[points.length - 1]!.ts;
  // Drawdown spans shaded peak → recovery (or the curve's end while still underwater).
  const markArea =
    shade && shade.length > 0
      ? {
          silent: true,
          itemStyle: { color: tok("loss-fill", 0.1) },
          data: shade.map((p) => [{ xAxis: p.peakTs }, { xAxis: p.recoveryTs ?? lastTs }]),
        }
      : undefined;
  const option: QktChartOption = {
    grid: qktChartGrid,
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const first = (params as { value: [number, number] }[])[0];
        if (!first) return "";
        return tipHtml(`${tsShort(first.value[0])} UTC`, { text: money(first.value[1]) }, []);
      },
    },
    xAxis: { type: "time", ...qktXAxis },
    yAxis: { type: "value", scale: true, splitNumber: 4, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => axisTick(v) } },
    series: [
      {
        name: "equity",
        type: "line",
        showSymbol: false,
        smooth: false,
        data: points.map((p) => [p.ts, p.equity]),
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        areaStyle: areaFade(color),
        markArea,
      },
    ],
  };
  return <EChart option={option} height={height} label="Equity over time" />;
}

export interface ComparisonSeries {
  /** The series' name in the legend and tooltip: a strategy id, or an account's name. */
  name: string;
  color: string;
  points: { ts: number; pct: number }[];
}

/** Normalized (% from first snapshot) curves so strategies or accounts with different capital (or currency) compare fairly. */
export function ComparisonChart({ series, height = 320, label = "Strategy equity, percent change from each first point" }: {
  series: ComparisonSeries[]; height?: number | `${number}%`; label?: string;
}) {
  const narrow = useNarrowChart();
  const active = series.filter((s) => s.points.length > 0);
  if (active.length === 0) return empty;
  const below = qktBottomLegend();
  const option: QktChartOption = {
    color: active.map((s) => s.color),
    grid: narrow ? { ...qktChartGrid, left: 46, top: 12, bottom: below.gridBottom } : { ...qktChartGrid, top: 30 },
    legend: narrow ? below.legend : qktLegend(),
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const rows = params as { seriesName: string; value: [number, number] }[];
        const first = rows[0];
        if (!first) return "";
        return tipHtml(
          `${tsShort(first.value[0])} UTC`,
          null,
          rows.map((r) => [r.seriesName, signedPct(r.value[1])]),
        );
      },
    },
    xAxis: { type: "time", ...qktXAxis },
    yAxis: { type: "value", scale: true, splitNumber: 4, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => `${axisTick(v)}%` } },
    series: active.map((s) => ({
      name: s.name,
      type: "line",
      showSymbol: false,
      smooth: false,
      data: s.points.map((p) => [p.ts, p.pct]),
      lineStyle: { width: 2 },
    })),
  };
  return <EChart option={option} height={height} label={label} />;
}

/** Underwater (drawdown %) area: 0 along the top, dips when equity sits below its running peak. */
export function UnderwaterChart({ points, height = 180 }: { points: EquityPoint[]; height?: number }) {
  let peak = -Infinity;
  const data = points.map((p) => {
    peak = Math.max(peak, p.equity);
    return [p.ts, peak > 0 ? -((peak - p.equity) / peak) * 100 : 0];
  });
  if (data.length === 0) return empty;
  const color = chartColors.loss;
  const option: QktChartOption = {
    grid: { ...qktChartGrid, top: 18 },
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const first = (params as { value: [number, number] }[])[0];
        if (!first) return "";
        return tipHtml(`${tsShort(first.value[0])} UTC`, { text: `${pctValue(Math.abs(first.value[1]))} below peak`, tone: first.value[1] < 0 ? "loss" : "flat" }, []);
      },
    },
    xAxis: { type: "time", ...qktXAxis },
    yAxis: { type: "value", max: 0, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => `${axisTick(v)}%` } },
    series: [
      {
        name: "drawdown",
        type: "line",
        showSymbol: false,
        smooth: false,
        data,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        areaStyle: { color: tok("loss-fill", 0.18) },
      },
    ],
  };
  return <EChart option={option} height={height} label="Drawdown below the running equity peak" />;
}
