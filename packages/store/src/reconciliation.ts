import type { Db } from "./db.js";
import { statement } from "./statements.js";
import { accountGroups } from "./accountRisk.js";
import { refreshProjections } from "./projections.js";
import { profileLabel } from "./inferredVenueFacts.js";
import { instanceMoneyDigits, roundMoney, sumMoney } from "./money.js";
import { bumpReconciliation } from "./versions.js";

/*
 * Venue reconciliation: proof that what insights stores matches the venue, from what qkt already
 * sends (no gateway calls). Per venue account, three checks:
 *
 * - Balance continuity per complete UTC day: the balance change between the last snapshots at or
 *   before the day's two midnights equals the net (profit + commission + swap + fee) of the
 *   account's canonical deals between those snapshots. The snapshots' own times bound the deals, so
 *   an outage across midnight moves deals to the day the next snapshot lands in, never off the books.
 * - Open positions now: the venue's latest positions report against the open round trips.
 * - Ledger: the closed round trips add up to the deals of their positions.
 *
 * A run is incremental: it checks the days after the last one stored, again the last RECHECK_DAYS
 * (a deal can arrive late), and again every day that was not ok. Every read is an index seek or
 * range scan: balance points through account_equity's key, deals through (instance_id, ts).
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Days before today checked on every run, ok or not: a deal replayed from qkt's journal lands late. */
export const RECHECK_DAYS = 7;
/** A venue positions report older than this is not compared: the open-positions check is "stale". */
export const POSITIONS_FRESH_MS = 5 * MINUTE;
/** A position opened this close to the report or the run may not have its deal stored yet. */
const POSITION_GRACE_MS = 2 * MINUTE;
/**
 * A minute's balance is the last poll flushed in that minute (liveState.ts flushRollup): a poll up
 * to 90 s old, flushed up to a minute after the minute starts. A deal in (minute - BEFORE,
 * minute + AFTER] may or may not be in it, so a day boundary is never cut at such a snapshot.
 */
const AMBIGUOUS_BEFORE_MS = 2 * MINUTE;
const AMBIGUOUS_AFTER_MS = MINUTE;
/** Snapshots a boundary steps back past ambiguous ones before it takes the latest anyway. */
const MAX_BOUNDARY_STEPS = 30;
/** Days checked between two yields of a run. */
const DAYS_PER_STEP = 31;
/** Non-ok days a read returns per account, newest first. */
const LISTED_DAYS = 100;

export type DayStatus = "ok" | "diff" | "incomplete";
/**
 * Why a day is not ok. no-deals: the balance moved and no deal explains it. deals-differ: deals were
 * stored, but they do not add up to the change. no-prior-balance: no balance snapshot before the day
 * started (the account's first day). no-balance: the day's snapshots carry no balance.
 */
export type DayReason = "no-deals" | "deals-differ" | "no-prior-balance" | "no-balance";

export interface ReconciledDay {
  day: string;
  status: DayStatus;
  reason: DayReason | null;
  startTs: number | null;
  endTs: number | null;
  startBalance: number | null;
  endBalance: number | null;
  /** endBalance - startBalance. */
  balanceChange: number | null;
  dealNet: number | null;
  /** balanceChange - dealNet: what no stored deal explains. */
  diff: number | null;
  deals: number;
  checkedAt: number;
}

export interface VenuePositionsReport {
  /** The label the venue account is shown under (the live state's position group). */
  broker: string;
  /** When the venue reported this list (ms). */
  at: number;
  list: ReadonlyArray<{ ticket: string; positionId?: string; symbol: string; side: string; qty: number; openedAt?: number }>;
}

export interface PositionRef { ticket: string; symbol: string | null; side: string | null; qty: number | null }

export interface PositionsCheck {
  /** ok: the venue and insights hold the same positions. stale: no venue report within POSITIONS_FRESH_MS. */
  status: "ok" | "diff" | "stale";
  /** The venue report compared (ms); null when none was. */
  venueAt: number | null;
  venueCount: number;
  insightsCount: number;
  /** Open at the venue, no open round trip in insights. */
  missing: PositionRef[];
  /** Open in insights, gone from the venue. */
  gone: PositionRef[];
  /** Open on both sides with a different side or size. */
  mismatched: Array<{ ticket: string; symbol: string | null; field: "side" | "qty"; venue: string | number; insights: string | number }>;
}

export interface LedgerCheck {
  status: "ok" | "diff";
  /** Closed round trips of the account. */
  trips: number;
  /** Sum of their stored net. */
  tripsNet: number;
  /** Sum of the net of their positions' deals. */
  dealsNet: number;
  diff: number;
  /** Trips whose own net differs from their deals (at most 10). */
  mismatched: Array<{ ticket: string; realized: number; dealsNet: number }>;
}

export interface AccountReconciliation {
  account: string;
  label: string;
  firstDay: string | null;
  lastDay: string | null;
  /** Every checked day up to this one is ok (or incomplete); null while none is. */
  throughDay: string | null;
  daysOk: number;
  daysDiff: number;
  daysIncomplete: number;
  /** Days not ok, newest first (at most LISTED_DAYS). */
  days: ReconciledDay[];
  positions: PositionsCheck;
  ledger: LedgerCheck;
  checkedAt: number;
}

export interface Reconciliation {
  instanceId: string;
  /** Decimals of the account currency's minor unit. */
  digits: number;
  /** The latest run's time; null before the first run. */
  checkedAt: number | null;
  accounts: AccountReconciliation[];
}

export interface ReconcileResult {
  accounts: number;
  daysChecked: number;
  diffs: number;
}

interface Account { key: string; label: string; identity: string | null; labels: string[] }
interface Point { ts: number; balance: number }
interface DealRow { broker: string; accountId: string | null; profit: number | null; commission: number | null; swap: number | null; fee: number | null }

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const dayStart = (key: string) => Date.parse(`${key}T00:00:00Z`);
const dealNet = (d: DealRow) => (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0) + (d.fee ?? 0);
/** Half the minor unit per amount summed, plus float noise: a sum of `n` amounts rounded at the minor unit is never further off. */
const tolerance = (n: number, digits: number) => 0.5 * 10 ** -digits * Math.max(1, n) + 1e-9;

/**
 * Which account a deal belongs to: the account it states (accountId) when that is one of the
 * instance's accounts, else the account its label (without a profile suffix) reports under.
 */
function dealAccounts(accounts: Account[]): (broker: string, accountId: string | null) => Account | null {
  const byIdentity = new Map(accounts.flatMap((a) => (a.identity != null ? [[a.identity, a] as const] : [])));
  const byLabel = new Map(accounts.flatMap((a) => a.labels.map((l) => [l, a] as const)));
  const memo = new Map<string, Account | null>();
  return (broker, accountId) => {
    const k = `${broker}\u0000${accountId ?? ""}`;
    if (memo.has(k)) return memo.get(k)!;
    const stated = accountId != null ? byIdentity.get(accountId) : undefined;
    let a = stated ?? byLabel.get(broker) ?? (accountId == null ? byLabel.get(profileLabel(broker)) : undefined) ?? null;
    // a deal that names another venue account never joins one with a different identity
    if (!stated && a != null && accountId != null && a.identity != null && a.identity !== accountId) a = null;
    memo.set(k, a);
    return a;
  };
}

function lastBalance(db: Db, instanceId: string, account: Account, at: number): Point | null {
  const seek = statement(db,
    `SELECT minute_ts ts, balance FROM account_equity
     WHERE instance_id=? AND broker=? AND minute_ts<=? AND balance IS NOT NULL ORDER BY minute_ts DESC LIMIT 1`);
  let best: Point | null = null;
  for (const label of account.labels) {
    const p = seek.get(instanceId, label, at) as Point | undefined;
    // a minute two labels share keeps the label that joined the account last, as the stitched series does
    if (p && (best == null || p.ts >= best.ts)) best = p;
  }
  return best;
}

function firstBalanceTs(db: Db, instanceId: string, account: Account): number | null {
  const seek = statement(db,
    "SELECT minute_ts ts FROM account_equity WHERE instance_id=? AND broker=? AND balance IS NOT NULL ORDER BY minute_ts ASC LIMIT 1");
  let first: number | null = null;
  for (const label of account.labels) {
    const r = seek.get(instanceId, label) as { ts: number } | undefined;
    if (r && (first == null || r.ts < first)) first = r.ts;
  }
  return first;
}

/** Whether the account has a stored minute in [from, to): with a balance, or any. */
function hasMinute(db: Db, instanceId: string, account: Account, from: number, to: number, withBalance: boolean): boolean {
  const seek = withBalance
    ? statement(db, "SELECT 1 FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts>=? AND minute_ts<? AND balance IS NOT NULL LIMIT 1")
    : statement(db, "SELECT 1 FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts>=? AND minute_ts<? LIMIT 1");
  return account.labels.some((label) => seek.get(instanceId, label, from, to) != null);
}

function dealsBetween(db: Db, instanceId: string, after: number, upTo: number): DealRow[] {
  return statement(db,
    `SELECT broker, account_id accountId, profit, commission, swap, fee FROM deals
     WHERE instance_id=? AND ts>? AND ts<=? AND canonical=1`,
  ).all(instanceId, after, upTo) as DealRow[];
}

/**
 * Checks the days of one account that need it and stores them; yields every DAYS_PER_STEP days.
 * Returns the days checked and how many differ.
 */
function* reconcileDays(db: Db, instanceId: string, account: Account, accountOf: ReturnType<typeof dealAccounts>, digits: number, now: number): Generator<void, { checked: number; diffs: number }, void> {
  const first = firstBalanceTs(db, instanceId, account);
  if (first == null) return { checked: 0, diffs: 0 };
  // a day is complete once its end, and the minute a snapshot at its end can still take, are past
  const lastDay = Math.floor((now - AMBIGUOUS_AFTER_MS) / DAY) * DAY - DAY;
  const firstDay = Math.floor(first / DAY) * DAY;
  if (lastDay < firstDay) return { checked: 0, diffs: 0 };

  const stored = statement(db, "SELECT MAX(day) d FROM reconciliations WHERE instance_id=? AND account=?").get(instanceId, account.key) as { d: string | null };
  const recheckFrom = Math.floor(now / DAY) * DAY - RECHECK_DAYS * DAY;
  const from = stored.d == null ? firstDay : Math.max(firstDay, Math.min(dayStart(stored.d) + DAY, recheckFrom));
  const open = (statement(db,
    "SELECT day FROM reconciliations INDEXED BY idx_reconciliations_open WHERE instance_id=? AND account=? AND status <> 'ok' AND day<?",
  ).all(instanceId, account.key, dayKey(from)) as Array<{ day: string }>).map((r) => dayStart(r.day));
  const days = [...open];
  for (let d = from; d <= lastDay; d += DAY) days.push(d);

  const owned = (d: DealRow) => accountOf(d.broker, d.accountId) === account;
  const ambiguous = (m: number) => dealsBetween(db, instanceId, m - AMBIGUOUS_BEFORE_MS, m + AMBIGUOUS_AFTER_MS).some(owned);
  const boundaries = new Map<number, Point | null>();
  /** The snapshot a midnight is cut at: the last one at or before it whose balance no deal could straddle. */
  const boundary = (at: number): Point | null => {
    if (boundaries.has(at)) return boundaries.get(at)!;
    let cursor = at;
    let latest: Point | null = null;
    let found: Point | null = null;
    for (let i = 0; i < MAX_BOUNDARY_STEPS; i++) {
      const p = lastBalance(db, instanceId, account, cursor);
      if (p == null) break;
      latest ??= p;
      if (!ambiguous(p.ts)) { found = p; break; }
      cursor = p.ts - 1;
    }
    const b = found ?? latest;
    boundaries.set(at, b);
    return b;
  };

  const checkDay = (d: number): Omit<ReconciledDay, "balanceChange" | "checkedAt"> => {
    const day = dayKey(d);
    const none = { startTs: null, endTs: null, startBalance: null, endBalance: null, dealNet: null, diff: null, deals: 0 };
    if (!hasMinute(db, instanceId, account, d, d + DAY, true)) return { day, status: "incomplete", reason: "no-balance", ...none };
    const end = boundary(d + DAY)!;
    const start = boundary(d);
    if (start == null) return { day, status: "incomplete", reason: "no-prior-balance", ...none, endTs: end.ts, endBalance: end.balance };
    // every snapshot near the end straddled a deal and the walk passed the start: nothing between them
    const upTo = Math.max(end.ts, start.ts);
    const deals = dealsBetween(db, instanceId, start.ts, upTo).filter(owned);
    const net = deals.reduce((s, x) => s + dealNet(x), 0);
    const endBalance = upTo === start.ts ? start.balance : end.balance;
    const diff = endBalance - start.balance - net;
    const ok = Math.abs(diff) <= tolerance(deals.length, digits);
    return {
      day,
      status: ok ? "ok" : "diff",
      reason: ok ? null : deals.length === 0 ? "no-deals" : "deals-differ",
      startTs: start.ts, endTs: upTo, startBalance: start.balance, endBalance,
      dealNet: roundMoney(net, digits), diff: ok ? 0 : roundMoney(diff, digits), deals: deals.length,
    };
  };

  const write = statement(db,
    `INSERT INTO reconciliations (instance_id, account, day, status, reason, start_ts, end_ts, start_balance, end_balance, deal_net, diff, deals, checked_at)
     VALUES (@instanceId, @account, @day, @status, @reason, @startTs, @endTs, @startBalance, @endBalance, @dealNet, @diff, @deals, @checkedAt)
     ON CONFLICT(instance_id, account, day) DO UPDATE SET status=excluded.status, reason=excluded.reason, start_ts=excluded.start_ts,
       end_ts=excluded.end_ts, start_balance=excluded.start_balance, end_balance=excluded.end_balance, deal_net=excluded.deal_net,
       diff=excluded.diff, deals=excluded.deals, checked_at=excluded.checked_at`);
  let checked = 0, diffs = 0;
  for (let i = 0; i < days.length; i += DAYS_PER_STEP) {
    db.transaction(() => {
      for (const d of days.slice(i, i + DAYS_PER_STEP)) {
        if (!hasMinute(db, instanceId, account, d, d + DAY, false)) continue;
        const row = checkDay(d);
        write.run({ instanceId, account: account.key, ...row, checkedAt: now });
        checked++;
        if (row.status === "diff") diffs++;
      }
    })();
    yield;
  }
  return { checked, diffs };
}

interface OpenTrip { ticket: string; broker: string | null; symbol: string | null; side: string; entryTs: number | null; accountId: string | null; openQty: number | null; reversals: number }

function openTrips(db: Db, instanceId: string): OpenTrip[] {
  return statement(db,
    `SELECT rt.position_ticket ticket, rt.broker, rt.symbol, rt.side, rt.entry_ts entryTs,
       (SELECT d.account_id FROM deals d WHERE d.instance_id=rt.instance_id AND d.position_ticket=rt.position_ticket AND d.account_id IS NOT NULL LIMIT 1) accountId,
       (SELECT SUM(CASE WHEN d.entry='IN' THEN d.qty WHEN d.entry IN ('OUT','OUT_BY') THEN -d.qty ELSE 0 END) FROM deals d
          WHERE d.instance_id=rt.instance_id AND d.position_ticket=rt.position_ticket AND d.canonical=1) openQty,
       (SELECT COUNT(*) FROM deals d WHERE d.instance_id=rt.instance_id AND d.position_ticket=rt.position_ticket AND d.canonical=1 AND d.entry='INOUT') reversals
     FROM round_trips rt INDEXED BY idx_round_trips_open WHERE rt.instance_id=? AND rt.open=1 AND rt.source='deal'`,
  ).all(instanceId) as OpenTrip[];
}

const sameQty = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function checkPositions(account: Account, trips: OpenTrip[], reports: readonly VenuePositionsReport[], now: number): PositionsCheck {
  const fresh = reports.filter((r) => account.labels.includes(r.broker) && now - r.at < POSITIONS_FRESH_MS);
  const insights = new Map(trips.map((t) => [t.ticket, t]));
  if (fresh.length === 0) return { status: "stale", venueAt: null, venueCount: 0, insightsCount: insights.size, missing: [], gone: [], mismatched: [] };
  const venueAt = Math.min(...fresh.map((r) => r.at));
  const venue = new Map<string, VenuePositionsReport["list"][number]>();
  for (const r of fresh) for (const p of r.list) venue.set(p.positionId ?? p.ticket, p);
  const missing: PositionRef[] = [];
  const mismatched: PositionsCheck["mismatched"] = [];
  for (const [ticket, p] of venue) {
    const t = insights.get(ticket) ?? insights.get(p.ticket);
    if (!t) {
      if (p.openedAt == null || p.openedAt < now - POSITION_GRACE_MS) missing.push({ ticket, symbol: p.symbol, side: p.side, qty: p.qty });
      continue;
    }
    const side = p.side === "SELL" ? "short" : "long";
    if (side !== t.side) mismatched.push({ ticket, symbol: p.symbol, field: "side", venue: p.side, insights: t.side === "short" ? "SELL" : "BUY" });
    // a reversed (INOUT) position's legs cannot say its open size
    else if (t.reversals === 0 && t.openQty != null && !sameQty(p.qty, t.openQty))
      mismatched.push({ ticket, symbol: p.symbol, field: "qty", venue: p.qty, insights: t.openQty });
  }
  const seen = new Set([...venue.values()].flatMap((p) => [p.positionId ?? p.ticket, p.ticket]));
  const gone = trips
    .filter((t) => !seen.has(t.ticket) && (t.entryTs == null || t.entryTs < venueAt - POSITION_GRACE_MS))
    .map((t) => ({ ticket: t.ticket, symbol: t.symbol, side: t.side === "short" ? "SELL" : "BUY", qty: t.openQty }));
  const status = missing.length + gone.length + mismatched.length === 0 ? "ok" : "diff";
  return { status, venueAt, venueCount: venue.size, insightsCount: insights.size, missing, gone, mismatched };
}

interface ClosedTrip { ticket: string; broker: string | null; accountId: string | null; realized: number; net: number }

function closedTrips(db: Db, instanceId: string): ClosedTrip[] {
  return statement(db,
    `SELECT rt.position_ticket ticket, rt.broker, MAX(d.account_id) accountId, rt.realized,
       SUM(COALESCE(d.profit,0) + COALESCE(d.commission,0) + COALESCE(d.swap,0) + COALESCE(d.fee,0)) net
     FROM round_trips rt JOIN deals d ON d.instance_id=rt.instance_id AND d.position_ticket=rt.position_ticket AND d.canonical=1
     WHERE rt.instance_id=? AND rt.open=0 AND rt.source='deal'
     GROUP BY rt.position_ticket`,
  ).all(instanceId) as ClosedTrip[];
}

function checkLedger(trips: ClosedTrip[], digits: number): LedgerCheck {
  const tripsNet = sumMoney(trips.map((t) => t.realized), digits);
  const raw = trips.reduce((s, t) => s + t.net, 0);
  const diff = tripsNet - raw;
  const ok = Math.abs(diff) <= tolerance(trips.length, digits);
  const mismatched = trips
    .filter((t) => Math.abs(t.realized - t.net) > tolerance(1, digits))
    .slice(0, 10)
    .map((t) => ({ ticket: t.ticket, realized: t.realized, dealsNet: roundMoney(t.net, digits) }));
  return { status: ok && mismatched.length === 0 ? "ok" : "diff", trips: trips.length, tripsNet, dealsNet: roundMoney(raw, digits), diff: roundMoney(diff, digits), mismatched };
}

/**
 * Reconciles every venue account of the instance as of `now` and stores the results. Runs as
 * steps, each its own short transaction, so a caller can serve requests between them.
 * `positions` is the venue's latest positions reports (the live state); without one for an
 * account its open-positions check is "stale".
 */
export function* reconcileSteps(db: Db, instanceId: string, opts: { now: number; positions?: readonly VenuePositionsReport[] }): Generator<void, ReconcileResult, void> {
  const { now } = opts;
  refreshProjections(db);
  const accounts: Account[] = accountGroups(db, instanceId, now);
  const accountOf = dealAccounts(accounts);
  const digits = instanceMoneyDigits(db, instanceId);
  const tripAccount = (t: { broker: string | null; accountId: string | null }) => (t.broker == null && t.accountId == null ? null : accountOf(t.broker ?? "", t.accountId));
  const open = openTrips(db, instanceId);
  const closed = closedTrips(db, instanceId);
  yield;

  let daysChecked = 0, diffs = 0;
  const upSummary = statement(db,
    `INSERT INTO reconciliation_accounts (instance_id, account, label, first_day, last_day, through_day, days_ok, days_diff, days_incomplete, positions, ledger, checked_at)
     VALUES (@instanceId, @account, @label, @firstDay, @lastDay, @throughDay, @ok, @diff, @incomplete, @positions, @ledger, @checkedAt)
     ON CONFLICT(instance_id, account) DO UPDATE SET label=excluded.label, first_day=excluded.first_day, last_day=excluded.last_day,
       through_day=excluded.through_day, days_ok=excluded.days_ok, days_diff=excluded.days_diff, days_incomplete=excluded.days_incomplete,
       positions=excluded.positions, ledger=excluded.ledger, checked_at=excluded.checked_at`);
  for (const account of accounts) {
    const r = yield* reconcileDays(db, instanceId, account, accountOf, digits, now);
    daysChecked += r.checked;
    diffs += r.diffs;
    const counts = new Map((statement(db,
      "SELECT status, COUNT(*) n, MIN(day) first, MAX(day) last FROM reconciliations WHERE instance_id=? AND account=? GROUP BY status",
    ).all(instanceId, account.key) as Array<{ status: DayStatus; n: number; first: string; last: string }>).map((c) => [c.status, c]));
    const range = statement(db, "SELECT MIN(day) first, MAX(day) last FROM reconciliations WHERE instance_id=? AND account=?")
      .get(instanceId, account.key) as { first: string | null; last: string | null };
    const firstDiff = counts.get("diff")?.first ?? null;
    const throughDay = firstDiff != null ? previousDay(firstDiff, range.first) : (counts.get("ok") ? range.last : null);
    const positions = checkPositions(account, open.filter((t) => tripAccount(t) === account), opts.positions ?? [], now);
    const ledger = checkLedger(closed.filter((t) => tripAccount(t) === account), digits);
    upSummary.run({
      instanceId, account: account.key, label: account.label, firstDay: range.first, lastDay: range.last, throughDay,
      ok: counts.get("ok")?.n ?? 0, diff: counts.get("diff")?.n ?? 0, incomplete: counts.get("incomplete")?.n ?? 0,
      positions: JSON.stringify(positions), ledger: JSON.stringify(ledger), checkedAt: now,
    });
    yield;
  }
  // an account the views no longer group the same way (its labels regrouped) is dropped with its days
  const keys = JSON.stringify(accounts.map((a) => a.key));
  db.transaction(() => {
    statement(db, "DELETE FROM reconciliation_accounts WHERE instance_id=? AND account NOT IN (SELECT value FROM json_each(?))").run(instanceId, keys);
    statement(db, "DELETE FROM reconciliations WHERE instance_id=? AND account NOT IN (SELECT value FROM json_each(?))").run(instanceId, keys);
  })();
  bumpReconciliation(db, instanceId);
  return { accounts: accounts.length, daysChecked, diffs };
}

/** The day before `day`, or null when `day` is the first stored one. */
function previousDay(day: string, first: string | null): string | null {
  return first == null || day <= first ? null : dayKey(dayStart(day) - DAY);
}

/** Runs every step at once: for tests and callers that do not need to yield. */
export function reconcile(db: Db, instanceId: string, opts: { now: number; positions?: readonly VenuePositionsReport[] }): ReconcileResult {
  const steps = reconcileSteps(db, instanceId, opts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** The stored results of the instance's latest run: one summary row per account and its days that are not ok. */
export function reconciliation(db: Db, instanceId: string): Reconciliation {
  const rows = statement(db,
    `SELECT account, label, first_day firstDay, last_day lastDay, through_day throughDay, days_ok daysOk, days_diff daysDiff,
       days_incomplete daysIncomplete, positions, ledger, checked_at checkedAt
     FROM reconciliation_accounts WHERE instance_id=? ORDER BY label, account`,
  ).all(instanceId) as Array<Omit<AccountReconciliation, "days" | "positions" | "ledger"> & { positions: string; ledger: string }>;
  const days = statement(db,
    `SELECT day, status, reason, start_ts startTs, end_ts endTs, start_balance startBalance, end_balance endBalance,
       deal_net dealNet, diff, deals, checked_at checkedAt
     FROM reconciliations INDEXED BY idx_reconciliations_open
     WHERE instance_id=? AND account=? AND status <> 'ok' ORDER BY day DESC LIMIT ${LISTED_DAYS}`);
  const digits = instanceMoneyDigits(db, instanceId);
  const accounts = rows.map((r) => ({
    ...r,
    positions: JSON.parse(r.positions) as PositionsCheck,
    ledger: JSON.parse(r.ledger) as LedgerCheck,
    days: (days.all(instanceId, r.account) as Array<Omit<ReconciledDay, "balanceChange">>).map((d) => ({
      ...d,
      balanceChange: d.startBalance != null && d.endBalance != null ? roundMoney(d.endBalance - d.startBalance, digits) : null,
    })),
  }));
  return { instanceId, digits, checkedAt: accounts.reduce<number | null>((m, a) => (m == null || a.checkedAt > m ? a.checkedAt : m), null), accounts };
}
