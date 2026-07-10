import { useId } from "react";

/** Tiny inline equity curve for cards with no charting dependency. */
export function Sparkline({ points, height = 44 }: { points: { ts: number; equity: number }[]; height?: number }) {
  const gradientId = useId().replace(/:/g, "");
  if (points.length < 2) return <div style={{ height }} />;

  const up = points[points.length - 1]!.equity >= points[0]!.equity;
  const color = up ? "var(--color-up)" : "var(--color-down)";
  const width = 160;
  const svgHeight = 44;
  const equities = points.map((point) => point.equity);
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  const span = max - min || 1;
  const last = points.length - 1;

  const coords = points.map((point, index) => {
    const x = last === 0 ? 0 : (index / last) * width;
    const y = svgHeight - ((point.equity - min) / span) * (svgHeight - 4) - 2;
    return [x, y] as const;
  });

  const line = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${width},${svgHeight} L0,${svgHeight} Z`;

  return (
    <svg
      aria-hidden="true"
      className="block w-full overflow-visible"
      focusable="false"
      preserveAspectRatio="none"
      style={{ height }}
      viewBox={`0 0 ${width} ${svgHeight}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
