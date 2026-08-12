import type { Db } from "./db.js";
import type { Envelope } from "@qkt-insights/contract";

export interface AccountState {
  broker: string; currency: string; balance: number; equity: number;
  margin?: number; marginFree?: number; openProfit?: number; marginLevel?: number;
  /** Broker account identity, so the dashboard can say whose equity it shows on a shared account. */
  login?: string; server?: string; name?: string;
  lastSeen: number;
}

interface StoredAccountState extends AccountState {
  instanceId: string;
}

export interface LivePosition {
  ticket: string; symbol: string; side: string; qty: number;
  entryPrice: number; currentPrice?: number; profit?: number; swap?: number;
  openedAt?: number; strategyId?: string | null;
  /** Venue-side protective levels (0/absent when none set at the broker). */
  stopLoss?: number; takeProfit?: number;
  /** What the engine asked for — differs from venue truth while a modify is in flight. */
  requestedStopLoss?: number; requestedTakeProfit?: number;
  magic?: number; clientOrderId?: string;
}

/** A resting (pending) order at the broker: limit/stop waiting to trigger. */
export interface LivePendingOrder {
  ticket: string; symbol: string; side: string; orderType?: string;
  qty: number; price?: number;
  stopLoss?: number; takeProfit?: number;
  expiresAt?: number; createdAt?: number;
  magic?: number; clientOrderId?: string; strategyId?: string | null;
}

export interface LiveStateSnapshot {
  accounts: Array<AccountState & { instanceId: string; stale: boolean }>;
  positions: Array<{ instanceId: string; broker: string; at: number; stale: boolean; list: LivePosition[] }>;
  orders: Array<{ instanceId: string; broker: string; at: number; stale: boolean; list: LivePendingOrder[] }>;
}

function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

function decimalText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null;
}

/**
 * Last-value broker state, kept in memory only: account snapshots and open
 * position lists keyed by `instance:broker`. Keyed maps make duplicate rows
 * structurally impossible; a restart starts empty and repopulates within one
 * poll cycle from qkt's BrokerStatePoller.
 */
export class LiveStateStore {
  private accounts = new Map<string, StoredAccountState>();
  private positions = new Map<string, { at: number; list: LivePosition[] }>();
  private orders = new Map<string, { at: number; list: LivePendingOrder[] }>();

  /** Returns true when the visible state changed (drives WS broadcasts). */
  upsert(instanceId: string, e: Envelope): boolean {
    if (e.type === "state.account") {
      const p = e.payload;
      const key = accountKey(instanceId, p);
      const prev = this.accounts.get(key);
      const next: StoredAccountState = { instanceId, broker: prev?.broker ?? displayBroker(p.broker), currency: p.currency, balance: p.balance, equity: p.equity,
        margin: p.margin, marginFree: p.marginFree, openProfit: p.openProfit, marginLevel: p.marginLevel,
        login: p.login, server: p.server, name: p.name,
        lastSeen: e.ts };
      this.accounts.set(key, next);
      if (!prev) return true;
      return (["broker", "currency", "balance", "equity", "margin", "marginFree", "openProfit", "marginLevel", "login", "server", "name"] as const)
        .some((f) => prev[f] !== next[f]);
    }
    if (e.type === "state.positions") {
      const p = e.payload;
      const key = `${instanceId}:${p.broker}`;
      const prev = this.positions.get(key);
      const previousStrategies = new Map(prev?.list.map((x) => [x.ticket, x.strategyId]));
      const list: LivePosition[] = p.positions.map((x: LivePosition) => ({ ticket: x.ticket, symbol: x.symbol, side: x.side,
        qty: x.qty, entryPrice: x.entryPrice, currentPrice: x.currentPrice, profit: x.profit, swap: x.swap,
        openedAt: x.openedAt, strategyId: x.strategyId ?? previousStrategies.get(x.ticket) ?? null,
        stopLoss: x.stopLoss, takeProfit: x.takeProfit,
        requestedStopLoss: x.requestedStopLoss, requestedTakeProfit: x.requestedTakeProfit,
        magic: x.magic, clientOrderId: x.clientOrderId }));
      this.positions.set(key, { at: e.ts, list });
      return !prev || JSON.stringify(prev.list) !== JSON.stringify(list);
    }
    if (e.type === "state.orders") {
      const p = e.payload;
      const key = `${instanceId}:${p.broker}`;
      const prev = this.orders.get(key);
      const previousStrategies = new Map(prev?.list.map((x) => [x.ticket, x.strategyId]));
      const list: LivePendingOrder[] = p.orders.map((x: LivePendingOrder) => ({ ticket: x.ticket, symbol: x.symbol,
        side: x.side, orderType: x.orderType, qty: x.qty, price: x.price,
        stopLoss: x.stopLoss, takeProfit: x.takeProfit, expiresAt: x.expiresAt, createdAt: x.createdAt,
        magic: x.magic, clientOrderId: x.clientOrderId,
        strategyId: x.strategyId ?? previousStrategies.get(x.ticket) ?? null }));
      this.orders.set(key, { at: e.ts, list });
      return !prev || JSON.stringify(prev.list) !== JSON.stringify(list);
    }
    return false;
  }

  snapshot(now: number, staleAfterMs = 30_000): LiveStateSnapshot {
    const accounts = [...this.accounts.values()].map((a) => ({ ...a, stale: now - a.lastSeen > staleAfterMs }));
    const positions = [...this.positions.entries()].map(([key, p]) => {
      const [instanceId, broker] = splitKey(key);
      return { instanceId, broker, at: p.at, stale: now - p.at > staleAfterMs, list: p.list };
    });
    const orders = [...this.orders.entries()].map(([key, o]) => {
      const [instanceId, broker] = splitKey(key);
      return { instanceId, broker, at: o.at, stale: now - o.at > staleAfterMs, list: o.list };
    });
    return { accounts, positions, orders };
  }

  /**
   * Last value per (instance, broker) into account_equity for the current minute.
   * A stale account (no poll within staleAfterMs, e.g. qkt is down) is skipped:
   * carrying its last equity into every new minute would paint a flat plateau the
   * broker never reported. Leaving the gap is the honest curve.
   */
  flushRollup(db: Db, now: number, staleAfterMs = 90_000): void {
    const minute = Math.floor(now / 60_000) * 60_000;
    const up = db.prepare(
      `INSERT INTO account_equity
         (instance_id, broker, minute_ts, balance, equity, open_profit,
          balance_decimal, equity_decimal, open_profit_decimal)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(instance_id, broker, minute_ts)
       DO UPDATE SET balance=excluded.balance, equity=excluded.equity, open_profit=excluded.open_profit,
         balance_decimal=excluded.balance_decimal, equity_decimal=excluded.equity_decimal,
         open_profit_decimal=excluded.open_profit_decimal`,
    );
    for (const a of this.accounts.values()) {
      if (now - a.lastSeen > staleAfterMs) continue;
      up.run(a.instanceId, a.broker, minute, a.balance, a.equity, a.openProfit ?? null,
        decimalText(a.balance), decimalText(a.equity), decimalText(a.openProfit));
    }
  }
}

function accountKey(instanceId: string, p: { broker: string; login?: string; server?: string }): string {
  if (p.login && p.server) return JSON.stringify([instanceId, p.server, p.login]);
  return JSON.stringify([instanceId, p.broker]);
}

function displayBroker(broker: string): string {
  return broker.replace(/_S\d+$/u, "");
}
