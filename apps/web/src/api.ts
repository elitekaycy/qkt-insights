export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
  }
}

export async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function login(password: string): Promise<boolean> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    credentials: "same-origin",
  });
  return res.ok;
}

export interface InstanceRow {
  id: string;
  name: string | null;
  firstSeen: number;
  lastSeen: number;
  lastSeq: number;
}
export interface HealthRow {
  instanceId: string;
  lastSeen: number;
  lastSeq: number;
  strategies: number;
}
export interface StrategyRow {
  strategyId: string;
  firstSeen: number;
  lastSeen: number;
  equity: number | null;
  startingBalance: number | null;
}
export interface OrderRow {
  orderId: string;
  strategyId: string | null;
  symbol: string | null;
  side: string | null;
  type: string | null;
  state: string;
  qty: number | null;
  cumQty: number;
  avgPrice: number | null;
  createdTs: number;
  updatedTs: number;
}
export interface TradeRow {
  id: string;
  strategyId: string | null;
  ts: number;
  payload: { orderId: string; symbol: string; side: string; price: number; qty: number; ts: number };
}
