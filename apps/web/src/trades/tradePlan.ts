import type { PositionPath, StopStyle } from "./data";

/*
 * The trade's plan against what the price did: where the stop and the target sit, how far the price is (or
 * ended) along the way from one to the other, what each would pay, and how close the best mark came to the
 * target. Pure arithmetic over the stored path, so every figure the drawer prints is tested here.
 */

/** A target this many times the stop's distance or more is a placeholder: the strategy exits on its own signal. */
export const PLACEHOLDER_RR = 20;

export interface Distance {
  /** Price distance, positive while there is room before the level. */
  points: number;
  /** The distance as a percent of the price it is measured from. */
  pct: number;
  /** What the position would make (positive) or lose at the level from the entry, in account money; null without a rate. */
  money: number | null;
}

export interface PlanFigures {
  side: "long" | "short";
  entry: number;
  /** The stop now (open) or at the exit (closed): the venue's latest step, else the initial stop. */
  stop: number | null;
  initialStop: number | null;
  /** The target the bar runs to; null when there is none or it is a placeholder. */
  target: number | null;
  /** A target set far beyond reach (PLACEHOLDER_RR × the stop's distance); shown as a note, not as the bar's end. */
  placeholderTarget: number | null;
  /** Where the price is: the latest mark (open) or the exit (closed). */
  at: { kind: "now" | "exit"; price: number; ts: number } | null;
  /** Positions on the stop → target scale, 0 at the stop and 1 at the target; null without both. */
  scale: { entry: number; at: number | null; best: number | null } | null;
  /** From the price now to the stop and to the target (open trades); money is what the level pays from the entry. */
  toStop: Distance | null;
  toTarget: Distance | null;
  /** Money at the stop shown (the latest step, else the initial stop) from the entry: negative risks, positive locks in. */
  stopMoney: number | null;
  /** Money at the initial stop and at the target from the entry. */
  riskMoney: number | null;
  rewardMoney: number | null;
  /** Reward over risk at entry, from the initial stop. */
  rewardRisk: number | null;
  /** How close the best mark came to the target: price distance left and percent of the target. */
  bestToTarget: { points: number; pct: number } | null;
  /** The share of the best floating profit the exit kept (closed, best above 0); 0 when it gave all back. */
  kept: number | null;
  /** How many times the venue moved the stop while held. */
  stopMoves: number;
  stopStyle: StopStyle | null;
  levelSource: PositionPath["levelSource"];
}

const valid = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

export function planFigures(path: PositionPath, realized: number | null): PlanFigures | null {
  const entry = path.entry?.price;
  if (!valid(entry)) return null;
  const dir = path.side === "long" ? 1 : -1;
  const mpp = path.moneyPerPoint;

  const steps = path.levelSteps;
  const lastStep = steps.at(-1);
  const initialStop = valid(path.stopPrice) ? path.stopPrice : null;
  // once the venue reported levels, its latest step is the truth (null: removed there); before that, the initial ones
  const stop = steps.some((s) => s.stop != null) ? lastStep!.stop : initialStop;
  const rawTarget = steps.some((s) => s.target != null) ? lastStep!.target : valid(path.targetPrice) ? path.targetPrice : null;
  // the risk is the initial stop's: a trailed stop past the entry locks profit, it does not change what was risked
  const riskPts = initialStop != null ? (entry - initialStop) * dir : null;
  const rewardPts = rawTarget != null ? (rawTarget - entry) * dir : null;
  const placeholder = rawTarget != null && riskPts != null && riskPts > 0 && rewardPts != null && rewardPts / riskPts >= PLACEHOLDER_RR;
  const target = rawTarget != null && !placeholder && rewardPts != null && rewardPts > 0 ? rawTarget : null;

  const closed = path.status === "closed";
  const atPrice = closed ? path.exit?.price : path.last?.price;
  const atTs = closed ? path.exit?.ts : path.last?.ts;
  const at = valid(atPrice) && atTs != null ? { kind: closed ? ("exit" as const) : ("now" as const), price: atPrice, ts: atTs } : null;

  // the bar runs from the initial stop to the target: a trailed stop is drawn on it, the scale stays put
  const lo = initialStop, hi = target;
  const scaleOf = (p: number | null | undefined) => (lo != null && hi != null && p != null && Number.isFinite(p) && hi !== lo ? (p - lo) / (hi - lo) : null);
  const scale = lo != null && hi != null ? { entry: scaleOf(entry)!, at: scaleOf(at?.price), best: scaleOf(path.best?.price) } : null;

  const moneyAt = (level: number) => (mpp != null ? (level - entry) * dir * mpp : null);
  const distance = (from: number, level: number, room: number): Distance => ({ points: room, pct: (Math.abs(room) / from) * 100, money: moneyAt(level) });
  const toStop = !closed && at && stop != null ? distance(at.price, stop, (at.price - stop) * dir) : null;
  const toTarget = !closed && at && target != null ? distance(at.price, target, (target - at.price) * dir) : null;

  const riskMoney = path.riskAmount != null && path.riskAmount > 0 ? -path.riskAmount : initialStop != null ? moneyAt(initialStop) : null;
  const rewardMoney = target != null ? moneyAt(target) : null;
  const stopMoney = stop == null ? null : stop === initialStop && riskMoney != null ? riskMoney : moneyAt(stop);
  const rewardRisk = riskPts != null && riskPts > 0 && rewardPts != null && target != null ? rewardPts / riskPts : null;

  const bestPrice = path.best?.price;
  const bestToTarget = target != null && valid(bestPrice) ? { points: (target - bestPrice) * dir, pct: (Math.abs(target - bestPrice) / target) * 100 } : null;
  // the exit can beat every mark (a target filled between polls): then nothing was given back and no share is shown
  const kept = closed && realized != null && path.best && path.best.pnl > 0 && realized < path.best.pnl ? Math.max(0, realized / path.best.pnl) : null;

  let stopMoves = 0;
  for (let i = 1; i < steps.length; i++) if (steps[i]!.stop != null && steps[i - 1]!.stop != null && steps[i]!.stop !== steps[i - 1]!.stop) stopMoves++;

  return {
    side: path.side, entry, stop, initialStop, target, placeholderTarget: placeholder ? rawTarget : null, at, scale, toStop, toTarget,
    stopMoney, riskMoney, rewardMoney, rewardRisk, bestToTarget, kept, stopMoves, stopStyle: path.stopStyle, levelSource: path.levelSource,
  };
}

/** The price move from the entry to `price` as a signed percent for the side: +0.42 when a long is 0.42% up. */
export function movePct(side: "long" | "short", entry: number | null | undefined, price: number | null | undefined): number | null {
  if (!valid(entry) || !valid(price)) return null;
  return ((price - entry) / entry) * 100 * (side === "long" ? 1 : -1);
}

/** The stop's behaviour in a few words: "Trailing stop · trails 5.00 once 10.00 in profit". */
export function stopStyleWords(s: StopStyle | null, fmt: (v: number) => string, every: (ms: number) => string): string | null {
  if (!s) return null;
  switch (s.kind) {
    case "fixed": return null;
    case "trailing":
      return ["Trailing stop", s.trailDistance != null ? `trails ${fmt(s.trailDistance)}` : null, s.armAt != null && s.armAt > 0 ? `once ${fmt(s.armAt)} in profit` : null].filter(Boolean).join(" · ");
    case "stepped":
      return ["Stepped stop", s.steps ? `${s.steps} step${s.steps === 1 ? "" : "s"}` : null, s.armAt != null ? `first at ${fmt(s.armAt)} in profit` : null].filter(Boolean).join(" · ");
    case "tightening":
      return ["Tightening stop", s.intervalMs ? `moves every ${every(s.intervalMs)}` : null].filter(Boolean).join(" · ");
  }
}
