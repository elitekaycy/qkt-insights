import type { Db } from "./db.js";

/**
 * Write counters per database, so a reader can tell cheaply whether the rows behind a response
 * changed since it was last built. Each writer bumps the scopes it touched:
 *
 * - `strategy:<instance>|<strategy>`: money history of one strategy (deals, closes, snapshots,
 *   orders, trades, its starting balance). Every bump also bumps `instance:<instance>`.
 * - `unscoped:<instance>`: a trade or order event that names no strategy; it may belong to any.
 * - `marks:<instance>`: position valuations (excursions, delayed open P&L).
 * - `account:<instance>`: the account equity minute rollup.
 * - `reconciliation:<instance>`: a venue reconciliation run's results.
 * - `epoch`: anything broad (retention prune, declared capital), which every version includes.
 *
 * Counters live in memory and start at zero each boot; versions are only compared within one
 * process. A write by another process (collect and serve modes split over one file) shows up in
 * SQLite's `data_version`, which every version includes as well.
 */
const counters = new WeakMap<Db, Map<string, number>>();

function countersOf(db: Db): Map<string, number> {
  let c = counters.get(db);
  if (!c) {
    c = new Map();
    counters.set(db, c);
  }
  return c;
}

function bump(db: Db, key: string): void {
  const c = countersOf(db);
  c.set(key, (c.get(key) ?? 0) + 1);
}

/** A strategy's money history changed (strategyId null: a trade or order no strategy is named on). */
export function bumpStrategy(db: Db, instanceId: string, strategyId: string | null | undefined): void {
  bump(db, strategyId ? `strategy:${instanceId}|${strategyId}` : `unscoped:${instanceId}`);
  bump(db, `instance:${instanceId}`);
}

export function bumpMarks(db: Db, instanceId: string): void {
  bump(db, `marks:${instanceId}`);
}

export function bumpAccount(db: Db, instanceId: string): void {
  bump(db, `account:${instanceId}`);
}

export function bumpReconciliation(db: Db, instanceId: string): void {
  bump(db, `reconciliation:${instanceId}`);
}

export function bumpEpoch(db: Db): void {
  bump(db, "epoch");
}

/** The scopes a response reads from, as `bump*` names them. */
export type VersionScope =
  | { strategy: { instanceId: string; strategyId: string } }
  | { instance: string }
  | { marks: string }
  | { account: string }
  | { reconciliation: string };

function keysOf(scope: VersionScope): string[] {
  if ("strategy" in scope) return [`strategy:${scope.strategy.instanceId}|${scope.strategy.strategyId}`, `unscoped:${scope.strategy.instanceId}`];
  if ("instance" in scope) return [`instance:${scope.instance}`];
  if ("marks" in scope) return [`marks:${scope.marks}`];
  if ("reconciliation" in scope) return [`reconciliation:${scope.reconciliation}`];
  return [`account:${scope.account}`];
}

/** Changes whenever a write lands in any of the scopes, in this process or another. */
export function dataVersion(db: Db, scopes: VersionScope[]): string {
  const c = countersOf(db);
  const external = db.pragma("data_version", { simple: true }) as number;
  return [external, c.get("epoch") ?? 0, ...scopes.flatMap(keysOf).map((k) => c.get(k) ?? 0)].join(".");
}
