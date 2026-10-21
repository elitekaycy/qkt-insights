import type { ViewDay } from "../api";
import { count } from "../format";
import { chartColors, EChart, qktBottomLegend, qktChartAxis, qktChartGrid, qktChartTooltip, qktXAxis, tipHtml, useNarrowChart, type QktChartOption } from "./EChart";

/** Views per UTC day as bars, unique visitors that day as a line. Counts, never smoothed. */
export function ViewsChart({ days, height = 240 }: { days: ViewDay[]; height?: number }) {
  const narrow = useNarrowChart();
  if (days.every((d) => d.views === 0)) {
    return (
      <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-muted">
        No views in this range yet. Views appear here once someone opens a shared link.
      </div>
    );
  }
  const below = qktBottomLegend();
  const option: QktChartOption = {
    grid: { ...qktChartGrid, left: 42, top: narrow ? 12 : 28, bottom: below.gridBottom },
    legend: below.legend,
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const rows = params as Array<{ axisValue: string; seriesName: string; value: number }>;
        const first = rows[0];
        if (!first) return "";
        return tipHtml(`${first.axisValue} · UTC day`, null, rows.map((r) => [r.seriesName, count(r.value)]));
      },
    },
    xAxis: { type: "category", data: days.map((d) => d.day), ...qktXAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: string) => v.slice(5) } },
    yAxis: { type: "value", minInterval: 1, splitNumber: 4, ...qktChartAxis },
    series: [
      { name: "Views", type: "bar", data: days.map((d) => d.views), itemStyle: { color: chartColors.primary, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 28 },
      { name: "Unique visitors", type: "line", data: days.map((d) => d.visitors), symbolSize: 5, lineStyle: { color: chartColors.series[1], width: 2 }, itemStyle: { color: chartColors.series[1] } },
    ],
  };
  return <EChart option={option} height={height} />;
}
