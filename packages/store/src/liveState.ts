import type { Db } from "./db.js";
import type { Envelope } from "@qkt-insights/contract";

export interface AccountState {
  broker: string; currency: string; balance: number; equity: number;
  margin?: number; marginFree?: number; openProfit?: number; marginLevel?: number;
  lastSeen: number;
}

export interface LivePosition {
  ticket: string; symbol: string; side: string; qty: number;
  entryPrice: number; currentPrice?: number; profit?: number; swap?: number;
  openedAt?: number; strategyId?: string | null;
}

export interface LiveStateSnapshot {
  accounts: Array<AccountState & { instanceId: string; stale: boolean }>;
  positions: Array<{ instanceId: string; broker: string; at: number; stale: boolean; list: LivePosition[] }>;
}

function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Last-value broker state, kept in memory only: account snapshots and open
 * position lists keyed by `instance:broker`. Keyed maps make duplicate rows
 * structurally impossible; a restart starts empty and repopulates within one
 * poll cycle from qkt's BrokerStatePoller.
 */
export class LiveStateStore {
  private accounts = new Map<string, AccountState>();
  private positions = new Map<string, { at: number; list: LivePosition[] }>();

  /** Returns true when the visible state changed (drives WS broadcasts). */
  upsert(instanceId: string, e: Envelope): boolean {
    if (e.type === "state.account") {
      const p = e.payload;
      const key = `${instanceId}:${p.broker}`;
      const prev = this.accounts.get(key);
      const next: AccountState = { broker: p.broker, currency: p.currency, balance: p.balance, equity: p.equity,
        margin: p.margin, marginFree: p.marginFree, openProfit: p.openProfit, marginLevel: p.marginLevel,
        lastSeen: e.ts };
      this.accounts.set(key, next);
      if (!prev) return true;
      return (["broker", "currency", "balance", "equity", "margin", "marginFree", "openProfit", "marginLevel"] as const)
        .some((f) => prev[f] !== next[f]);
    }
    if (e.type === "state.positions") {
      const p = e.payload;
      const key = `${instanceId}:${p.broker}`;
      const prev = this.positions.get(key);
      const list: LivePosition[] = p.positions.map((x: LivePosition) => ({ ticket: x.ticket, symbol: x.symbol, side: x.side,
        qty: x.qty, entryPrice: x.entryPrice, currentPrice: x.currentPrice, profit: x.profit, swap: x.swap,
        openedAt: x.openedAt, strategyId: x.strategyId }));
      this.positions.set(key, { at: e.ts, list });
      return !prev || JSON.stringify(prev.list) !== JSON.stringify(list);
    }
    return false;
  }

  snapshot(now: number, staleAfterMs = 30_000): LiveStateSnapshot {
    const accounts = [...this.accounts.entries()].map(([key, a]) => {
      const [instanceId] = splitKey(key);
      return { ...a, instanceId, stale: now - a.lastSeen > staleAfterMs };
    });
    const positions = [...this.positions.entries()].map(([key, p]) => {
      const [instanceId, broker] = splitKey(key);
      return { instanceId, broker, at: p.at, stale: now - p.at > staleAfterMs, list: p.list };
    });
    return { accounts, positions };
  }

  /** Last value per (instance, broker) into account_equity for the current minute. */
  flushRollup(db: Db, now: number): void {
    const minute = Math.floor(now / 60_000) * 60_000;
    const up = db.prepare(
      `INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit)
       VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id, broker, minute_ts)
       DO UPDATE SET balance=excluded.balance, equity=excluded.equity, open_profit=excluded.open_profit`,
    );
    for (const [key, a] of this.accounts) {
      const [instanceId, broker] = splitKey(key);
      up.run(instanceId, broker, minute, a.balance, a.equity, a.openProfit ?? null);
    }
  }
}
