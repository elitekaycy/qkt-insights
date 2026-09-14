import type { ViewDay } from "../api";
import { chartColors, EChart, qktBottomLegend, qktChartAxis, qktChartGrid, qktChartTooltip, useNarrowChart, type QktChartOption } from "./EChart";

const MONO = "JetBrains Mono, ui-monospace, monospace";

/** Views per UTC day as bars, unique visitors that day as a line. Counts, never smoothed. */
export function ViewsChart({ days, height = 240 }: { days: ViewDay[]; height?: number }) {
  const narrow = useNarrowChart();
  if (days.every((d) => d.views === 0)) {
    return (
      <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-faint">
        No views in this range yet. Views appear here once someone opens a shared link.
      </div>
    );
  }
  const below = qktBottomLegend(true);
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: { ...qktChartGrid, left: 42, top: narrow ? 12 : 28, bottom: below.gridBottom },
    legend: below.legend,
    tooltip: {
      ...qktChartTooltip(),
      trigger: "axis",
      formatter: (params: unknown) => {
        const rows = params as Array<{ axisValue: string; seriesName: string; value: number; color: string }>;
        const first = rows[0];
        if (!first) return "";
        const lines = rows.map((r) => `<span style="color:${r.color}">&#9679;</span> ${r.seriesName} <span style="font-family:${MONO}">${r.value}</span>`);
        return [`${first.axisValue} UTC`, ...lines].join("<br/>");
      },
    },
    xAxis: { type: "category", data: days.map((d) => d.day), ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: string) => v.slice(5) } },
    yAxis: { type: "value", minInterval: 1, splitNumber: 4, ...qktChartAxis },
    series: [
      { name: "Views", type: "bar", data: days.map((d) => d.views), itemStyle: { color: chartColors.primary, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 28 },
      { name: "Unique visitors", type: "line", data: days.map((d) => d.visitors), symbolSize: 5, lineStyle: { color: chartColors.accent, width: 2 }, itemStyle: { color: chartColors.accent } },
    ],
  };
  return <EChart option={option} height={height} />;
}
