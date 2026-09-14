import { createHmac, randomBytes } from "node:crypto";
import type { ClosedTradeRow, DealRow, StrategyRow, TradeRow } from "@qkt-insights/store";
import type { PerformanceBundle } from "./performance.js";

/*
 * Public responses are rebuilt field by field from these allow-lists. Nothing from an admin
 * response is forwarded wholesale, so a field added to a store row stays private until it is
 * listed here on purpose.
 */

const ID_KEY = randomBytes(32);

/** A stable stand-in for a ticket or order id: rows still join, the venue id never leaves. */
export function opaqueId(id: string | null | undefined): string | null {
  if (id == null || id === "") return null;
  return createHmac("sha256", ID_KEY).update(id).digest("hex").slice(0, 16);
}

/** "EXNESS_P549:GBPUSD" -> "GBPUSD": the prefix names a broker profile. */
export function publicSymbol(symbol: string | null | undefined): string {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}

const METADATA_STRINGS = ["dslName", "portfolioId", "portfolioName", "portfolioAlias"] as const;
const METADATA_NUMBERS = ["portfolioWeight", "allocatedCapital"] as const;
const RISK_NUMBERS = ["maxDrawdownPct", "maxDailyDrawdownPct"] as const;

function publicMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!meta) return out;
  for (const k of METADATA_STRINGS) if (typeof meta[k] === "string") out[k] = meta[k];
  for (const k of METADATA_NUMBERS) if (typeof meta[k] === "number") out[k] = meta[k];
  if (Array.isArray(meta.symbols)) out.symbols = [...new Set(meta.symbols.filter((s): s is string => typeof s === "string").map(publicSymbol))];
  const risk = meta.risk;
  if (risk && typeof risk === "object") {
    const picked: Record<string, number> = {};
    for (const k of RISK_NUMBERS) {
      const v = (risk as Record<string, unknown>)[k];
      if (typeof v === "number") picked[k] = v;
    }
    if (Object.keys(picked).length > 0) out.risk = picked;
  }
  return out;
}

export function publicStrategy(row: StrategyRow, closes: ClosedTradeRow[], cutoff: number): StrategyRow {
  return {
    strategyId: row.strategyId,
    firstSeen: row.firstSeen,
    lastSeen: Math.min(row.lastSeen, cutoff),
    startingBalance: row.startingBalance,
    definedCapital: row.definedCapital,
    metadata: publicMetadata(row.metadata),
    realizedNet: closes.length > 0 ? closes.reduce((a, c) => a + c.realized, 0) : null,
    dealCount: closes.length,
    active: true,
  };
}

function publicClose(c: ClosedTradeRow & { entryOrderId?: string | null; exitOrderId?: string | null; entryPrice?: number | null; exitPrice?: number; holdMs?: number | null }) {
  return {
    ts: c.ts, symbol: publicSymbol(c.symbol), side: c.side, qty: c.qty, price: c.price, realized: c.realized, entryTs: c.entryTs,
    orderId: opaqueId(c.orderId), entryOrderId: opaqueId(c.entryOrderId), exitOrderId: opaqueId(c.exitOrderId),
    ...(c.entryPrice !== undefined ? { entryPrice: c.entryPrice } : {}),
    ...(c.exitPrice !== undefined ? { exitPrice: c.exitPrice } : {}),
    ...(c.holdMs !== undefined ? { holdMs: c.holdMs } : {}),
  };
}

type Keyed = { key: string };

function relabelKeys<T extends Keyed>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, key: publicSymbol(r.key) }));
}

/**
 * Report, daily nets, drawdown periods, post-loss rows, day/hour cells, rolling points, costs,
 * normalized and execution figures are numbers keyed by time or bucket, so they pass as built.
 * Everything that can carry a venue id or a broker-prefixed symbol is rebuilt.
 */
export function publicBundle(b: PerformanceBundle) {
  return {
    ...b,
    // Order latency and fill counts describe orders whose positions may still be open; planned R:R
    // comes from every bracket submitted, open or not. Neither belongs on a public page.
    execution: undefined,
    normalized: b.normalized && { ...b.normalized, averagePlannedRiskReward: null, plannedRiskRewardSample: 0 },
    closes: b.closes?.map(publicClose),
    breakdowns: b.breakdowns && { ...b.breakdowns, bySymbol: relabelKeys(b.breakdowns.bySymbol) },
    contribution: b.contribution && { ...b.contribution, bySymbol: relabelKeys(b.contribution.bySymbol) },
    excursions: b.excursions && {
      ...b.excursions,
      rows: b.excursions.rows.map((r) => ({
        ticket: opaqueId(r.ticket) ?? "", symbol: publicSymbol(r.symbol), side: r.side, ts: r.ts, exitPnl: r.exitPnl,
        mae: r.mae, mfe: r.mfe, capturePct: r.capturePct, observations: r.observations,
      })),
    },
  };
}

export function publicTrade(t: TradeRow) {
  const p = t.payload as { orderId?: string; symbol?: string; side?: string; price?: number; qty?: number; ts?: number };
  return {
    id: opaqueId(t.id), strategyId: t.strategyId, ts: t.ts,
    payload: { orderId: opaqueId(p.orderId), symbol: publicSymbol(p.symbol), side: p.side ?? "", price: p.price ?? 0, qty: p.qty ?? 0, ts: p.ts ?? t.ts },
  };
}

export function publicDeal(d: DealRow & { fee?: number | null }) {
  return {
    id: opaqueId(d.id), broker: "Account", dealTicket: opaqueId(d.dealTicket), positionTicket: opaqueId(d.positionTicket), orderTicket: opaqueId(d.orderTicket),
    symbol: publicSymbol(d.symbol), side: d.side, entry: d.entry, qty: d.qty, price: d.price, profit: d.profit, commission: d.commission,
    swap: d.swap, fee: d.fee ?? null, magic: null, comment: null, strategyId: d.strategyId, ts: d.ts,
  };
}

/** Account labels become "Account", "Account 2", ... in order of first appearance; TOTAL keeps its name. */
export function accountLabeller(): (broker: string) => string {
  const labels = new Map<string, string>();
  return (broker) => {
    if (broker === "TOTAL") return broker;
    let label = labels.get(broker);
    if (!label) {
      label = labels.size === 0 ? "Account" : `Account ${labels.size + 1}`;
      labels.set(broker, label);
    }
    return label;
  };
}
