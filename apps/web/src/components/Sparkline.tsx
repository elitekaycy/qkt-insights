import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

/** Tiny inline equity curve for cards — no axes, no tooltip, just the shape. */
export function Sparkline({ points, height = 44 }: { points: { ts: number; equity: number }[]; height?: number }) {
  if (points.length < 2) return <div style={{ height }} />;
  const up = points[points.length - 1]!.equity >= points[0]!.equity;
  const color = up ? "var(--color-up)" : "var(--color-down)";
  const id = up ? "spark-up" : "spark-down";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis domain={["dataMin", "dataMax"]} hide />
        <Area type="monotone" dataKey="equity" stroke={color} strokeWidth={1.5} fill={`url(#${id})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
