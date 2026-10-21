import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { refreshProjections } from "./projections.js";
import { groupingInputs, hasMinuteWithoutEquity, stateAt } from "./accountProjection.js";

export interface AccountPoint { ts: number; balance: number | null; equity: number }

/**
 * One venue account as the risk and return readers need it: its labels stitched (accountSeries),
 * and the few points of its minute series they look at.
 */
export interface AccountView {
  key: string;
  label: string;
  identity: string | null;
  labels: string[];
  last: () => AccountPoint;
  /** The highest equity of the series. */
  peak: () => number;
  /** The first recorded balance. */
  firstBalance: () => number | null;
  /** The last balance at or before `ts`, else the first one after it. */
  balanceAround: (ts: number) => number | null;
  /** Equity at a period's start: the last point at or before it, else the first one inside the period. */
  equityAtStart: (start: number, end: number) => number | null;
}

/** Thrown by a projected view for an input only the full minute series answers exactly. */
export class NeedsScan extends Error {}

/** Views over fully loaded series (accountSeries). */
export function seriesViews(series: Array<{ key: string; label: string; identity: string | null; labels: string[]; points: AccountPoint[] }>): AccountView[] {
  return series.map((s) => ({
    key: s.key, label: s.label, identity: s.identity, labels: s.labels,
    last: () => s.points[s.points.length - 1]!,
    peak: () => s.points.reduce((m, p) => Math.max(m, p.equity), -Infinity),
    firstBalance: () => s.points.find((p) => p.balance != null)?.balance ?? null,
    balanceAround: (ts) => {
      const before = s.points.filter((p) => p.ts <= ts && p.balance != null);
      return (before.length > 0 ? before[before.length - 1]!.balance : s.points.find((p) => p.ts > ts && p.balance != null)?.balance) ?? null;
    },
    equityAtStart: (start, end) => {
      let at: number | null = null;
      for (const p of s.points) {
        if (p.ts <= start) at = p.equity;
        else { if (at == null && p.ts < end) at = p.equity; break; }
      }
      return at;
    },
  }));
}

/** Steps a walk may take before the full series is cheaper. */
const MAX_STEPS = 256;

/**
 * Views answered from the account projections with a few seeks per question. The labels are
 * grouped exactly as accountSeries stitches them; a minute two of an account's labels both report
 * keeps the label that joined the account last, as the stitched series does. Null when the
 * projection cannot reproduce the stitching (a minute without equity, a minute three labels share).
 */
export function projectedViews(db: Db, instanceId: string, to = Number.MAX_SAFE_INTEGER): AccountView[] | null {
  if (hasMinuteWithoutEquity(db, instanceId)) return null;
  refreshProjections(db);
  const inputs = groupingInputs(db, instanceId, to);
  if (!inputs) return null;
  const groups = inputs.labels
    .map((l) => ({ label: l.broker, identity: l.identity, first: l.firstTs, size: l.size }))
    .sort((a, b) => (a.identity == null ? 1 : 0) - (b.identity == null ? 1 : 0) || a.first - b.first);
  const accounts: Array<{ labels: string[]; identity: string | null; minutes: number }> = [];
  const sharedWith = (label: string, a: { labels: string[] }) => a.labels.reduce((n, l) => n + inputs.shared(label, l), 0);
  for (const g of groups) {
    const into = (g.identity != null ? accounts.find((a) => a.identity === g.identity) : undefined)
      ?? accounts.find((a) => {
        if (a.identity != null && g.identity != null) return false;
        return sharedWith(g.label, a) <= Math.floor(Math.min(g.size, a.minutes) * 0.01);
      });
    if (into) {
      into.minutes += g.size - sharedWith(g.label, into);
      into.labels.push(g.label);
      into.identity ??= g.identity;
    } else accounts.push({ labels: [g.label], identity: g.identity, minutes: g.size });
  }
  return accounts.map((a) => accountView(db, instanceId, a.labels, a.identity, to));
}

function accountView(db: Db, instanceId: string, labels: string[], identity: string | null, to: number): AccountView {
  const seek = {
    back: statement(db,
      "SELECT minute_ts ts, balance, equity FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts<=? AND equity IS NOT NULL ORDER BY minute_ts DESC LIMIT 1"),
    fwd: statement(db,
      "SELECT minute_ts ts, balance, equity FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts>=? AND minute_ts<=? AND equity IS NOT NULL ORDER BY minute_ts ASC LIMIT 1"),
  };
  const at = statement(db, "SELECT 1 FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts=? AND equity IS NOT NULL");
  /** The stitched point nearest `ts` in a direction: the latest-joined label wins a shared minute. */
  const pointFrom = (ts: number, dir: "back" | "fwd"): (AccountPoint & { label: string }) | null => {
    let best: (AccountPoint & { label: string; rank: number }) | null = null;
    labels.forEach((label, rank) => {
      const p = (dir === "back" ? seek.back.get(instanceId, label, Math.min(ts, to)) : seek.fwd.get(instanceId, label, ts, to)) as AccountPoint | undefined;
      if (!p) return;
      const better = best == null || (dir === "back" ? p.ts > best.ts : p.ts < best.ts) || (p.ts === best.ts && rank > best.rank);
      if (better) best = { ...p, label, rank };
    });
    if (best == null) return null;
    const { rank: _rank, ...point } = best as AccountPoint & { label: string; rank: number };
    return point;
  };
  const walk = (ts: number, dir: "back" | "fwd", keep: (p: AccountPoint) => boolean): (AccountPoint & { label: string }) | null => {
    let cursor = ts;
    for (let i = 0; i < MAX_STEPS; i++) {
      const p = pointFrom(cursor, dir);
      if (p == null || keep(p)) return p;
      cursor = dir === "back" ? p.ts - 1 : p.ts + 1;
    }
    throw new NeedsScan();
  };
  const last = walk(to, "back", () => true);
  if (last == null) throw new NeedsScan();
  const label = last.label;
  const hasBalance = (p: AccountPoint) => p.balance != null;
  return {
    key: identity ?? label,
    label,
    identity,
    labels,
    last: () => ({ ts: last.ts, balance: last.balance, equity: last.equity }),
    peak: () => {
      const states = labels.map((l) => stateAt(db, instanceId, l, to));
      let best = -Infinity;
      for (const s of states) if (s && s.peak > best) best = s.peak;
      // The walks start their peak at 0: below that, or when the peak minute is one another label
      // of the account overrides, only the full series knows the stitched peak.
      if (!(best > 0)) throw new NeedsScan();
      for (const [rank, s] of states.entries()) {
        if (!s || s.peak !== best) continue;
        const overridden = labels.some((l, r) => r > rank && at.get(instanceId, l, s.peakTs) != null);
        if (!overridden) return best;
      }
      throw new NeedsScan();
    },
    firstBalance: () => walk(Number.MIN_SAFE_INTEGER, "fwd", hasBalance)?.balance ?? null,
    balanceAround: (ts) => walk(ts, "back", hasBalance)?.balance ?? walk(ts + 1, "fwd", hasBalance)?.balance ?? null,
    equityAtStart: (start, end) => {
      const before = walk(start, "back", () => true);
      if (before) return before.equity;
      const inside = walk(start + 1, "fwd", () => true);
      return inside != null && inside.ts < end ? inside.equity : null;
    },
  };
}
