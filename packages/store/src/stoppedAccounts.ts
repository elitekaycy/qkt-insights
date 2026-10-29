import type { Db } from "./db.js";
import { accountGroups } from "./accountRisk.js";
import { accountVenueFacts } from "./currencies.js";
import type { AccountState, LiveStateSnapshot } from "./liveState.js";
import { statement } from "./statements.js";

/*
 * An account that stopped reporting (its daemon stopped, or the collector restarted after it went quiet) is gone from
 * collector memory, but its equity history and venue facts are stored. It stays in the live snapshot as a stopped
 * account with its last stored figures, so every page lists the same accounts under the same names.
 */

type SnapshotAccount = LiveStateSnapshot["accounts"][number];

/** `snapshot` with every stored account of `instanceIds` that is not in it added as stale and stopped. */
export function withStoppedAccounts(db: Db, snapshot: LiveStateSnapshot, instanceIds: readonly string[]): LiveStateSnapshot {
  const added: SnapshotAccount[] = [];
  const last = statement(db,
    `SELECT broker, minute_ts minuteTs, balance, equity, open_profit openProfit FROM account_equity
     WHERE instance_id=@i AND (account=@id OR broker IN (SELECT value FROM json_each(@labels)))
     ORDER BY minute_ts DESC LIMIT 1`,
  );
  for (const instanceId of instanceIds) {
    const live = snapshot.accounts.filter((a) => a.instanceId === instanceId);
    const facts = accountVenueFacts(db, instanceId);
    for (const g of accountGroups(db, instanceId)) {
      const reporting = live.some((a) =>
        (g.identity != null && a.accountId === g.identity) || g.labels.includes(a.broker) || (a.profiles ?? []).some((p) => g.labels.includes(p)));
      if (reporting) continue;
      const row = last.get({ i: instanceId, id: g.identity ?? g.key, labels: JSON.stringify(g.labels) }) as
        { broker: string; minuteTs: number; balance: number | null; equity: number | null; openProfit: number | null } | undefined;
      if (!row || row.balance == null || row.equity == null) continue;
      const f = facts.find((x) => x.account === (g.identity ?? g.key)) ?? facts.find((x) => g.labels.includes(x.label));
      const account: AccountState = {
        broker: g.label, currency: f?.currency ?? "USD", balance: row.balance, equity: row.equity,
        ...(row.openProfit != null ? { openProfit: row.openProfit } : {}),
        ...(g.identity ? { accountId: g.identity } : {}),
        ...(f?.login ? { login: f.login } : {}),
        ...(f?.connector ? { connector: f.connector } : {}),
        ...(f?.adapter ? { adapter: f.adapter } : {}),
        ...(f?.tradeMode ? { tradeMode: f.tradeMode } : {}),
        profiles: [...g.labels].sort(),
        lastSeen: row.minuteTs,
      };
      added.push({ ...account, instanceId, stale: true, stopped: true });
    }
  }
  return added.length === 0 ? snapshot : { ...snapshot, accounts: [...snapshot.accounts, ...added] };
}
