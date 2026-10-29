import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, CustomChart, EffectScatterChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { axisTick } from "../format";
import { useTheme } from "../theme";

// Only what the dashboard draws: a third of the full ECharts build.
echarts.use([
  LineChart,
  BarChart,
  CandlestickChart,
  ScatterChart,
  EffectScatterChart,
  HeatmapChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);

export type QktChartOption = {
  [key: string]: unknown;
  tooltip?: Record<string, unknown> | Array<Record<string, unknown>>;
};

/*
 * Colours in chart options are written as CSS token references, e.g. "var(--color-gain-fill)", or
 * with an alpha, "var(--color-gain-fill) / 0.18". The canvas cannot read CSS, so the host resolves
 * them against the active theme before every setOption and again when the theme flips; tooltip HTML
 * is DOM and uses the same var() strings natively.
 */
const TOKEN = /^var\((--[\w-]+)\)(?: \/ ([\d.]+))?$/;

/** A theme colour for a chart option, optionally with an alpha. */
export function tok(name: string, alpha?: number): string {
  return alpha == null ? `var(--color-${name})` : `var(--color-${name}) / ${alpha}`;
}

export const chartColors = {
  primary: tok("s1"),
  gain: tok("gain-fill"),
  loss: tok("loss-fill"),
  gainInk: tok("gain"),
  lossInk: tok("loss"),
  muted: tok("faint"),
  warn: tok("warn"),
  axis: tok("axis"),
  grid: tok("grid"),
  /** The validated categorical set, for comparison lines and stacked parts. */
  series: [tok("s1"), tok("s2"), tok("s3"), tok("s4"), tok("s5")],
} as const;

const FONT = "Inter, system-ui, -apple-system, sans-serif";

function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1]!.split(",").map((x) => x.trim());
    return `rgba(${r},${g},${b},${Number(a) * alpha})`;
  }
  return color;
}

/** Deep copy of an option with every token string replaced by the active theme's colour. */
function resolveTokens<T>(value: T, read: (name: string) => string): T {
  const cache = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = TOKEN.exec(v);
      if (!m) return v;
      let out = cache.get(v);
      if (out == null) {
        const base = read(m[1]!) || "#888888";
        out = m[2] != null ? withAlpha(base, Number(m[2])) : base;
        cache.set(v, out);
      }
      return out;
    }
    if (Array.isArray(v)) {
      // long numeric series dominate; skip them without allocating
      if (v.length > 0 && typeof v[0] === "number") return v;
      return v.map(walk);
    }
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export const qktChartGrid = { left: 48, right: 12, top: 14, bottom: 24, containLabel: false };

const NARROW = "(max-width: 639px)";

/** True below Tailwind's `sm` breakpoint. Charts use it to trade legend/label
 *  density for plot width — the same option object cannot serve both a phone
 *  and a desktop pane. */
export function useNarrowChart(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(NARROW).matches));
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

const LEGEND_TEXT = { color: tok("body"), fontFamily: FONT, fontSize: 11 };

/** Compact legend at the top right, the journal's placement. */
export function qktLegend() {
  return { type: "scroll" as const, top: 0, right: 0, itemWidth: 12, itemHeight: 8, icon: "roundRect", textStyle: LEGEND_TEXT, pageTextStyle: LEGEND_TEXT };
}

/** Legend under the plot instead of over it; the grid gives the row back. */
export function qktBottomLegend() {
  return {
    legend: { type: "scroll" as const, bottom: 0, left: "center" as const, itemWidth: 12, itemHeight: 8, icon: "roundRect", textStyle: LEGEND_TEXT, pageTextStyle: LEGEND_TEXT },
    gridBottom: 58,
  };
}

const AXIS_LABEL = { color: tok("muted"), fontFamily: FONT, fontSize: 11, hideOverlap: true };

/** Value axis: no line, no ticks, faint gridlines; pass `formatter: compact` for money. */
export const qktChartAxis = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: AXIS_LABEL,
  nameTextStyle: { color: tok("muted"), fontFamily: FONT, fontSize: 11 },
  splitLine: { lineStyle: { color: tok("grid"), type: "solid" as const } },
};

/** Category/time axis: one quiet baseline, no ticks, no split lines. */
export const qktXAxis = {
  axisLine: { show: true, lineStyle: { color: tok("axis") } },
  axisTick: { show: false },
  axisLabel: AXIS_LABEL,
  nameTextStyle: { color: tok("muted"), fontFamily: FONT, fontSize: 11 },
  splitLine: { show: false },
};

/** Dashed zero rule for signed charts. */
export function zeroLine() {
  return { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: tok("axis"), type: "dashed" as const, width: 1 }, data: [{ yAxis: 0 }] };
}

/** Area fill from the line colour to transparent, for a single primary series. */
export function areaFade(color: string) {
  const name = TOKEN.exec(color)?.[1];
  const at = (a: number) => (name ? `var(${name}) / ${a}` : color);
  return { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: at(0.18) }, { offset: 1, color: at(0) }] } };
}

export function qktChartTooltip(): Record<string, unknown> {
  return {
    trigger: "axis",
    backgroundColor: tok("well"),
    borderColor: tok("line-strong"),
    borderWidth: 1,
    padding: [8, 10],
    confine: true,
    transitionDuration: 0.1,
    axisPointer: { type: "line", lineStyle: { color: tok("axis") }, shadowStyle: { color: tok("hover") } },
    extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.3);font-variant-numeric:tabular-nums",
    textStyle: { color: tok("bright"), fontFamily: FONT, fontSize: 12 },
  };
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Tooltip body in the journal's shape: a muted title (the date, with its zone), one exact
 * headline figure in its tone, aligned key/value rows, and an optional hint naming what a click does.
 * `headline.tone` colours the figure; pass text already formatted (glyph and sign included).
 */
export function tipHtml(
  title: string,
  headline: { text: string; tone?: "gain" | "loss" | "flat" } | null,
  rows: Array<[string, string]>,
  hint?: string,
): string {
  const color = headline?.tone === "gain" ? "var(--color-gain)" : headline?.tone === "loss" ? "var(--color-loss)" : "var(--color-bright)";
  const head = headline ? `<div style="font-size:15px;font-weight:650;margin:2px 0 4px;color:${color}">${esc(headline.text)}</div>` : "";
  const body = rows
    .map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:var(--color-muted)">${esc(k)}</span><b style="font-weight:600">${esc(v)}</b></div>`)
    .join("");
  const foot = hint ? `<div style="margin-top:6px;color:var(--color-muted);font-size:11px">${esc(hint)}</div>` : "";
  return `<div style="min-width:170px"><div style="color:var(--color-muted);font-size:11px">${esc(title)}</div>${head}${body}${foot}</div>`;
}

/** Charts with at least this many points get the zoom slider under the plot. */
const SLIDER_MIN_POINTS = 40;
const INSIDE_ID = "qkt-inside-zoom";

type AxisLike = { type?: string } | undefined;
const ORDERED = new Set(["line", "bar", "candlestick"]);
const MARKERS = new Set(["scatter", "effectScatter"]);

function zoomablePoints(option: QktChartOption): number {
  const x = (Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis) as AxisLike;
  if (!x || (x.type !== "time" && x.type !== "category" && x.type !== "value")) return 0;
  const series = (Array.isArray(option.series) ? option.series : [option.series]) as Array<{ type?: string; data?: unknown[] } | undefined>;
  // a timeline is ordered line/bar/candlestick series, with point markers over it at most;
  // scatter alone, heatmap and boxplot axes are not one
  const ordered = series.filter((s) => s?.type === "line" || s?.type === "bar" || s?.type === "candlestick");
  if (ordered.length === 0 || series.some((s) => !ORDERED.has(s?.type ?? "") && !MARKERS.has(s?.type ?? ""))) return 0;
  return Math.max(0, ...ordered.map((s) => s?.data?.length ?? 0));
}

/**
 * Adds the journal's zoom to a chart with an x axis: drag to pan, wheel to zoom (the host gates the
 * wheel), and a slider under the plot once there are enough points to need it.
 */
function withZoom(option: QktChartOption, points: number): QktChartOption {
  if (option.dataZoom !== undefined || points < 2) return option;
  const inside = { id: INSIDE_ID, type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false, preventDefaultMouseMove: false, throttle: 40 };
  if (points < SLIDER_MIN_POINTS) return { ...option, dataZoom: [inside] };
  const grid = (option.grid ?? qktChartGrid) as Record<string, unknown>;
  const bottom = typeof grid.bottom === "number" ? grid.bottom : 24;
  return {
    ...option,
    grid: { ...grid, bottom: bottom + 30 },
    dataZoom: [
      inside,
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        height: 18,
        bottom: Math.max(4, bottom - 18),
        borderColor: "transparent",
        backgroundColor: tok("raised"),
        fillerColor: tok("accent-soft"),
        handleSize: "110%",
        handleStyle: { color: tok("well"), borderColor: tok("ctl") },
        moveHandleStyle: { color: tok("ctl") },
        dataBackground: { lineStyle: { color: tok("axis") }, areaStyle: { color: tok("grid") } },
        selectedDataBackground: { lineStyle: { color: tok("accent-hi") }, areaStyle: { color: tok("accent-soft") } },
        textStyle: { color: tok("muted"), fontSize: 10 },
        brushSelect: false,
        labelFormatter: "",
      },
    ],
  };
}

/** Value axes print compact numbers with a true minus unless the chart chose its own labels. */
function withAxisDefaults(option: QktChartOption): QktChartOption {
  const fix = (axis: unknown): unknown => {
    if (Array.isArray(axis)) return axis.map(fix);
    const a = axis as { type?: string; axisLabel?: { formatter?: unknown } } | undefined;
    if (!a || a.type !== "value" || a.axisLabel?.formatter !== undefined) return axis;
    return { ...a, axisLabel: { ...AXIS_LABEL, ...a.axisLabel, formatter: (v: number) => axisTick(v) } };
  };
  return { ...option, xAxis: fix(option.xAxis), yAxis: fix(option.yAxis) };
}

const COARSE = "(pointer: coarse)";

/**
 * ECharts host. Resolves theme tokens, adds the zoom contract, and keeps the page scrollable: the
 * wheel zooms only after the chart is clicked (focused) or while Ctrl/⌘ is held, and on touch
 * screens panning starts only once the chart is tapped. A reset button appears while zoomed.
 */
export function EChart({
  option,
  height = 260,
  label,
  zoom = true,
  onAxisClick,
  onZoom,
  onItemClick,
  focus,
}: {
  option: QktChartOption;
  height?: number | `${number}%`;
  /** Accessible description of what the chart shows. */
  label?: string;
  /** Set false for charts whose x axis should never zoom. */
  zoom?: boolean;
  /**
   * A click anywhere in the plot: the x value under the pointer (a category index, or a time),
   * so the whole column is the target, not only the bar or point.
   */
  onAxisClick?: (x: number) => void;
  /** The visible share of the x axis after a zoom or pan, in percent; null when reset. */
  onZoom?: (window: { start: number; end: number } | null) => void;
  /** A click on one data item (a marker), by series and index. */
  onItemClick?: (item: { seriesIndex: number; dataIndex: number }) => void;
  /** Emphasises one data item and opens the tooltip at it, e.g. while its legend row is hovered. */
  focus?: { seriesIndex: number; dataIndex: number } | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  const handlers = useRef({ onAxisClick, onZoom, onItemClick });
  handlers.current = { onAxisClick, onZoom, onItemClick };

  // charts that bring their own dataZoom keep it; the host only adds the default contract
  const points = zoom && option.dataZoom === undefined ? zoomablePoints(option) : 0;
  const zoomable = points >= 2;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = c;
    c.on("datazoom", () => {
      const z = (c.getOption() as { dataZoom?: Array<{ start?: number; end?: number }> }).dataZoom?.[0];
      const on = z != null && ((z.start ?? 0) > 0.5 || (z.end ?? 100) < 99.5);
      setZoomed(on);
      handlers.current.onZoom?.(on ? { start: z!.start ?? 0, end: z!.end ?? 100 } : null);
    });
    c.on("click", (e: { seriesIndex?: number; dataIndex?: number }) => {
      if (e.seriesIndex != null && e.dataIndex != null) handlers.current.onItemClick?.({ seriesIndex: e.seriesIndex, dataIndex: e.dataIndex });
    });
    c.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      const click = handlers.current.onAxisClick;
      if (!click || c.isDisposed()) return;
      const at = [e.offsetX, e.offsetY];
      if (!c.containPixel({ gridIndex: 0 }, at)) return;
      const x = c.convertFromPixel({ xAxisIndex: 0 }, at) as number | number[];
      const v = Array.isArray(x) ? x[0] : x;
      if (v != null && Number.isFinite(v)) click(v);
    });
    // a hidden or collapsing container reports 0x0: resizing then throws inside zrender
    const ro = new ResizeObserver(() => {
      if (node.clientWidth > 0 && node.clientHeight > 0 && !c.isDisposed()) {
        try {
          c.resize();
        } catch {
          // mid-collapse; the next observation fixes it
        }
      }
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c || c.isDisposed()) return;
    const read = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const base: QktChartOption = {
      animation: !reduce,
      animationDuration: 350,
      animationDurationUpdate: 300,
      animationEasing: "cubicOut",
      animationEasingUpdate: "cubicOut",
      backgroundColor: "transparent",
      textStyle: { color: tok("muted"), fontFamily: FONT },
      ...withAxisDefaults(zoomable ? withZoom(option, points) : option),
    };
    c.setOption(resolveTokens(base, read), { notMerge: true, lazyUpdate: true });
    setZoomed(false);
    handlers.current.onZoom?.(null);
  }, [option, theme, zoomable, points]);

  useEffect(() => {
    const c = chart.current;
    // only charts that take a focus manage it; others keep ECharts' own hover state
    if (!c || c.isDisposed() || focus === undefined) return;
    if (!focus) {
      c.dispatchAction({ type: "downplay" });
      c.dispatchAction({ type: "hideTip" });
      return;
    }
    c.dispatchAction({ type: "highlight", seriesIndex: focus.seriesIndex, dataIndex: focus.dataIndex });
    c.dispatchAction({ type: "showTip", seriesIndex: focus.seriesIndex, dataIndex: focus.dataIndex });
    return () => {
      if (!c.isDisposed()) c.dispatchAction({ type: "downplay", seriesIndex: focus.seriesIndex, dataIndex: focus.dataIndex });
    };
  }, [focus === undefined, focus?.seriesIndex, focus?.dataIndex, option, theme]);

  // touch screens: the chart pans only after a tap, so a swipe over it still scrolls the page
  useEffect(() => {
    const c = chart.current;
    if (!c || c.isDisposed() || !zoomable) return;
    const coarse = window.matchMedia?.(COARSE).matches ?? false;
    c.setOption({ dataZoom: [{ id: INSIDE_ID, disabled: coarse && !focused }] }, { lazyUpdate: true });
  }, [focused, zoomable, option, theme]);

  // the wheel belongs to the page until the chart is focused or Ctrl/⌘ is held
  useEffect(() => {
    const node = host.current;
    if (!node || !zoomable) return;
    const onWheel = (e: WheelEvent) => {
      if (!focusedRef.current && !e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    node.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => node.removeEventListener("wheel", onWheel, { capture: true });
  }, [zoomable]);

  const reset = () => {
    chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    setZoomed(false);
    onZoom?.(null);
  };

  return (
    <div
      ref={host}
      tabIndex={zoomable ? 0 : undefined}
      role="img"
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.currentTarget as HTMLDivElement).blur();
      }}
      className={`group/chart relative rounded-lg outline-none ${zoomable && focused ? "ring-1 ring-line-strong" : ""} ${onAxisClick ? "cursor-pointer" : ""}`}
    >
      <div ref={el} style={{ height, width: "100%", minHeight: typeof height === "string" ? 220 : undefined }} />
      {zoomable && (
        <div className="pointer-events-none absolute right-1 top-0 flex items-center gap-2 text-[11px] text-muted">
          <span className={`hidden sm:inline ${focused ? "" : "opacity-0 transition-opacity group-hover/chart:opacity-100"}`}>
            {focused ? "scroll to zoom · drag to pan · Esc to release" : "click to zoom · or Ctrl/⌘ + scroll"}
          </span>
          {zoomed && (
            <button
              type="button"
              onClick={reset}
              className="pointer-events-auto h-6 rounded-md border border-line-strong bg-panel px-2 text-[11px] font-medium text-bright transition hover:bg-raised"
            >
              Reset zoom
            </button>
          )}
        </div>
      )}
    </div>
  );
}
