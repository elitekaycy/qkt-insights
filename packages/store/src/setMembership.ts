import type { Envelope } from "@qkt-insights/contract";
import type { Db } from "./db.js";
import { statement } from "./statements.js";

/*
 * The members of a strategy's moving symbol sets, from qkt's set.membership journal: every change of place
 * (join, leave, stick, release, stay, restore, unavailable) is one row of set_membership. They live in that table
 * alone, never in events, and no public view reads them (api publicView.ts).
 */

/** One stored change, newest first in `changes`. */
export interface SetMembershipRow {
  id: string;
  set: string;
  member: string;
  /** What qkt journalled, lower case: join, leave, stick, release, stay, restore, unavailable. */
  change: string;
  /** 1-based place in the ranking; null when the member is not ranked. */
  rank: number | null;
  /** Close (UTC ms) of the window whose evaluation made the change. */
  closeTs: number;
  reason: string | null;
  ts: number;
}

/** Where a member stands after its latest change: in the ranking, or out of it but kept while it holds. */
export type SetMemberState = "member" | "sticky";

/** A member that is in a set now: its latest change did not take it out. */
export interface SetMember {
  set: string;
  member: string;
  state: SetMemberState;
  /** Its latest change. */
  change: string;
  rank: number | null;
  /** Envelope time of its latest change. */
  since: number;
}

export interface SetMembershipView {
  /** By set, then rank (unranked last), then member. */
  members: SetMember[];
  /** The latest changes, newest first, at most the limit asked for. */
  changes: SetMembershipRow[];
}

/**
 * The state each journalled change leaves a member in. Absent: leave and release take it out, and unavailable is a
 * candidate that never joined (it shows in the changes only).
 */
const STATE_AFTER: Record<string, SetMemberState> = { join: "member", stay: "member", restore: "member", stick: "sticky" };

/** Records one set.membership envelope; false when its id was already stored. */
export function recordSetMembership(db: Db, instanceId: string, e: Envelope): boolean {
  if (e.type !== "set.membership") return false;
  const p = e.payload;
  return statement(db,
    `INSERT OR IGNORE INTO set_membership (instance_id, id, strategy_id, set_name, member, change, rank, close_ts, reason, ts, seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(instanceId, e.id, p.strategyId, p.set, p.member, p.change.toLowerCase(), p.rank ?? null, p.closeTs, p.reason ?? null, e.ts, e.seq).changes > 0;
}

/**
 * The strategy's set members now and its latest `limit` changes. A member's latest change says where it stands;
 * a restart restores every member it keeps at once, so a member whose latest change came before its set's latest
 * restore was dropped across the restart and is not listed.
 */
export function strategySetMembership(db: Db, instanceId: string, strategyId: string, limit = 50): SetMembershipView {
  const changes = statement(db,
    `SELECT id, set_name "set", member, change, rank, close_ts closeTs, reason, ts FROM set_membership
     WHERE instance_id=? AND strategy_id=? ORDER BY ts DESC, rowid DESC LIMIT ?`,
  ).all(instanceId, strategyId, Math.max(1, Math.min(limit, 500))) as SetMembershipRow[];
  const latest = statement(db,
    `SELECT set_name "set", member, change, rank, close_ts closeTs, ts FROM (
       SELECT *, row_number() OVER (PARTITION BY set_name, member ORDER BY ts DESC, rowid DESC) n
       FROM set_membership WHERE instance_id=? AND strategy_id=?)
     WHERE n=1`,
  ).all(instanceId, strategyId) as Array<Omit<SetMembershipRow, "id" | "reason">>;
  const restoredAt = new Map<string, number>();
  for (const r of latest) if (r.change === "restore") restoredAt.set(r.set, Math.max(restoredAt.get(r.set) ?? r.ts, r.ts));
  const members: SetMember[] = latest.flatMap((r) => {
    const state = STATE_AFTER[r.change];
    if (!state || r.ts < (restoredAt.get(r.set) ?? r.ts)) return [];
    return [{ set: r.set, member: r.member, state, change: r.change, rank: r.rank, since: r.ts }];
  });
  members.sort((a, b) => a.set.localeCompare(b.set) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.member.localeCompare(b.member));
  return { members, changes };
}
