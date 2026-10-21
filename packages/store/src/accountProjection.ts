import type { Db } from "./db.js";
import { statement } from "./statements.js";

/**
 * The account equity projections (migration 031): per-minute drawdown walks per broker label and
 * for the instance TOTAL, and the label statistics the account grouping is decided from. Readers
 * use them to answer any cutoff with a few seeks; whenever an input they cannot reproduce exactly
 * is present (a row without equity, a minute three labels share) they report null and the caller
 * scans the minutes as it always did.
 */

/** The TOTAL walk's scope in account_drawdown_state; broker labels are never empty. */
export const TOTAL_SCOPE = "";

/** Rows folded per rebuild transaction. */
const ROWS_PER_BATCH = 50_000;

interface Walk { peak: number; peakTs: number; maxDd: number | null; points: number }

const EMPTY_WALK: Walk = { peak: 0, peakTs: 0, maxDd: null, points: 0 };

/** One step of accountDrawdown's walk: the running peak (from 0), and the deepest drawdown below it, in percent. */
function step(w: Walk, ts: number, equity: number): void {
  w.points++;
  if (equity > w.peak) { w.peak = equity; w.peakTs = ts; }
  if (w.peak > 0) {
    const dd = ((w.peak - equity) / w.peak) * 100;
    if (w.maxDd == null || dd > w.maxDd) w.maxDd = dd;
  }
}

export interface StateRow { minuteTs: number; equity: number; peak: number; peakTs: number; maxDd: number | null; points: number }

export function stateAt(db: Db, instanceId: string, scope: string, to: number): StateRow | undefined {
  return statement(db,
    `SELECT minute_ts minuteTs, equity, peak, peak_ts peakTs, max_dd maxDd, points FROM account_drawdown_state
     WHERE instance_id=? AND scope=? AND minute_ts<=? ORDER BY minute_ts DESC LIMIT 1`,
  ).get(instanceId, scope, to) as StateRow | undefined;
}

function stateBefore(db: Db, instanceId: string, scope: string, minute: number): Walk {
  const r = stateAt(db, instanceId, scope, minute - 1);
  return r ? { peak: r.peak, peakTs: r.peakTs, maxDd: r.maxDd, points: r.points } : { ...EMPTY_WALK };
}

const insState = (db: Db) => statement(db,
  "INSERT INTO account_drawdown_state (instance_id, scope, minute_ts, equity, peak, peak_ts, max_dd, points) VALUES (?,?,?,?,?,?,?,?)",
);

/**
 * Rewrites one label's walk from `from` on, at most `limit` minutes; returns the minute to go on
 * from, or null when the label is done.
 */
function walkLabel(db: Db, instanceId: string, broker: string, from: number, limit = Number.MAX_SAFE_INTEGER): number | null {
  const w = stateBefore(db, instanceId, broker, from);
  statement(db, "DELETE FROM account_drawdown_state WHERE instance_id=? AND scope=? AND minute_ts>=?").run(instanceId, broker, from);
  const rows = statement(db,
    `SELECT minute_ts ts, equity FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts>=? AND equity IS NOT NULL
     ORDER BY minute_ts LIMIT ?`,
  ).all(instanceId, broker, from, limit === Number.MAX_SAFE_INTEGER ? -1 : limit + 1) as Array<{ ts: number; equity: number }>;
  const ins = insState(db);
  const take = Math.min(rows.length, limit);
  for (let i = 0; i < take; i++) {
    const r = rows[i]!;
    step(w, r.ts, r.equity);
    ins.run(instanceId, broker, r.ts, r.equity, w.peak, w.peakTs, w.maxDd, w.points);
  }
  return rows.length > limit ? rows[limit]!.ts : null;
}

/** The labels reporting (with equity) at one minute, in byte order. */
function labelsAtMinute(db: Db, instanceId: string, minute: number): string[] {
  return (statement(db,
    "SELECT broker FROM account_equity WHERE instance_id=? AND minute_ts=? AND equity IS NOT NULL ORDER BY broker",
  ).all(instanceId, minute) as Array<{ broker: string }>).map((r) => r.broker);
}

function pairsOf(labels: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) out.push([labels[i]!, labels[j]!]);
  return out;
}

/** Brings one minute's shared-label record and the pair counts in line with the stored rows. */
function syncMinute(db: Db, instanceId: string, minute: number): void {
  const prior = statement(db, "SELECT labels FROM account_minute_labels WHERE instance_id=? AND minute_ts=?").get(instanceId, minute) as { labels: string } | undefined;
  const before = prior ? (JSON.parse(prior.labels) as string[]) : [];
  const now = labelsAtMinute(db, instanceId, minute);
  const after = now.length >= 2 ? now : [];
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const key = (p: [string, string]) => JSON.stringify(p);
  const had = new Set(pairsOf(before).map(key));
  const has = new Set(pairsOf(after).map(key));
  const bump = statement(db,
    `INSERT INTO account_label_pairs (instance_id, label_a, label_b, shared, last_shared) VALUES (?,?,?,1,?)
     ON CONFLICT(instance_id, label_a, label_b) DO UPDATE SET shared=shared+1, last_shared=max(last_shared, excluded.last_shared)`,
  );
  const drop = statement(db, "UPDATE account_label_pairs SET shared=shared-1 WHERE instance_id=? AND label_a=? AND label_b=?");
  for (const p of pairsOf(after)) if (!had.has(key(p))) bump.run(instanceId, p[0], p[1], minute);
  for (const p of pairsOf(before)) if (!has.has(key(p))) drop.run(instanceId, p[0], p[1]);
  if (after.length === 0) statement(db, "DELETE FROM account_minute_labels WHERE instance_id=? AND minute_ts=?").run(instanceId, minute);
  else statement(db,
    "INSERT INTO account_minute_labels (instance_id, minute_ts, labels, n) VALUES (?,?,?,?) ON CONFLICT(instance_id, minute_ts) DO UPDATE SET labels=excluded.labels, n=excluded.n",
  ).run(instanceId, minute, JSON.stringify(after), after.length);
}

/** Keeps a label's first minute and first reported identity right after a change at `minute`. */
function syncLabel(db: Db, instanceId: string, broker: string, minute: number): void {
  const meta = statement(db, "SELECT first_ts firstTs, identity, identity_ts identityTs FROM account_labels WHERE instance_id=? AND broker=?")
    .get(instanceId, broker) as { firstTs: number; identity: string | null; identityTs: number | null } | undefined;
  const row = statement(db, "SELECT equity, account FROM account_equity WHERE instance_id=? AND broker=? AND minute_ts=?")
    .get(instanceId, broker, minute) as { equity: number | null; account: string | null } | undefined;
  const counts = row != null && row.equity != null;
  let firstTs = meta?.firstTs ?? null;
  let identity = meta?.identity ?? null;
  let identityTs = meta?.identityTs ?? null;
  if (firstTs === minute && !counts || firstTs == null && !counts) {
    firstTs = (statement(db, "SELECT minute_ts ts FROM account_equity WHERE instance_id=? AND broker=? AND equity IS NOT NULL ORDER BY minute_ts LIMIT 1")
      .get(instanceId, broker) as { ts: number } | undefined)?.ts ?? null;
  } else if (counts && (firstTs == null || minute < firstTs)) firstTs = minute;
  if (identityTs === minute) {
    const first = statement(db,
      "SELECT minute_ts ts, account FROM account_equity WHERE instance_id=? AND broker=? AND equity IS NOT NULL AND account IS NOT NULL ORDER BY minute_ts LIMIT 1",
    ).get(instanceId, broker) as { ts: number; account: string } | undefined;
    identity = first?.account ?? null;
    identityTs = first?.ts ?? null;
  } else if (counts && row.account != null && (identityTs == null || minute < identityTs)) {
    identity = row.account;
    identityTs = minute;
  }
  if (firstTs == null) statement(db, "DELETE FROM account_labels WHERE instance_id=? AND broker=?").run(instanceId, broker);
  else statement(db,
    `INSERT INTO account_labels (instance_id, broker, first_ts, identity, identity_ts) VALUES (?,?,?,?,?)
     ON CONFLICT(instance_id, broker) DO UPDATE SET first_ts=excluded.first_ts, identity=excluded.identity, identity_ts=excluded.identity_ts`,
  ).run(instanceId, broker, firstTs, identity, identityTs);
}

export interface LabelStat { broker: string; firstTs: number; identity: string | null; size: number }

/**
 * The inputs of the account grouping as of `to`: each label reporting by then, with its first
 * minute, identity and minutes reported, and the minutes each pair of labels shares. Null when a
 * minute by then has three or more labels: the per-pair counts no longer give a label's overlap
 * with a group of labels.
 */
export function groupingInputs(db: Db, instanceId: string, to: number): { labels: LabelStat[]; shared: (a: string, b: string) => number } | null {
  if (statement(db, "SELECT 1 FROM account_minute_labels WHERE instance_id=? AND n>=3 AND minute_ts<=? LIMIT 1").get(instanceId, to)) return null;
  const metas = statement(db,
    "SELECT broker, first_ts firstTs, identity, identity_ts identityTs FROM account_labels WHERE instance_id=? AND first_ts<=? ORDER BY first_ts, broker",
  ).all(instanceId, to) as Array<{ broker: string; firstTs: number; identity: string | null; identityTs: number | null }>;
  const labels = metas.map((m) => ({
    broker: m.broker, firstTs: m.firstTs,
    identity: m.identityTs != null && m.identityTs <= to ? m.identity : null,
    size: stateAt(db, instanceId, m.broker, to)?.points ?? 0,
  }));
  const pairs = new Map<string, number>();
  let later = false;
  for (const p of statement(db, "SELECT label_a a, label_b b, shared, last_shared last FROM account_label_pairs WHERE instance_id=? AND shared>0").all(instanceId) as Array<{ a: string; b: string; shared: number; last: number }>) {
    pairs.set(JSON.stringify([p.a, p.b]), p.shared);
    if (p.last > to) later = true;
  }
  if (later) {
    for (const r of statement(db, "SELECT labels FROM account_minute_labels WHERE instance_id=? AND minute_ts>?").all(instanceId, to) as Array<{ labels: string }>) {
      for (const [a, b] of pairsOf(JSON.parse(r.labels) as string[])) {
        const k = JSON.stringify([a, b]);
        pairs.set(k, (pairs.get(k) ?? 0) - 1);
      }
    }
  }
  const shared = (a: string, b: string) => pairs.get(JSON.stringify(a < b ? [a, b] : [b, a])) ?? 0;
  return { labels, shared };
}

/** Byte-order comparison, as SQLite's BINARY collation sorts the labels. */
export function binaryCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * accountDrawdown's TOTAL grouping: labels in order of their first minute take turns for one
 * account when they share at most 1% of the shorter series' minutes; labels that report together
 * are separate accounts. Each chain lists its labels in the order they joined.
 */
export function totalChains(inputs: { labels: LabelStat[]; shared: (a: string, b: string) => number }): string[][] {
  const series = [...inputs.labels].sort((a, b) => a.firstTs - b.firstTs || binaryCompare(a.broker, b.broker));
  const accounts: Array<{ labels: string[]; points: number }> = [];
  for (const sr of series) {
    const account = accounts.find((acc) => {
      let shared = 0;
      for (const l of acc.labels) shared += inputs.shared(sr.broker, l);
      return shared <= Math.floor(Math.min(sr.size, acc.points) * 0.01);
    });
    if (account) { account.labels.push(sr.broker); account.points += sr.size; }
    else accounts.push({ labels: [sr.broker], points: sr.size });
  }
  return accounts.map((a) => a.labels);
}

/** Rewrites the TOTAL walk from `from` on under `chains`, at most `limit` rows; returns where to go on, or null. */
function walkTotal(db: Db, instanceId: string, chains: string[][], from: number, limit = Number.MAX_SAFE_INTEGER): number | null {
  const chainOf = new Map<string, { chain: number; rank: number }>();
  chains.forEach((labels, chain) => labels.forEach((l, rank) => chainOf.set(l, { chain, rank })));
  const w = stateBefore(db, instanceId, TOTAL_SCOPE, from);
  // Each chain's value going in: its latest minute before `from`, the later-joined label on a tie.
  const last: Array<number | null> = chains.map(() => null);
  chains.forEach((labels, c) => {
    let best: { ts: number; rank: number; equity: number } | null = null;
    labels.forEach((l, rank) => {
      const s = stateAt(db, instanceId, l, from - 1);
      if (s && (best == null || s.minuteTs > best.ts || (s.minuteTs === best.ts && rank > best.rank))) best = { ts: s.minuteTs, rank, equity: s.equity };
    });
    last[c] = (best as { equity: number } | null)?.equity ?? null;
  });
  statement(db, "DELETE FROM account_drawdown_state WHERE instance_id=? AND scope=? AND minute_ts>=?").run(instanceId, TOTAL_SCOPE, from);
  const rows = statement(db,
    `SELECT broker, minute_ts ts, equity FROM account_equity WHERE instance_id=? AND minute_ts>=? AND equity IS NOT NULL
     ORDER BY minute_ts, broker LIMIT ?`,
  ).all(instanceId, from, limit === Number.MAX_SAFE_INTEGER ? -1 : limit + 1) as Array<{ broker: string; ts: number; equity: number }>;
  // Stop on a minute boundary so a minute is never split across batches.
  let end = rows.length;
  let resume: number | null = null;
  if (rows.length > limit) {
    resume = rows[limit]!.ts;
    end = limit;
    while (end > 0 && rows[end - 1]!.ts === resume) end--;
    if (end === 0) { end = rows.length; resume = null; }
  }
  const ins = insState(db);
  for (let i = 0; i < end;) {
    const ts = rows[i]!.ts;
    const rank: number[] = chains.map(() => -1);
    for (; i < end && rows[i]!.ts === ts; i++) {
      const at = chainOf.get(rows[i]!.broker);
      if (!at || at.rank < rank[at.chain]!) continue;
      rank[at.chain] = at.rank;
      last[at.chain] = rows[i]!.equity;
    }
    let sum = 0;
    for (const v of last) if (v != null) sum += v;
    step(w, ts, sum);
    ins.run(instanceId, TOTAL_SCOPE, ts, sum, w.peak, w.peakTs, w.maxDd, w.points);
  }
  return resume;
}

export function storedChains(db: Db, instanceId: string): string[][] | null {
  const r = statement(db, "SELECT chains FROM account_groups WHERE instance_id=?").get(instanceId) as { chains: string } | undefined;
  return r ? (JSON.parse(r.chains) as string[][]) : null;
}

function storeChains(db: Db, instanceId: string, chains: string[][] | null): void {
  if (chains == null) statement(db, "DELETE FROM account_groups WHERE instance_id=?").run(instanceId);
  else statement(db, "INSERT INTO account_groups (instance_id, chains) VALUES (?,?) ON CONFLICT(instance_id) DO UPDATE SET chains=excluded.chains")
    .run(instanceId, JSON.stringify(chains));
}

/** Folds changed account minutes ("broker\0minute" keys) into the walks and the grouping inputs. */
export function recomputeAccountKeys(db: Db, rows: Array<{ instanceId: string; key: string }>): void {
  const byInstance = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    const i = r.key.lastIndexOf("\u0000");
    const broker = r.key.slice(0, i);
    const minute = Number(r.key.slice(i + 1));
    let labels = byInstance.get(r.instanceId);
    if (!labels) { labels = new Map(); byInstance.set(r.instanceId, labels); }
    const list = labels.get(broker) ?? [];
    list.push(minute);
    labels.set(broker, list);
  }
  for (const [instanceId, labels] of byInstance) {
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const [broker, minutes] of labels) {
      for (const m of new Set(minutes)) {
        syncMinute(db, instanceId, m);
        syncLabel(db, instanceId, broker, m);
      }
      const from = Math.min(...minutes);
      earliest = Math.min(earliest, from);
      walkLabel(db, instanceId, broker, from);
    }
    refreshTotal(db, instanceId, earliest);
  }
}

/** Re-walks TOTAL from `from`, or from the start when the grouping changed. */
function refreshTotal(db: Db, instanceId: string, from: number): void {
  const inputs = groupingInputs(db, instanceId, Number.MAX_SAFE_INTEGER);
  const chains = inputs ? totalChains(inputs) : null;
  const stored = storedChains(db, instanceId);
  if (chains == null) {
    // A three-label minute: TOTAL is read by the full scan until the minute is gone.
    storeChains(db, instanceId, null);
    statement(db, "DELETE FROM account_drawdown_state WHERE instance_id=? AND scope=?").run(instanceId, TOTAL_SCOPE);
    return;
  }
  const same = stored != null && JSON.stringify(stored) === JSON.stringify(chains);
  storeChains(db, instanceId, chains);
  walkTotal(db, instanceId, chains, same ? from : Number.MIN_SAFE_INTEGER);
}

export function clearAccountProjection(db: Db): void {
  for (const t of ["account_drawdown_state", "account_labels", "account_minute_labels", "account_label_pairs", "account_groups"]) statement(db, `DELETE FROM ${t}`).run();
  statement(db, "DELETE FROM projection_dirty WHERE kind='account'").run();
}

interface RebuildCursor { instanceId: string; stage: "labels" | "minutes" | "total"; broker?: string; from: number }

/**
 * One rebuild batch: per instance, each label's walk and first minute and identity, then the
 * shared minutes, then the TOTAL walk, ROWS_PER_BATCH rows at a time.
 */
export function accountRebuildStep(db: Db, cursorText: string | null): string | null {
  let c: RebuildCursor | null = cursorText ? (JSON.parse(cursorText) as RebuildCursor) : null;
  if (c == null) {
    const first = statement(db, "SELECT instance_id i FROM account_equity ORDER BY instance_id LIMIT 1").get() as { i: string } | undefined;
    if (!first) return null;
    c = { instanceId: first.i, stage: "labels", from: Number.MIN_SAFE_INTEGER };
  }
  const { instanceId } = c;
  if (c.stage === "labels") {
    const broker = c.broker ?? (statement(db, "SELECT broker b FROM account_equity WHERE instance_id=? ORDER BY broker LIMIT 1").get(instanceId) as { b: string }).b;
    const next = walkLabel(db, instanceId, broker, c.from, ROWS_PER_BATCH);
    if (next != null) return JSON.stringify({ ...c, broker, from: next });
    const firstTs = statement(db, "SELECT minute_ts ts FROM account_equity WHERE instance_id=? AND broker=? AND equity IS NOT NULL ORDER BY minute_ts LIMIT 1").get(instanceId, broker) as { ts: number } | undefined;
    if (firstTs) {
      const id = statement(db,
        "SELECT minute_ts ts, account FROM account_equity WHERE instance_id=? AND broker=? AND equity IS NOT NULL AND account IS NOT NULL ORDER BY minute_ts LIMIT 1",
      ).get(instanceId, broker) as { ts: number; account: string } | undefined;
      statement(db, "INSERT INTO account_labels (instance_id, broker, first_ts, identity, identity_ts) VALUES (?,?,?,?,?)")
        .run(instanceId, broker, firstTs.ts, id?.account ?? null, id?.ts ?? null);
    }
    const nextLabel = statement(db, "SELECT broker b FROM account_equity WHERE instance_id=? AND broker>? ORDER BY broker LIMIT 1").get(instanceId, broker) as { b: string } | undefined;
    if (nextLabel) return JSON.stringify({ instanceId, stage: "labels", broker: nextLabel.b, from: Number.MIN_SAFE_INTEGER });
    return JSON.stringify({ instanceId, stage: "minutes", from: Number.MIN_SAFE_INTEGER });
  }
  if (c.stage === "minutes") {
    const rows = statement(db,
      "SELECT minute_ts ts, COUNT(*) n FROM account_equity WHERE instance_id=? AND minute_ts>=? AND equity IS NOT NULL GROUP BY minute_ts ORDER BY minute_ts LIMIT ?",
    ).all(instanceId, c.from, ROWS_PER_BATCH + 1) as Array<{ ts: number; n: number }>;
    const take = Math.min(rows.length, ROWS_PER_BATCH);
    for (let i = 0; i < take; i++) if (rows[i]!.n >= 2) syncMinute(db, instanceId, rows[i]!.ts);
    if (rows.length > ROWS_PER_BATCH) return JSON.stringify({ ...c, from: rows[ROWS_PER_BATCH]!.ts });
    const inputs = groupingInputs(db, instanceId, Number.MAX_SAFE_INTEGER);
    storeChains(db, instanceId, inputs ? totalChains(inputs) : null);
    return JSON.stringify({ instanceId, stage: "total", from: Number.MIN_SAFE_INTEGER });
  }
  const chains = storedChains(db, instanceId);
  const next = chains ? walkTotal(db, instanceId, chains, c.from, ROWS_PER_BATCH) : null;
  if (next != null) return JSON.stringify({ ...c, from: next });
  const nextInstance = statement(db, "SELECT instance_id i FROM account_equity WHERE instance_id>? ORDER BY instance_id LIMIT 1").get(instanceId) as { i: string } | undefined;
  return nextInstance ? JSON.stringify({ instanceId: nextInstance.i, stage: "labels", from: Number.MIN_SAFE_INTEGER }) : null;
}

/** True while the instance has a minute stored without equity: the walks skip it, the full scan is exact. */
export function hasMinuteWithoutEquity(db: Db, instanceId: string): boolean {
  return statement(db, "SELECT 1 FROM account_equity WHERE instance_id=? AND equity IS NULL LIMIT 1").get(instanceId) != null;
}
