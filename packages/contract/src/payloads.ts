import { z } from "zod";

const side = z.enum(["BUY", "SELL"]);

export const payloadByType = {
  signal: z.object({ symbol: z.string(), side, note: z.string().optional() }),
  "order.submit": z.object({ orderId: z.string(), orderType: z.string(), symbol: z.string(), side, qty: z.number() }),
  "order.accepted": z.object({ orderId: z.string(), brokerOrderId: z.string() }),
  "order.filled": z.object({ orderId: z.string(), brokerOrderId: z.string().optional(), symbol: z.string(), price: z.number(), qty: z.number(), venueCosts: z.number().optional() }),
  "order.partially_filled": z.object({ orderId: z.string(), symbol: z.string(), price: z.number(), qty: z.number(), cumulativeQty: z.number() }),
  "order.cancelled": z.object({ orderId: z.string(), reason: z.string().optional() }),
  "order.rejected": z.object({ orderId: z.string(), reason: z.string() }),
  "order.modified": z.object({ orderId: z.string(), changes: z.record(z.string()) }),
  trade: z.object({ orderId: z.string(), symbol: z.string(), side, price: z.number(), qty: z.number(), ts: z.number() }),
  "risk.rejected": z.object({ reason: z.string(), symbol: z.string().optional(), side: side.optional(), qty: z.number().optional() }),
  "risk.halted": z.object({ strategyId: z.string(), reason: z.string() }),
  "risk.resumed": z.object({ strategyId: z.string() }),
  "position.reconciled": z.object({ symbol: z.string(), before: z.number(), after: z.number() }),
  "balances.updated": z.object({ balances: z.record(z.number()) }),
  "gateway.unreachable": z.object({ detail: z.string() }),
  "snapshot.equity": z.object({ strategyId: z.string(), realized: z.number(), unrealized: z.number(), equity: z.number(), startingBalance: z.number() }),
  "snapshot.position": z.object({ strategyId: z.string(), symbol: z.string(),
    legs: z.array(z.object({ side, qty: z.number(), entryPrice: z.number(), entryTs: z.number() })) }),
  log: z.object({ level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]), logger: z.string(), message: z.string() }),
  "trade.closed": z.object({ orderId: z.string(), symbol: z.string(), side, qty: z.number(), price: z.number(),
    realized: z.number(), entryTs: z.number().optional(), ts: z.number() }),
  "state.account": z.object({
    broker: z.string(), currency: z.string(), balance: z.number(), equity: z.number(),
    margin: z.number().optional(), marginFree: z.number().optional(),
    openProfit: z.number().optional(), marginLevel: z.number().optional(),
    login: z.string().optional(), server: z.string().optional(), name: z.string().optional(),
  }),
  "state.positions": z.object({
    broker: z.string(),
    positions: z.array(z.object({
      ticket: z.string(), symbol: z.string(), side,
      qty: z.number(), entryPrice: z.number(), currentPrice: z.number().optional(),
      profit: z.number().optional(), swap: z.number().optional(),
      openedAt: z.number().optional(), strategyId: z.string().nullable().optional(),
    })),
  }),
  "broker.deal": z.object({
    broker: z.string(), dealTicket: z.string(), positionTicket: z.string().optional(),
    orderTicket: z.string().optional(), symbol: z.string().optional(), side: side.optional(),
    entry: z.string().optional(), qty: z.number(), price: z.number(),
    profit: z.number(), commission: z.number().optional(), swap: z.number().optional(),
    magic: z.number().optional(), comment: z.string().optional(), ts: z.number(),
    strategyId: z.string().nullable().optional(),
  }),
} as const;

export type EventType = keyof typeof payloadByType;
