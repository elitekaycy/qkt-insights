import type { LiveAccount } from "./api";

/*
 * One strip per real venue account. qkt reports an account under a broker label, and a relabel
 * (ICM became ICMARKETS) or a per-profile copy leaves the old label in collector memory with its
 * last balance. Labels of one account are grouped the way the server stitches its equity series:
 * by account id when one is known, else by taking turns, which live state shows as
 * one label still reporting while the other has gone quiet.
 */

export interface AccountGroup {
  /** The label reporting now (the most recent one); its figures are the account's. */
  account: LiveAccount;
  /** Every label folded into this account, the shown one first. */
  labels: string[];
}

/** The venue account the collector resolved for the label, else null. */
export function accountIdentity(a: Pick<LiveAccount, "accountId">): string | null {
  return a.accountId ?? null;
}

/** A login with all but its last four characters hidden, e.g. "•••4821". */
export function maskLogin(login: string): string {
  return login.length <= 4 ? login : `•••${login.slice(-4)}`;
}

/** How much longer one label has been quiet than another before they read as taking turns. */
export const TURN_GAP_MS = 90_000;

/**
 * Groups one instance's live accounts into real accounts. Same identity: one account. A label
 * that went quiet well before exactly one other (no conflicting identity) took turns with it and
 * folds in; with several fresher accounts it cannot be placed, so it keeps its own strip.
 */
export function groupAccounts(accounts: readonly LiveAccount[]): AccountGroup[] {
  const groups: Array<{ members: LiveAccount[]; identity: string | null }> = [];
  for (const a of [...accounts].sort((x, y) => y.lastSeen - x.lastSeen)) {
    const id = accountIdentity(a);
    const same = id != null ? groups.find((g) => g.identity === id) : undefined;
    if (same) same.members.push(a);
    else groups.push({ members: [a], identity: id });
  }
  const kept: typeof groups = [];
  for (const g of groups) {
    const seen = g.members[0]!.lastSeen;
    const fresher = kept.filter((k) => k.members[0]!.lastSeen - seen > TURN_GAP_MS);
    const target = fresher.length === 1 ? fresher[0]! : undefined;
    const conflict = target != null && target.identity != null && g.identity != null && target.identity !== g.identity;
    if (g.members[0]!.stale && target && !conflict) target.members.push(...g.members);
    else kept.push(g);
  }
  return kept.map((g) => ({ account: g.members[0]!, labels: [...new Set(g.members.map((m) => m.broker))] }));
}

/** The shown account of every real account, instance by instance. */
export function realAccounts(accounts: readonly LiveAccount[]): LiveAccount[] {
  const byInstance = new Map<string, LiveAccount[]>();
  for (const a of accounts) byInstance.set(a.instanceId, [...(byInstance.get(a.instanceId) ?? []), a]);
  return [...byInstance.values()].flatMap((list) => groupAccounts(list).map((g) => g.account));
}
