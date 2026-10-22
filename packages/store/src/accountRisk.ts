import type { Db } from "./db.js";
import { accountCloses, accountSummary, type AccountFilter, type AccountSummary } from "./account.js";
import { dataVersion } from "./versions.js";
import { NeedsScan, projectedViews, seriesViews, type AccountView } from "./accountViews.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * One venue account's equity history. qkt reports an account under a broker label, and one
 * account is often stored under several labels over time (a profile rename, per-profile copies
 * of one login). Labels are stitched by the opaque venue account id ("mt5:<16 hex>") when it was
 * reported, else by the rule accountDrawdown uses for its TOTAL: labels that never report in the
 * same minutes take turns for one account, labels that report together are separate accounts.
 */
export interface AccountSeries {
  /** The venue account id when known, else the label that reported last. */
  key: string;
  /** The label that reported last. */
  label: string;
  identity: string | null;
  labels: string[];
  points: Array<{ ts: number; balance: number | null; equity: number }>;
}

interface Group { labels: string[]; identity: string | null; points: Array<{ ts: number; balance: number | null; equity: number; label: string }>; minutes: Set<number> }

/** The latest stitched series per database and instance, with the account version it was built at. */
const latestSeries = new WeakMap<Db, Map<string, { version: string; series: AccountSeries[] }>>();

/**
 * Callers must treat the result as read-only: the series up to the newest stored minute is
 * shared between requests until the account rollup writes again.
 */
export function accountSeries(db: Db, f: { instanceId: string; from?: number; to?: number }): AccountSeries[] {
  const newest = (db.prepare("SELECT MAX(minute_ts) ts FROM account_equity WHERE instance_id=?").get(f.instanceId) as { ts: number | null }).ts;
  // A cutoff at or past the newest stored minute keeps every row, so it is the same series.
  if (f.from != null || (f.to != null && (newest == null || f.to < newest))) return stitchSeries(db, f);
  let byInstance = latestSeries.get(db);
  if (!byInstance) {
    byInstance = new Map();
    latestSeries.set(db, byInstance);
  }
  const version = `${dataVersion(db, [{ account: f.instanceId }])}.${newest}`;
  const hit = byInstance.get(f.instanceId);
  if (hit && hit.version === version) return hit.series;
  const series = stitchSeries(db, { instanceId: f.instanceId });
  byInstance.set(f.instanceId, { version, series });
  return series;
}

function stitchSeries(db: Db, f: { instanceId: string; from?: number; to?: number }): AccountSeries[] {
  const rows = db.prepare(
    `SELECT broker, account, minute_ts ts, balance, equity FROM account_equity
     WHERE instance_id=? AND equity IS NOT NULL AND minute_ts<=? ORDER BY minute_ts ASC`,
  ).all(f.instanceId, f.to ?? Number.MAX_SAFE_INTEGER) as Array<{ broker: string; account: string | null; ts: number; balance: number | null; equity: number }>;

  const byLabel = new Map<string, Group>();
  for (const r of rows) {
    let g = byLabel.get(r.broker);
    if (!g) { g = { labels: [r.broker], identity: null, points: [], minutes: new Set() }; byLabel.set(r.broker, g); }
    g.identity ??= r.account;
    g.points.push({ ts: r.ts, balance: r.balance, equity: r.equity, label: r.broker });
    g.minutes.add(r.ts);
  }
  const accounts: Group[] = [];
  const merge = (into: Group, g: Group) => {
    into.labels.push(...g.labels);
    into.identity ??= g.identity;
    into.points.push(...g.points);
    for (const m of g.minutes) into.minutes.add(m);
  };
  // Known identities first, so an unidentified label joins the account it took turns with.
  const groups = [...byLabel.values()].sort((a, b) => (a.identity == null ? 1 : 0) - (b.identity == null ? 1 : 0) || a.points[0]!.ts - b.points[0]!.ts);
  for (const g of groups) {
    const same = g.identity != null ? accounts.find((a) => a.identity === g.identity) : undefined;
    if (same) { merge(same, g); continue; }
    const turn = accounts.find((a) => {
      if (a.identity != null && g.identity != null) return false;
      let shared = 0;
      for (const m of g.minutes) if (a.minutes.has(m)) shared++;
      // A handover can land both labels in one minute; a separate account shares nearly all.
      return shared <= Math.floor(Math.min(g.minutes.size, a.minutes.size) * 0.01);
    });
    if (turn) merge(turn, g);
    else accounts.push({ ...g, labels: [...g.labels], points: [...g.points], minutes: new Set(g.minutes) });
  }
  return accounts.map((a) => {
    const byMinute = new Map<number, { ts: number; balance: number | null; equity: number; label: string }>();
    for (const p of a.points.sort((x, y) => x.ts - y.ts)) byMinute.set(p.ts, p);
    const all = [...byMinute.values()];
    const label = all[all.length - 1]!.label;
    return {
      key: a.identity ?? label,
      label,
      identity: a.identity,
      labels: a.labels,
      points: all.filter((p) => f.from == null || p.ts >= f.from).map(({ label: _l, ...p }) => p),
    };
  });
}

/**
 * Risk limits of one venue account (INSIGHTS_ACCOUNT_LIMITS). Percentages are whole percent
 * (5 = 5%). A money limit wins over a percentage of the same limit.
 */
export interface AccountLimitProfile {
  /** "peak" (default): drawdown from the highest equity; "static": below the start balance. */
  basis?: "peak" | "static";
  /** The balance the account started with: the static floor and the base of every % limit. */
  startBalance?: number;
  /** Hour (0-23) the daily loss resets, in `timezone`. Default 0. */
  dailyResetHour?: number;
  /** IANA timezone of the daily reset. Default "UTC". */
  timezone?: string;
  /** true: daily loss = day-start balance minus equity now (floating included). Default false: realized closes only. */
  dailyLossIncludesFloating?: boolean;
  /**
   * What the day is measured from: "balance" (default) the day-start balance, "higher" the higher of
   * the day-start balance and day-start equity (prop rules such as The5ers'). Base of dailyLossPct too.
   */
  dailyLossBase?: "balance" | "higher";
  /** % of the day's reference (dailyLossBase). */
  dailyLossPct?: number;
  dailyLoss?: number;
  /** % of the start balance. */
  maxDrawdownPct?: number;
  maxDrawdown?: number;
}

/** Profiles keyed by opaque account id ("mt5:<16 hex>", "vgp:<16 hex>"), broker label, or "*" for every account. */
export type AccountLimits = Record<string, AccountLimitProfile>;

export interface AccountRiskRow {
  account: string;
  label: string;
  /** Where the limits came from: INSIGHTS_ACCOUNT_LIMITS, the strategies' qkt risk config, or none. */
  source: "account limits" | "strategy risk config" | null;
  basis: "peak" | "static";
  startBalance: number | null;
  startBalanceSource: "configured" | "strategy risk config" | "first recorded balance" | null;
  balance: number | null;
  equity: number | null;
  peakEquity: number | null;
  drawdown: {
    /** Money below the reference (peak equity, or the start balance on a static basis); never negative. */
    used: number | null;
    /** Percent of the reference. */
    usedPct: number | null;
    reference: number | null;
    cap: number | null;
  };
  dailyLoss: {
    used: number | null;
    cap: number | null;
    /** When the current trading day began (epoch ms). */
    dayStart: number;
    resetHour: number;
    timezone: string;
    includesFloating: boolean;
    base: "balance" | "higher";
    dayStartBalance: number | null;
    dayStartEquity: number | null;
    /** What the day is measured from: the day-start balance, or the higher of it and day-start equity. */
    reference: number | null;
    /** Realized net of the current trading day (closes since dayStart). */
    realizedToday: number;
  };
}

/** Milliseconds `tz` wall-clock time is ahead of UTC at `ts`. */
function tzOffset(ts: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(ts / 1000) * 1000;
}

/**
 * The start of the trading day containing `ts`: the latest moment at or before it when the
 * wall clock in `tz` read `resetHour`:00. e.g. reset 0 in "Europe/Athens" (UTC+3 in summer)
 * puts the day start of 2026-07-01 12:00Z at 2026-06-30 21:00Z.
 */
export function tradingDayStart(ts: number, resetHour = 0, tz = "UTC"): number {
  const wall = ts + tzOffset(ts, tz);
  const wallStart = Math.floor((wall - resetHour * HOUR) / DAY) * DAY + resetHour * HOUR;
  const guess = wallStart - tzOffset(ts, tz);
  return wallStart - tzOffset(guess, tz);
}

function positive(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** qkt sends fractions (0.05); a value above 1 is already percent. */
function percent(v: unknown): number | null {
  const n = positive(v);
  return n == null ? null : n <= 1 ? n * 100 : n;
}

/**
 * Limits from the strategies' qkt risk config. Every strategy on an account carries the whole
 * account's limits, so they are never summed: the strictest of each limit applies, and the start
 * balance only when the strategies agree on it. A portfolio child's own starting balance is its
 * sleeve (its share of the book), so the book's capital stands for the account instead.
 */
function strategyProfile(db: Db, instanceId: string): AccountLimitProfile | null {
  const rows = db.prepare(
    `SELECT starting_balance sb, json_extract(metadata, '$.risk') risk, json_extract(metadata, '$.portfolioCapital') book
     FROM strategies WHERE instance_id=? AND metadata IS NOT NULL`,
  ).all(instanceId) as Array<{ sb: number | null; risk: string | null; book: unknown }>;
  const out: AccountLimitProfile = {};
  const starts = new Set<number>();
  let found = false;
  const min = (a: number | undefined, b: number | null) => (b == null ? a : a == null ? b : Math.min(a, b));
  for (const r of rows) {
    if (!r.risk) continue;
    const risk = JSON.parse(r.risk) as Record<string, unknown>;
    const sb = positive(risk.startingBalance) ?? positive(r.book) ?? positive(r.sb);
    const dailyLoss = positive(risk.maxDailyLoss);
    const dailyLossPct = percent(risk.maxDailyDrawdownPct ?? risk.maxDailyLossPct);
    const maxDrawdownPct = percent(risk.maxDrawdownPct);
    if (dailyLoss == null && dailyLossPct == null && maxDrawdownPct == null) continue;
    found = true;
    if (sb != null) starts.add(sb);
    out.dailyLoss = min(out.dailyLoss, dailyLoss);
    out.dailyLossPct = min(out.dailyLossPct, dailyLossPct);
    out.maxDrawdownPct = min(out.maxDrawdownPct, maxDrawdownPct);
    if (risk.totalDdBasis === "STATIC") out.basis = "static";
  }
  if (!found) return null;
  if (starts.size === 1) out.startBalance = [...starts][0]!;
  for (const k of Object.keys(out) as Array<keyof AccountLimitProfile>) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Drawdown and daily-loss consumption of each venue account, against limits that belong to the
 * account. Drawdown is measured from the equity peak (default) or below the start balance
 * (static basis), never as balance minus equity, which is only the open P&L.
 */
export function accountRisk(
  db: Db,
  f: { instanceId: string; limits?: AccountLimits; now: number; strategyIds?: ReadonlySet<string>; closedPositionsOnly?: boolean },
): AccountRiskRow[] {
  return withAccountViews(db, f.instanceId, f.now, (accounts) => riskRows(db, f, accounts));
}

/** accountRisk over the full stitched series: what the projected answer must equal, and its fallback. */
export function accountRiskScan(db: Db, f: Parameters<typeof accountRisk>[1]): AccountRiskRow[] {
  return riskRows(db, f, seriesViews(accountSeries(db, { instanceId: f.instanceId, to: f.now })));
}

/**
 * Runs `read` over the instance's accounts as of `to`, answered from the account projections; when
 * they cannot answer one of its questions exactly, over the full stitched series instead.
 */
function withAccountViews<T>(db: Db, instanceId: string, to: number | undefined, read: (accounts: AccountView[]) => T): T {
  try {
    const projected = projectedViews(db, instanceId, to);
    if (projected) return read(projected);
  } catch (e) {
    if (!(e instanceof NeedsScan)) throw e;
  }
  return read(seriesViews(accountSeries(db, { instanceId, to })));
}

function riskRows(
  db: Db,
  f: { instanceId: string; limits?: AccountLimits; now: number; strategyIds?: ReadonlySet<string>; closedPositionsOnly?: boolean },
  accounts: AccountView[],
): AccountRiskRow[] {
  // The strategies' risk config cannot say which account it belongs to, so it applies only when
  // the instance reports a single account.
  const fallback = accounts.length === 1 ? strategyProfile(db, f.instanceId) : null;
  return accounts.map((s) => {
    const configured = (s.identity != null ? f.limits?.[s.identity] : undefined)
      ?? s.labels.map((l) => f.limits?.[l]).find((p) => p != null)
      ?? f.limits?.["*"];
    const profile = configured ?? fallback ?? {};
    const source: AccountRiskRow["source"] = configured ? "account limits" : fallback ? "strategy risk config" : null;
    const basis = profile.basis ?? "peak";
    const last = s.last();
    const peak = s.peak();
    const firstBalance = s.firstBalance();
    const startBalance = profile.startBalance ?? firstBalance;
    const startBalanceSource: AccountRiskRow["startBalanceSource"] = profile.startBalance != null
      ? (configured ? "configured" : "strategy risk config")
      : firstBalance != null ? "first recorded balance" : null;

    const reference = basis === "static" ? startBalance : peak;
    const used = reference != null ? Math.max(0, reference - last.equity) : null;
    const ddCap = profile.maxDrawdown ?? (profile.maxDrawdownPct != null && startBalance != null ? (startBalance * profile.maxDrawdownPct) / 100 : null);

    const resetHour = profile.dailyResetHour ?? 0;
    const timezone = profile.timezone ?? "UTC";
    const dayStart = tradingDayStart(f.now, resetHour, timezone);
    const dayStartBalance = s.balanceAround(dayStart);
    const dailyBase = profile.dailyLossBase ?? "balance";
    const dayStartEquity = s.equityAtStart(dayStart, f.now);
    const dayReference = dailyBase === "higher" && dayStartEquity != null
      ? Math.max(dayStartBalance ?? dayStartEquity, dayStartEquity)
      : dayStartBalance;
    const realizedToday = accountCloses(db, {
      instanceId: f.instanceId, strategyIds: f.strategyIds, from: dayStart, to: f.now, closedPositionsOnly: f.closedPositionsOnly,
    }).reduce((a, c) => a + c.realized, 0);
    const includesFloating = profile.dailyLossIncludesFloating ?? false;
    const dailyUsed = includesFloating
      ? (dayReference != null ? Math.max(0, dayReference - last.equity) : null)
      : Math.max(0, -realizedToday);
    const dailyCap = profile.dailyLoss ?? (profile.dailyLossPct != null && dayReference != null ? (dayReference * profile.dailyLossPct) / 100 : null);

    return {
      account: s.key,
      label: s.label,
      source,
      basis,
      startBalance,
      startBalanceSource,
      balance: last.balance,
      equity: last.equity,
      peakEquity: Number.isFinite(peak) ? peak : null,
      drawdown: { used, usedPct: used != null && reference ? (used / reference) * 100 : null, reference, cap: ddCap },
      dailyLoss: { used: dailyUsed, cap: dailyCap, dayStart, resetHour, timezone, includesFloating, base: dailyBase, dayStartBalance, dayStartEquity, reference: dayReference, realizedToday },
    };
  });
}

export interface PeriodBase { period: string; base: number; source: "account equity" | "start balance" }

/**
 * The capital each calendar month's return is measured against: the account's equity when the
 * month began (summed across accounts), else its first recorded equity in the month. Without any
 * account history, the account start balance: one value when every strategy reports the same
 * (they share one account), else the sum of their own balances (separate paper accounts).
 */
export function monthBases(db: Db, f: { instanceId: string; months: string[]; to?: number }): PeriodBase[] {
  return withAccountViews(db, f.instanceId, f.to, (accounts) => periodBases(db, f, accounts));
}

/** monthBases over the full stitched series. */
export function monthBasesScan(db: Db, f: { instanceId: string; months: string[]; to?: number }): PeriodBase[] {
  return periodBases(db, f, seriesViews(accountSeries(db, { instanceId: f.instanceId, to: f.to })));
}

function periodBases(db: Db, f: { instanceId: string; months: string[] }, accounts: AccountView[]): PeriodBase[] {
  const out: PeriodBase[] = [];
  let fallback: number | null | undefined;
  for (const month of f.months) {
    const start = Date.parse(`${month}-01T00:00:00Z`);
    const end = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
    let base = 0;
    let found = false;
    for (const s of accounts) {
      const at = s.equityAtStart(start, end);
      if (at != null) { base += at; found = true; }
    }
    if (found && base > 0) { out.push({ period: month, base, source: "account equity" }); continue; }
    if (fallback === undefined) {
      const rows = db.prepare("SELECT starting_balance sb FROM strategies WHERE instance_id=? AND starting_balance > 0").all(f.instanceId) as Array<{ sb: number }>;
      const distinct = new Set(rows.map((r) => r.sb));
      fallback = rows.length === 0 ? null : distinct.size === 1 ? rows[0]!.sb : rows.reduce((a, r) => a + r.sb, 0);
    }
    if (fallback != null) out.push({ period: month, base: fallback, source: "start balance" });
  }
  return out;
}

/** The account roll-up with the capital base of each month it traded in. */
export function accountPerformance(db: Db, f: AccountFilter): AccountSummary & { monthBases: PeriodBase[] } {
  const summary = accountSummary(db, f);
  const months = [...new Set(summary.dailyNets.map((d) => d.day.slice(0, 7)))];
  return { ...summary, monthBases: monthBases(db, { instanceId: f.instanceId, months, to: f.to }) };
}
