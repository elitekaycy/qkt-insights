import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EquityPoint } from "../api";

const AXIS = { stroke: "#52525b", fontSize: 11 };

function timeFmt(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function EquityChart({ points, height = 260 }: { points: EquityPoint[]; height?: number }) {
  if (points.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-zinc-600">No equity snapshots yet</div>;
  }
  const up = points[points.length - 1]!.equity >= points[0]!.equity;
  const color = up ? "#34d399" : "#f87171";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={timeFmt} tick={AXIS} tickLine={false} axisLine={false} minTickGap={60} />
        <YAxis domain={["auto", "auto"]} tick={AXIS} tickLine={false} axisLine={false} width={70} />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(v) => timeFmt(Number(v))}
          formatter={(value) => [Number(value).toFixed(2), "equity"]}
        />
        <Area type="monotone" dataKey="equity" stroke={color} strokeWidth={1.5} fill="url(#eq)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface ComparisonSeries {
  strategyId: string;
  color: string;
  points: { ts: number; pct: number }[];
}

/** Normalized (% from first snapshot) curves so strategies with different capital compare fairly. */
export function ComparisonChart({ series, height = 320 }: { series: ComparisonSeries[]; height?: number }) {
  const merged = new Map<number, Record<string, number>>();
  for (const s of series) {
    for (const p of s.points) {
      const row = merged.get(p.ts) ?? {};
      row[s.strategyId] = p.pct;
      merged.set(p.ts, row);
    }
  }
  const data = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([t, row]) => ({ ts: t, ...row }));
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-zinc-600">No equity snapshots yet</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={timeFmt} tick={AXIS} tickLine={false} axisLine={false} minTickGap={60} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(v) => timeFmt(Number(v))}
          formatter={(value: unknown, name) => [`${Number(value).toFixed(2)}%`, name]}
        />
        {series.map((s) => (
          <Line key={s.strategyId} type="monotone" dataKey={s.strategyId} stroke={s.color} strokeWidth={1.5} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
