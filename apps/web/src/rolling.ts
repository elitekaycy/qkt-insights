import type { RollingPoint } from "./api";

/*
 * Which rolling edge-stability series have anything to draw. A series that is null at every
 * point (Sharpe before the window fills) gets no legend entry and no axis; a one-line note
 * says why instead, so an empty axis never reads as a flat zero.
 */

export interface RollingCoverage {
  sharpe: boolean;
  winRate: boolean;
  /** One line per series left out, saying what it needs. */
  notes: string[];
}

export function rollingCoverage(points: readonly RollingPoint[], window: number): RollingCoverage {
  const sharpe = points.some((p) => p.sharpe != null);
  const winRate = points.some((p) => p.winRate != null);
  const notes: string[] = [];
  if (!sharpe) {
    // the first day is the starting base: every later day is one daily return
    const returns = Math.max(0, points.length - 1);
    notes.push(`Rolling Sharpe needs ≥ ${window} trading days with closes in the window; this range has ${returns}.`);
  }
  if (!winRate) notes.push("No traded days in any window yet, so no winning-day rate.");
  return { sharpe, winRate, notes };
}
