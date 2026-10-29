/*
 * Equity & risk's defaults as pure functions: which strategy lines to compare before the viewer picks, and which
 * strategy the underwater chart opens on.
 */

/** The ids of the `n` series that moved the most (largest absolute change from first to last point), in input order. */
export function biggestMovers(series: ReadonlyArray<{ id: string; points: ReadonlyArray<{ equity: number }> }>, n = 4): string[] {
  const moved = series
    .filter((s) => s.points.length > 0)
    .map((s) => ({ id: s.id, move: Math.abs(s.points[s.points.length - 1]!.equity - s.points[0]!.equity) }));
  const keep = new Set([...moved].sort((a, b) => b.move - a.move).slice(0, n).map((m) => m.id));
  return moved.filter((m) => keep.has(m.id)).map((m) => m.id);
}

/** The deepest fall of an equity curve below its running peak, as a fraction of that peak (0.05 is 5%). */
export function deepestFall(points: ReadonlyArray<{ equity: number }>): number {
  let peak = -Infinity;
  let worst = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) worst = Math.max(worst, (peak - p.equity) / peak);
  }
  return worst;
}

/** The id whose curve fell the deepest, so the underwater chart opens where there is something to see; null when none fell. */
export function deepestId(curves: ReadonlyArray<{ id: string; points: ReadonlyArray<{ equity: number }> }>): string | null {
  let best: { id: string; fall: number } | null = null;
  for (const c of curves) {
    const fall = deepestFall(c.points);
    if (fall > 0 && (best == null || fall > best.fall)) best = { id: c.id, fall };
  }
  return best?.id ?? null;
}
