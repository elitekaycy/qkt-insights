import type { DrawdownPeriod, EquityPoint } from "../api";
import { compact, money } from "../format";
import { chartColors, EChart, qktChartAxis, qktChartGrid, qktChartTooltip, qktInsideZoom, type QktChartOption } from "./EChart";

function timeFmt(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function EquityChart({ points, shade, height = 260 }: { points: EquityPoint[]; shade?: DrawdownPeriod[]; height?: number }) {
  if (points.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-faint">No equity snapshots yet</div>;
  }
  const color = chartColors.primary;
  const lastTs = points[points.length - 1]!.ts;
  // Drawdown spans shaded peak → recovery (or the curve's end while still underwater).
  const markArea = shade && shade.length > 0
    ? {
        silent: true,
        itemStyle: { color: "rgba(255,107,107,0.10)" },
        data: shade.map((p) => [{ xAxis: p.peakTs }, { xAxis: p.recoveryTs ?? lastTs }]),
      }
    : undefined;
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: qktChartGrid,
    tooltip: {
      ...qktChartTooltip(),
      trigger: "axis",
      formatter: (params: unknown) => {
        const rows = params as { value: [number, number] }[];
        const first = rows[0];
        if (!first) return "";
        return `${timeFmt(first.value[0])}<br/>equity ${money(first.value[1])}`;
      },
    },
    dataZoom: qktInsideZoom(),
    xAxis: { type: "time", ...qktChartAxis },
    yAxis: { type: "value", scale: true, splitNumber: 4, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    series: [
      {
        name: "equity",
        type: "line",
        showSymbol: false,
        smooth: false,
        data: points.map((p) => [p.ts, p.equity]),
        lineStyle: { color, width: 2 },
        areaStyle: { color, opacity: 0.07 },
        markArea,
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

export interface ComparisonSeries {
  strategyId: string;
  color: string;
  points: { ts: number; pct: number }[];
}

/** Normalized (% from first snapshot) curves so strategies with different capital compare fairly. */
export function ComparisonChart({ series, height = 320 }: { series: ComparisonSeries[]; height?: number | `${number}%` }) {
  const active = series.filter((s) => s.points.length > 0);
  if (active.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-faint">No equity snapshots yet</div>;
  }
  const option: QktChartOption = {
    backgroundColor: "transparent",
    color: active.map((s) => s.color),
    grid: qktChartGrid,
    legend: {
      type: "scroll",
      top: 0,
      right: 0,
      textStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
    },
    tooltip: {
      ...qktChartTooltip(),
      trigger: "axis",
      formatter: (params: unknown) => {
        const rows = params as { seriesName: string; value: [number, number]; color: string }[];
        const first = rows[0];
        if (!first) return "";
        return [
          timeFmt(first.value[0]),
          ...rows.map((r) => `<span style="color:${r.color}">●</span> ${r.seriesName} ${r.value[1].toFixed(2)}%`),
        ].join("<br/>");
      },
    },
    dataZoom: qktInsideZoom(),
    xAxis: { type: "time", ...qktChartAxis },
    yAxis: { type: "value", scale: true, splitNumber: 4, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => `${compact(v)}%` } },
    series: active.map((s) => ({
      name: s.strategyId,
      type: "line",
      showSymbol: false,
      smooth: false,
      data: s.points.map((p) => [p.ts, p.pct]),
      lineStyle: { width: 2 },
    })),
  };
  return <EChart option={option} height={height} />;
}

/** Underwater (drawdown %) area: 0 along the top, dips when equity sits below its running peak. */
export function UnderwaterChart({ points, height = 180 }: { points: EquityPoint[]; height?: number }) {
  let peak = -Infinity;
  const data = points.map((p) => {
    peak = Math.max(peak, p.equity);
    return [p.ts, peak > 0 ? -((peak - p.equity) / peak) * 100 : 0];
  });
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-faint">No equity snapshots yet</div>;
  }
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: { ...qktChartGrid, top: 18 },
    tooltip: {
      ...qktChartTooltip(),
      trigger: "axis",
      formatter: (params: unknown) => {
        const rows = params as { value: [number, number] }[];
        const first = rows[0];
        if (!first) return "";
        return `${timeFmt(first.value[0])}<br/>drawdown ${Math.abs(first.value[1]).toFixed(2)}%`;
      },
    },
    dataZoom: qktInsideZoom(),
    xAxis: { type: "time", ...qktChartAxis },
    yAxis: { type: "value", max: 0, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: "{value}%" } },
    series: [
      {
        name: "drawdown",
        type: "line",
        showSymbol: false,
        smooth: false,
        data,
        lineStyle: { color: "#ff6b6b", width: 2 },
        areaStyle: { color: "#ff6b6b", opacity: 0.18 },
      },
    ],
  };
  return <EChart option={option} height={height} />;
}
