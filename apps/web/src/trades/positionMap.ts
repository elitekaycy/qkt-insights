import { axisTick, duration, MINUS, signedMoney, tsShort } from "../format";
import { chartColors, qktChartAxis, qktChartGrid, qktChartTooltip, qktXAxis, tipHtml, tok, zeroLine, type QktChartOption } from "../components/EChart";
import type { PathMark, PositionPath } from "./data";
import { preciseClock, px } from "./format";

/*
 * The position map: what the drawer's chart draws from a position's path. The moments that
 * matter (entry, the best and the worst mark, the latest mark or the exit), the figures between
 * them, and the ECharts option for the price candles or the P&L line. Pure, so the numbers and
 * the encoding are tested without a canvas.
 */

export type MomentKey = "entry" | "best" | "worst" | "now" | "exit";
export type PathView = "price" | "pnl";

export interface Moment {
  key: MomentKey;
  label: string;
  ts: number;
  price: number | null;
  /** Mark P&L excluding swap; the exit's is the realized net after costs; null at entry. */
  pnl: number | null;
  /** Time from the entry to this moment. */
  afterEntryMs: number | null;
}

const BUCKET_LABEL: Record<number, string> = { 60_000: "1m", 300_000: "5m", 900_000: "15m", 1_800_000: "30m", 3_600_000: "1h", 14_400_000: "4h", 86_400_000: "1d" };

/** "15m" for a candle size in ms. */
export function bucketLabel(ms: number): string {
  return BUCKET_LABEL[ms] ?? duration(ms);
}

/**
 * The moments in time order. The best and the worst are marks; when no mark went below (above)
 * entry the worst (best) still shows where it bottomed (topped). `realized` is the closed trip's
 * net, which the exit carries.
 */
export function moments(path: PositionPath, realized: number | null): Moment[] {
  const entryTs = path.entry?.ts ?? null;
  const after = (ts: number) => (entryTs == null ? null : ts - entryTs);
  const mark = (key: MomentKey, label: string, m: PathMark | null): Moment[] =>
    m ? [{ key, label, ts: m.ts, price: m.price, pnl: m.pnl, afterEntryMs: after(m.ts) }] : [];
  const out: Moment[] = [];
  if (path.entry) out.push({ key: "entry", label: "Entry", ts: path.entry.ts, price: path.entry.price, pnl: null, afterEntryMs: 0 });
  out.push(...mark("best", "Best", path.best));
  // one mark is both the best and the worst: show it once
  if (path.worst && !(path.best && path.worst.ts === path.best.ts)) out.push(...mark("worst", "Worst", path.worst));
  if (path.status === "closed" && path.exit) {
    out.push({ key: "exit", label: "Exit", ts: path.exit.ts, price: path.exit.price, pnl: realized, afterEntryMs: after(path.exit.ts) });
  } else if (path.last) {
    out.push(...mark("now", "Latest", path.last));
  }
  return out.sort((a, b) => a.ts - b.ts || ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

const ORDER: MomentKey[] = ["entry", "best", "worst", "now", "exit"];

/** A stop or target level and whether the chart draws it: levels far outside the path would flatten it. */
export interface Level {
  key: "stop" | "target";
  price: number;
  inView: boolean;
}

/** The price range the chart shows: the candles, the entry and every moment, padded. */
export function priceRange(path: PositionPath): { min: number; max: number } | null {
  const values: number[] = [];
  for (const c of path.candles) values.push(c.l, c.h);
  for (const v of [path.entry?.price, path.exit?.price, path.best?.price, path.worst?.price, path.last?.price]) if (v != null && Number.isFinite(v)) values.push(v);
  if (values.length === 0) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) * 0.0005 || 1;
  // room above and below the extremes for the markers' labels
  return { min: lo - span * 0.16, max: hi + span * 0.16 };
}

/** The P&L axis range: the line and the moments, padded so their labels fit; null without marks. */
function pnlRange(path: PositionPath, realized: number | null): { min: number; max: number } | null {
  const values = [0, ...path.pnl.map((p) => p.pnl)];
  if (path.pnl.length === 0) return null;
  if (realized != null && path.status === "closed") values.push(realized);
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  return { min: lo - span * 0.16, max: hi + span * 0.16 };
}

/** A level is drawn when it lies within half the path's span of the path; otherwise it is listed as off the chart. */
export function levels(path: PositionPath): Level[] {
  const range = priceRange(path);
  const out: Level[] = [];
  for (const [key, price] of [["stop", path.stopPrice], ["target", path.targetPrice]] as const) {
    if (price == null || !Number.isFinite(price) || price <= 0) continue;
    const reach = range ? (range.max - range.min) * 0.5 : 0;
    out.push({ key, price, inView: range != null && price >= range.min - reach && price <= range.max + reach });
  }
  return out;
}

/** The marker of each moment: a shape as well as a colour, so neither carries the meaning alone. */
const MOMENT_STYLE: Record<MomentKey, { symbol: string; rotate: number; color: string; size: number }> = {
  entry: { symbol: "circle", rotate: 0, color: tok("accent-hi"), size: 11 },
  best: { symbol: "triangle", rotate: 0, color: tok("gain-fill"), size: 13 },
  worst: { symbol: "triangle", rotate: 180, color: tok("loss-fill"), size: 13 },
  now: { symbol: "diamond", rotate: 0, color: tok("bright"), size: 13 },
  exit: { symbol: "rect", rotate: 0, color: tok("bright"), size: 10 },
};

/** Index of each moment in the marker series, for focusing one from outside the chart. */
export function markerIndex(ms: Moment[], view: PathView): Map<MomentKey, number> {
  const out = new Map<MomentKey, number>();
  plotted(ms, view).forEach((m, i) => out.set(m.key, i));
  return out;
}

/** Moments the view can place: the price view needs a price, the P&L view a P&L (entry is 0). */
function plotted(ms: Moment[], view: PathView): Array<Moment & { y: number }> {
  return ms.flatMap((m) => {
    const y = view === "price" ? m.price : m.key === "entry" ? 0 : m.pnl;
    return y == null || !Number.isFinite(y) ? [] : [{ ...m, y }];
  });
}

/** The P&L line with a break (null) across every stretch without marks. */
export function pnlLine(path: PositionPath): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  let gap = 0;
  const spans = path.gapSpans;
  for (const p of path.pnl) {
    while (gap < spans.length && spans[gap]!.to <= p.ts) {
      const g = spans[gap]!;
      // the break sits inside the gap: the points either side are its edges
      if (out.length > 0 && out.at(-1)![0] <= g.from) out.push([g.from + 1, null]);
      gap++;
    }
    out.push([p.ts, p.pnl]);
  }
  return out;
}

export interface PathOptionInput {
  path: PositionPath;
  moments: Moment[];
  view: PathView;
  digits: number;
  narrow: boolean;
}

/**
 * The shaded stretches: no marks at all (the poll or the collector was down), and an unchanged
 * price for an hour or more (a closed market or no quotes). Wide ones carry a short label.
 */
export function shadedSpans(path: PositionPath, xMin: number, xMax: number, narrow: boolean): Record<string, unknown> | undefined {
  const width = Math.max(xMax - xMin, 1);
  const area = (g: { from: number; to: number }, color: string, text: string) => [
    {
      xAxis: g.from,
      itemStyle: { color },
      label: { show: !narrow && (g.to - g.from) / width >= 0.07, position: "insideTop", formatter: text, color: tok("muted"), fontSize: 10, distance: 4 },
    },
    { xAxis: g.to },
  ];
  const data = [
    ...path.flatSpans.map((g) => area(g, tok("faint", 0.08), "no price change")),
    ...path.gapSpans.map((g) => area(g, tok("faint", 0.18), "no marks")),
  ];
  return data.length > 0 ? { silent: true, data } : undefined;
}

export function pathOption({ path, moments: ms, view, digits, narrow }: PathOptionInput): QktChartOption {
  const bucket = path.bucketMs;
  const points = plotted(ms, view);
  const range = priceRange(path);
  const exitPnl = ms.find((m) => m.key === "exit")?.pnl ?? null;
  const yRange = view === "price" ? range : pnlRange(path, exitPnl);
  const priceLines = view === "price" ? priceLevelLines(path, digits, narrow) : [];
  const yMoney = (v: number) => axisTick(v);
  const axisDigits = range ? priceAxisDigits(range.max - range.min, digits) : digits;
  const yPrice = (v: number) => priceTick(v, axisDigits);
  const yLabelWidth = view === "price" && range ? Math.max(yPrice(range.min).length, yPrice(range.max).length) : 6;

  const xMin = path.entry?.ts ?? path.candles[0]?.t;
  const xMax = (path.status === "closed" ? path.exit?.ts : path.last?.ts) ?? path.candles.at(-1)?.t;
  const pad = xMin != null && xMax != null ? Math.max((xMax - xMin) * 0.03, bucket / 2) : 0;
  const mid = view === "pnl" ? 0 : range ? (range.min + range.max) / 2 : 0;
  const placed = labelPlacements(points, mid, xMin ?? 0, xMax ?? 0);
  const gapArea = shadedSpans(path, xMin ?? 0, xMax ?? 0, narrow);

  const markerLabel = (m: Moment & { y: number }) => {
    if (narrow || m.key === "entry") return { show: false };
    const text = m.key === "exit" ? "Exit" : m.pnl == null ? m.label : `${m.label} ${signedMoney(m.pnl)}`;
    return {
      show: true,
      formatter: text,
      position: placed.get(m.key) ?? "top",
      distance: 6,
      color: tok("bright"),
      fontSize: 11,
      fontWeight: 600,
      backgroundColor: tok("panel", 0.85),
      padding: [2, 5],
      borderRadius: 4,
    };
  };
  const markerData = points.map((m) => {
    const s = MOMENT_STYLE[m.key];
    return {
      name: m.label,
      value: [m.ts, m.y],
      symbol: s.symbol,
      symbolRotate: s.rotate,
      symbolSize: s.size,
      itemStyle: { color: s.color, borderColor: tok("panel"), borderWidth: 1.5 },
      label: markerLabel(m),
    };
  });

  const series: Array<Record<string, unknown>> = [];
  if (view === "price") {
    series.push({
      name: "price",
      type: "candlestick",
      data: path.candles.map((c) => [c.t + bucket / 2, c.o, c.c, c.l, c.h]),
      barMaxWidth: 14,
      barMinWidth: 1,
      // neutral candles: up hollow, down filled; green and red stay for the position's P&L
      itemStyle: { color: tok("panel"), color0: tok("muted"), borderColor: tok("muted"), borderColor0: tok("muted"), borderWidth: 1 },
      emphasis: { itemStyle: { borderColor: tok("bright"), borderColor0: tok("bright") } },
      markLine: priceLines.length > 0 ? { silent: true, symbol: "none", data: priceLines } : undefined,
      markArea: gapArea,
    });
  } else {
    series.push({
      name: "pnl",
      type: "line",
      showSymbol: false,
      smooth: false,
      connectNulls: false,
      step: false,
      data: pnlLine(path),
      lineStyle: { color: chartColors.primary, width: 1.75 },
      itemStyle: { color: chartColors.primary },
      markLine: zeroLine(),
      markArea: gapArea,
    });
  }
  series.push({
    name: "moments",
    type: "scatter",
    z: 5,
    data: markerData,
    emphasis: { scale: 1.45, label: { show: true } },
    cursor: "pointer",
  });

  return {
    grid: { ...qktChartGrid, left: Math.max(44, Math.round(yLabelWidth * 6.6) + 14), right: narrow ? 12 : 64, top: 22 },
    tooltip: {
      ...qktChartTooltip(),
      axisPointer: { type: "cross", label: { show: false }, lineStyle: { color: tok("axis") }, crossStyle: { color: tok("axis") } },
      formatter: (params: unknown) => pathTip(params, { path, moments: ms, view, digits }),
    },
    xAxis: {
      type: "time",
      ...qktXAxis,
      min: xMin != null ? xMin - pad : undefined,
      max: xMax != null ? xMax + pad : undefined,
      axisLabel: { ...qktXAxis.axisLabel, formatter: (v: number) => timeTick(v) },
      splitNumber: narrow ? 3 : 5,
    },
    yAxis: {
      type: "value",
      ...qktChartAxis,
      splitNumber: 4,
      scale: true,
      position: "left",
      min: yRange?.min,
      max: yRange?.max,
      // the range ends are padding, not values: their labels would print odd numbers
      axisLabel: { ...qktChartAxis.axisLabel, formatter: view === "price" ? yPrice : yMoney, showMinLabel: false, showMaxLabel: false },
    },
    series,
  };
}

export type LabelPosition = "top" | "bottom" | "left" | "right";

/**
 * Where each marker's label sits: above a marker in the upper half (from `mid`), below one in the
 * lower half. Two labels on the same side closer than an eighth of the width would collide: the
 * later one moves beside its marker, to the left near the right edge.
 */
export function labelPlacements(points: Array<{ key: MomentKey; ts: number; y: number }>, mid: number, xMin: number, xMax: number): Map<MomentKey, LabelPosition> {
  const out = new Map<MomentKey, LabelPosition>();
  const width = Math.max(xMax - xMin, 1);
  const frac = (ts: number) => (ts - xMin) / width;
  const labelled = points.filter((p) => p.key !== "entry").sort((a, b) => a.ts - b.ts);
  let prev: { ts: number; side: LabelPosition } | null = null;
  for (const p of labelled) {
    let side: LabelPosition = p.y >= mid ? "top" : "bottom";
    if (prev && prev.side === side && frac(p.ts) - frac(prev.ts) < 0.125) side = frac(p.ts) > 0.8 ? "left" : "right";
    out.set(p.key, side);
    prev = { ts: p.ts, side };
  }
  return out;
}

/** A price axis tick, grouped at a fixed number of decimals ("82,000", "1.1150"). */
export function priceTick(v: number, digits: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace("-", MINUS);
}

/** Decimals the price axis needs for its range: enough to tell ticks apart, at most the instrument's. */
export function priceAxisDigits(span: number, digits: number): number {
  if (!(span > 0)) return digits;
  return Math.min(digits, Math.max(0, Math.ceil(-Math.log10(span / 8))));
}

/** A time axis tick (UTC): the day at midnight, the time inside a day ("24 Oct", "06:00"). The tooltip says the full stamp. */
export function timeTick(v: number): string {
  const stamp = tsShort(v);
  return stamp.endsWith(" 00:00") ? stamp.slice(0, -6) : stamp.slice(-5);
}

function priceLevelLines(path: PositionPath, digits: number, narrow: boolean): Array<Record<string, unknown>> {
  const line = (y: number, name: string, color: string, type: "dashed" | "dotted") => ({
    yAxis: y,
    name,
    lineStyle: { color, type, width: 1 },
    label: { show: !narrow, position: "end", formatter: `${name}\n${px(y, digits)}`, color, fontSize: 10, lineHeight: 13 },
  });
  const out: Array<Record<string, unknown>> = [];
  if (path.entry?.price != null) out.push(line(path.entry.price, "entry", tok("accent-hi"), "dashed"));
  for (const l of levels(path)) {
    if (!l.inView) continue;
    out.push(l.key === "stop" ? line(l.price, "stop", tok("loss-fill", 0.85), "dotted") : line(l.price, "target", tok("gain-fill", 0.85), "dotted"));
  }
  return out;
}

interface TipParam { seriesType?: string; seriesName?: string; value?: unknown; axisValue?: number }

/** The tooltip: the candle (or P&L) under the pointer, and any moment inside it, exactly. */
export function pathTip(params: unknown, ctx: { path: PositionPath; moments: Moment[]; view: PathView; digits: number }): string {
  const list = (Array.isArray(params) ? params : [params]) as TipParam[];
  const { path, view, digits } = ctx;
  const bucket = path.bucketMs;
  // pointed at a marker (a moment focused from its card): that moment in full
  const series = new Set(list.map((p) => p.seriesType));
  if (!series.has("candlestick") && !series.has("line")) {
    const marker = list.find((p) => p.seriesType === "scatter");
    const at = (marker?.value as number[] | undefined)?.[0];
    const m = ctx.moments.find((x) => x.ts === at);
    return m ? momentTip(m, digits) : "";
  }
  if (view === "price") {
    const c = list.find((p) => p.seriesType === "candlestick");
    const v = c?.value as number[] | undefined;
    if (!v) return "";
    // the candle is drawn at its middle; its start is what the grid names
    const t = v[0]! - bucket / 2;
    const [o, cl, l, h] = [v[1]!, v[2]!, v[3]!, v[4]!];
    const candle = path.candles.find((x) => x.t === t);
    const rows: Array<[string, string]> = [["Open", px(o, digits)], ["High", px(h, digits)], ["Low", px(l, digits)], ["Close", px(cl, digits)]];
    if (candle) rows.push(["Marks", String(candle.marks)]);
    for (const m of within(ctx.moments, t, t + bucket)) rows.push(momentRow(m, digits));
    return tipHtml(`${tsShort(t)} UTC · ${bucketLabel(bucket)} candle`, null, rows);
  }
  const line = list.find((p) => p.seriesType === "line");
  const v = line?.value as [number, number | null] | undefined;
  if (!v || v[1] == null) return "";
  const t = Math.floor(v[0] / bucket) * bucket;
  const here = within(ctx.moments, t, t + bucket);
  const rows: Array<[string, string]> = here.some((m) => m.ts === v[0]) ? [] : [["At", `${preciseClock(v[0]).slice(0, 8)} UTC`]];
  for (const m of here) rows.push(momentRow(m, digits));
  return tipHtml(`${tsShort(v[0])} UTC`, { text: signedMoney(v[1]), tone: v[1] > 0 ? "gain" : v[1] < 0 ? "loss" : "flat" }, rows, "P&L at the mark, excluding swap");
}

/** One moment's tooltip: its time, its P&L (or the entry price), its price and how long after the entry. */
function momentTip(m: Moment, digits: number): string {
  const headline = m.pnl == null ? { text: px(m.price, digits) } : { text: signedMoney(m.pnl), tone: m.pnl > 0 ? ("gain" as const) : m.pnl < 0 ? ("loss" as const) : ("flat" as const) };
  const rows: Array<[string, string]> = [];
  if (m.pnl != null) rows.push(["Price", px(m.price, digits)]);
  if (m.afterEntryMs != null && m.key !== "entry") rows.push(["After entry", duration(m.afterEntryMs)]);
  const note = m.key === "exit" ? "realized, after costs" : m.key === "entry" ? undefined : "P&L at the mark, excluding swap";
  return tipHtml(`${m.label} · ${tsShort(m.ts)}:${preciseClock(m.ts).slice(6, 8)} UTC`, headline, rows, note);
}

function within(ms: Moment[], from: number, to: number): Moment[] {
  return ms.filter((m) => m.ts >= from && m.ts < to);
}

function momentRow(m: Moment, digits: number): [string, string] {
  const at = `${preciseClock(m.ts).slice(0, 8)}`;
  const value = m.pnl == null ? px(m.price, digits) : `${signedMoney(m.pnl)} @ ${px(m.price, digits)}`;
  return [`${m.label} ${at}`, value];
}
