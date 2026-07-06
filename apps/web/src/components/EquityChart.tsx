import { useEffect, useRef, useState, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EquityPoint } from "../api";

const AXIS = { stroke: "var(--color-faint)", fontSize: 11, fontFamily: "var(--font-mono)" };
const TOOLTIP = {
  background: "var(--color-raised)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: 10,
  fontSize: 12,
  fontFamily: "var(--font-mono)",
};

function timeFmt(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const MIN_POINTS = 5;

/**
 * Time-axis zoom for any chart: mouse wheel zooms around the cursor, and
 * +/−/reset controls fade in on hover. Holds a [start, end] fraction of the
 * full series and hands the visible slice to the render function.
 */
export function ZoomFrame<T>({ data, children }: { data: T[]; children: (visible: T[]) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState<[number, number]>([0, 1]);

  const zoomAt = (factor: number, center: number) =>
    setWin(([a, b]) => {
      const width = Math.min(1, (b - a) * factor);
      if (width >= 1) return [0, 1];
      const focus = a + (b - a) * center;
      let na = focus - width * center;
      let nb = na + width;
      if (na < 0) (na = 0), (nb = width);
      if (nb > 1) (nb = 1), (na = 1 - width);
      return [na, nb];
    });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY > 0 ? 1.25 : 0.8, (e.clientX - rect.left) / rect.width);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const n = data.length;
  const i0 = Math.floor(win[0] * n);
  const i1 = Math.max(i0 + MIN_POINTS, Math.ceil(win[1] * n));
  const visible = n > MIN_POINTS ? data.slice(i0, i1) : data;
  const zoomed = win[0] > 0 || win[1] < 1;

  const button = (label: string, d: string, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-lg border border-line bg-raised/90 p-1.5 text-muted backdrop-blur transition hover:border-line-strong hover:text-body"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </button>
  );

  return (
    <div ref={ref} className="group/zoom relative h-full">
      {children(visible)}
      <div className="absolute right-2 top-1 z-10 flex gap-1.5 opacity-0 transition group-hover/zoom:opacity-100">
        {button("zoom in", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35M11 8v6M8 11h6", () => zoomAt(0.8, 0.5))}
        {button("zoom out", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35M8 11h6", () => zoomAt(1.25, 0.5))}
        {zoomed && button("reset zoom", "M3 12a9 9 0 1 0 3-6.7M3 4v5h5", () => setWin([0, 1]))}
      </div>
      {zoomed && (
        <span className="pointer-events-none absolute left-2 top-1 z-10 rounded-full bg-raised/90 px-2 py-0.5 font-mono text-[10px] font-semibold text-muted backdrop-blur">
          {visible.length} of {n} points
        </span>
      )}
    </div>
  );
}

export function EquityChart({ points, height = 260 }: { points: EquityPoint[]; height?: number }) {
  if (points.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-faint">No equity snapshots yet</div>;
  }
  return (
    <ZoomFrame data={points}>
      {(visible) => {
        const up = visible[visible.length - 1]!.equity >= visible[0]!.equity;
        const color = up ? "var(--color-up)" : "var(--color-down)";
        return (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={visible} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={timeFmt} tick={AXIS} tickLine={false} axisLine={false} minTickGap={60} />
              <YAxis domain={["auto", "auto"]} tick={AXIS} tickLine={false} axisLine={false} width={70} />
              <Tooltip
                contentStyle={TOOLTIP}
                labelFormatter={(v) => timeFmt(Number(v))}
                formatter={(value) => [Number(value).toFixed(2), "equity"]}
              />
              <Area type="monotone" dataKey="equity" stroke={color} strokeWidth={1.5} fill="url(#eq)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        );
      }}
    </ZoomFrame>
  );
}

export interface ComparisonSeries {
  strategyId: string;
  color: string;
  points: { ts: number; pct: number }[];
}

/** Normalized (% from first snapshot) curves so strategies with different capital compare fairly. */
export function ComparisonChart({ series, height = 320 }: { series: ComparisonSeries[]; height?: number | `${number}%` }) {
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
    return <div className="flex h-40 items-center justify-center text-sm text-faint">No equity snapshots yet</div>;
  }
  return (
    <ZoomFrame data={data}>
      {(visible) => (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={visible} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={timeFmt} tick={AXIS} tickLine={false} axisLine={false} minTickGap={60} />
            <YAxis domain={["auto", "auto"]} tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} />
            <Tooltip
              contentStyle={TOOLTIP}
              labelFormatter={(v) => timeFmt(Number(v))}
              formatter={(value: unknown, name) => [`${Number(value).toFixed(2)}%`, name]}
            />
            {series.map((s) => (
              <Line key={s.strategyId} type="monotone" dataKey={s.strategyId} stroke={s.color} strokeWidth={1.5} dot={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ZoomFrame>
  );
}

/** Underwater (drawdown %) area: 0 along the top, dips when equity sits below its running peak. */
export function UnderwaterChart({ points, height = 180 }: { points: EquityPoint[]; height?: number }) {
  let peak = -Infinity;
  const data = points.map((p) => {
    peak = Math.max(peak, p.equity);
    return { ts: p.ts, dd: peak > 0 ? -((peak - p.equity) / peak) * 100 : 0 };
  });
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-faint">No equity snapshots yet</div>;
  }
  return (
    <ZoomFrame data={data}>
      {(visible) => (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={visible} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="uw" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-down)" stopOpacity={0.05} />
                <stop offset="100%" stopColor="var(--color-down)" stopOpacity={0.35} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={timeFmt} tick={AXIS} tickLine={false} axisLine={false} minTickGap={60} />
            <YAxis domain={["dataMin", 0]} tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} />
            <Tooltip
              contentStyle={TOOLTIP}
              labelFormatter={(v) => timeFmt(Number(v))}
              formatter={(value) => [`${Math.abs(Number(value)).toFixed(2)}%`, "drawdown"]}
            />
            <Area type="monotone" dataKey="dd" stroke="var(--color-down)" strokeWidth={1.5} fill="url(#uw)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ZoomFrame>
  );
}
