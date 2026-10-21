import { z } from "zod";

const side = z.enum(["BUY", "SELL"]);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/*
 * Facts qkt states about venue envelopes and fills, so the collector reads them instead of inferring
 * them from MT5 conventions. Every field is optional: older qkt releases send none of them, and a
 * value of an unexpected shape must not cost the envelope, so enums are plain strings.
 */
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
/** Which connector, venue and config entry an envelope is about: `{connector: "mt5", adapter: "exness", label: "EXNESS"}`. */
const venue = object({ connector: opt(z.string()), adapter: opt(z.string()), label: opt(z.string()) });
/** What one instrument is: qkt's symbol, the venue's code, its kind, contract size, tick, quote currency and account value of a point. */
const instrument = object({
  symbol: opt(z.string()), venueCode: opt(z.string()), kind: opt(z.string()), contractSize: opt(z.number()),
  tickSize: opt(z.number()), quoteCurrency: opt(z.string()), valuePerPoint: opt(z.number()),
});
/** A typed venue cost; `amount` is positive when paid. */
const cost = object({ kind: z.string(), amount: z.number(), currency: opt(z.string()) });
/** `venue` and `accountId` on every venue envelope (`mt5:<login>@<server>`, `vgp:<adapter>:<login>`). */
const venueFacts = { venue: venue.optional(), accountId: opt(z.string()) };
/**
 * What qkt resolved about a fill: the position it belongs to, the leg it made (IN, OUT, INOUT), why a
 * closing fill closed (STOP, TAKE_PROFIT, SIGNAL, MANUAL, TIMED, STOP_OUT, LIQUIDATION, EXPIRY), its
 * strategy with how it was known (order, position, comment, none), an entry's bracket and risk in
 * account currency, and the instrument.
 */
const fillFacts = {
  positionId: opt(z.string()), nextPositionId: opt(z.string()), legEntry: opt(z.string()), closeReason: opt(z.string()),
  attribution: opt(z.string()), initialStop: opt(z.number()), initialTarget: opt(z.number()), riskAmount: opt(z.number()),
  instrument: instrument.nullable().optional(),
};

export const payloadByType = {
  signal: object({ symbol: z.string(), side, qty: z.number().optional(), intent: z.string().optional(), note: z.string().optional(), order: z.unknown().optional() }),
  "signal.cancel": object({ symbol: z.string(), intent: z.string().optional() }),
  // Gated signal drops (portfolio/risk gate) and DSL-level suppressions; symbol is absent for
  // structure groups and latch arms.
  "signal.suppressed": object({ reason: z.string(), symbol: z.string().optional(), kind: z.string().optional(), intent: z.string().optional() }),
  // A multi-leg structure open/close; legs is "SIDE QTY SYMBOL" joined by ";".
  "signal.structure": object({ intent: z.string(), structureId: z.string(), alias: z.string().optional(), closes: z.string().optional(), legs: z.string() }),
  "signal.latch_armed": object({ intent: z.string().optional(), reference: z.string(), offset: z.string(), streamAlias: z.string().optional(), name: z.string().optional(), armWindowMs: z.number().optional(), expiresAt: z.number().optional() }),
  "order.submit": object({
    orderId: z.string(),
    orderType: z.string(),
    symbol: z.string(),
    side,
    qty: z.number(),
    strategyId: z.string().optional(),
    timeInForce: z.string().optional(),
    createdTs: z.number().optional(),
    expiresAt: z.number().nullable().optional(),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    triggerPrice: z.number().optional(),
    onTrigger: z.string().optional(),
    trailAmount: z.number().optional(),
    trailMode: z.string().optional(),
    trailDistance: z.number().optional(),
    mfeThreshold: z.number().optional(),
    limitOffset: z.number().optional(),
    entryPrice: z.number().optional(),
    closesTicket: z.string().nullable().optional(),
    closesLegId: z.string().nullable().optional(),
    entry: z.unknown().optional(),
    parent: z.unknown().optional(),
    children: z.array(z.unknown()).optional(),
    leg1: z.unknown().optional(),
    leg2: z.unknown().optional(),
    takeProfit: z.number().optional(),
    stopLoss: z.unknown().optional(),
    takeProfitAst: z.unknown().nullable().optional(),
    stopLossAst: z.unknown().nullable().optional(),
    basis: z.unknown().optional(),
    legs: z.array(z.unknown()).optional(),
    target: z.unknown().optional(),
    deadline: z.number().optional(),
    onExpiry: z.string().optional(),
    layers: z.number().optional(),
    stackLayers: z.array(z.unknown()).optional(),
    withinMillis: z.number().nullable().optional(),
    hasOuterBracket: z.boolean().optional(),
    outerBracket: z.unknown().nullable().optional(),
  }),
  "order.accepted": object({ orderId: z.string(), brokerOrderId: z.string().optional() }),
  "order.filled": object({ orderId: z.string(), brokerOrderId: z.string().optional(), symbol: z.string(), price: z.number(), qty: z.number(), venueCosts: z.number().optional(),
    strategyId: opt(z.string()), ...fillFacts }),
  "order.partially_filled": object({ orderId: z.string(), brokerOrderId: z.string().optional(), symbol: z.string(), side: side.optional(), price: z.number(), qty: z.number(), cumulativeQty: z.number(), venueCosts: z.number().optional(), typedVenueCosts: z.array(z.unknown()).optional(),
    strategyId: opt(z.string()), ...fillFacts }),
  "order.cancelled": object({ orderId: z.string(), brokerOrderId: z.string().optional(), reason: z.string().optional() }),
  "order.rejected": object({ orderId: z.string(), brokerOrderId: z.string().optional(), reason: z.string() }),
  "order.modified": object({
    orderId: z.string(),
    brokerOrderId: z.string().optional(),
    changes: object({
      newQuantity: z.number().nullable().optional(),
      newLimitPrice: z.number().nullable().optional(),
      newStopPrice: z.number().nullable().optional(),
    }),
  }),
  trade: object({ orderId: z.string(), symbol: z.string(), side, price: z.number(), qty: z.number(), ts: z.number() }),
  "bot.close": object({
    symbol: z.string(),
    ticket: z.string(),
    ok: z.string().optional(),
    deal: z.string().optional(),
    price: z.string().optional(),
  }),
  // One-shot bot command provenance (`qkt bot buy|sell|...`); strategyId is the --as name.
  "bot.command": object({ source: z.string(), sha256: z.string(), qktVersion: z.string().optional(), argv: z.array(z.string()).optional(), symbol: z.string().optional(), run: z.string().optional() }),
  // Bot venue actions from the trail; every value is a string, absent when null.
  "bot.modify": object({ symbol: z.string(), ticket: z.string(), sl: z.string().optional(), tp: z.string().optional(), ok: z.string().optional(), reason: z.string().optional(), run: z.string().optional() }),
  "bot.cancel": object({ symbol: z.string(), ticket: z.string(), ok: z.string().optional(), run: z.string().optional() }),
  // A bot-session order intent (qkt `bot session start` runs, e.g. the AI lab's
  // paper/live sessions). Values arrive as strings from the session trail.
  "bot.session.intent": object({
    orderId: z.string(),
    symbol: z.string(),
    sha256: z.string().optional(),
    lots: z.string().optional(),
    simMs: z.string().optional(),
    run: z.string().optional(),
  }),
  "decision.rule_evaluated": object({
    decisionId: z.string(),
    ruleId: z.string(),
    strategyFingerprint: z.string().optional(),
    ruleFingerprint: z.string().optional(),
    conditionFingerprint: z.string().optional(),
    conditionResult: z.boolean(),
    alias: z.string().optional(),
    broker: z.string().optional(),
    timeframe: z.string().optional(),
    signalCount: z.number().optional(),
    candle: object({
      symbol: z.string(),
      startTimeMs: z.number(),
      endTimeMs: z.number(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
      volume: z.number(),
    }).optional(),
  }),
  "decision.order_linked": object({
    decisionId: z.string(),
    ruleId: z.string(),
    signalIndex: z.number(),
    orderId: z.string(),
  }),
  "fill.accounted": object({
    orderId: z.string(),
    symbol: z.string(),
    fillSliceId: z.string(),
    sourceFillSequenceId: z.number(),
    cumulativeFilled: z.number().optional(),
    modeledCommissionAccount: z.number().optional(),
    venueCostsAccount: z.number().optional(),
    totalCostsAccount: z.number().optional(),
    accountNativeRealized: z.number().optional(),
    strategyNativeRealized: z.number().optional(),
    nativeCurrency: z.string().optional(),
    grossAccountRealized: z.number().optional(),
    grossStrategyAccountRealized: z.number().optional(),
    accountCurrency: z.string().optional(),
    netAccountRealized: z.number().optional(),
    netStrategyAccountRealized: z.number().optional(),
  }),
  "risk.rejected": object({ reason: z.string(), symbol: z.string().optional(), side: side.optional(), qty: z.number().optional() }),
  // scope (TRANSIENT | DAILY | PERSISTENT) and persistent arrive from qkt v0.52.0 on; older engines omit both.
  // sessionStrategies (qkt#1244 on) names the emitting session's strategies when strategyId is null.
  "risk.halted": object({
    strategyId: z.string().nullable().optional(), reason: z.string(), scope: z.string().optional(), persistent: z.boolean().optional(),
    sessionStrategies: z.array(z.string()).optional(),
  }),
  "risk.resumed": object({ strategyId: z.string().nullable().optional(), sessionStrategies: z.array(z.string()).optional() }),
  // The halt fields arrive from qkt#1244 on: the strategy's effective halt when its session starts.
  "risk.snapshot": object({
    strategyId: z.string().nullable().optional(), ts: z.number().optional(),
    halted: z.boolean().optional(), haltReason: z.string().nullable().optional(), haltScope: z.string().nullable().optional(),
    haltPersistent: z.boolean().nullable().optional(), haltedAt: z.number().nullable().optional(),
  }),
  "strategy.started": object({
    strategyId: z.string(),
    ts: z.number().optional(),
    deployName: z.string().optional(),
    sourcePath: z.string().optional(),
    sourceSha256: z.string().optional(),
    dslVersion: z.number().optional(),
    runtimeMode: z.string().optional(),
    brokers: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    streams: z.array(z.unknown()).optional(),
    params: z.record(z.unknown()).optional(),
    defaults: z.record(z.unknown()).optional(),
    risk: z.record(z.unknown()).optional(),
  }),
  "strategy.stopped": object({ strategyId: z.string(), flatten: z.boolean().optional(), ts: z.number().optional() }),
  "insights.health": object({ sent: z.number(), failed: z.number(), dropped: z.number(), queued: z.number(), queueCapacity: z.number().optional(), batchSize: z.number().optional(), flushIntervalMs: z.number().optional(), maxPostAttempts: z.number().optional(), journalEnabled: z.boolean().optional(), journalPending: z.number().optional() }),
  "position.reconciled": object({ symbol: z.string(), before: z.number(), after: z.number() }),
  "position.opened": object({ symbol: z.string(), side, qty: z.number(), entryPrice: z.number().optional(), ticket: z.string().optional(), broker: z.string().optional(), strategyId: z.string().nullable().optional() }),
  "position.updated": object({ symbol: z.string(), side: side.optional(), qty: z.number(), entryPrice: z.number().optional(), currentPrice: z.number().optional(), ticket: z.string().optional(), broker: z.string().optional(), strategyId: z.string().nullable().optional() }),
  "position.closed": object({ symbol: z.string(), side: side.optional(), qty: z.number().optional(), exitPrice: z.number().optional(), ticket: z.string().optional(), broker: z.string().optional(), strategyId: z.string().nullable().optional() }),
  "position.valued": object({ symbol: z.string(), side: side.optional(), qty: z.number(), entryPrice: z.number().optional(), currentPrice: z.number().optional(), profit: z.number().optional(), ticket: z.string().optional(), broker: z.string().optional(), strategyId: z.string().nullable().optional() }),
  "balances.updated": object({ balances: z.record(z.number()) }),
  "gateway.unreachable": object({ detail: z.string(), ...venueFacts }),
  "broker.connected": object({ broker: z.string(), state: z.string().optional(), reason: z.string().optional(), ts: z.number().optional(), ...venueFacts }),
  "broker.disconnected": object({ broker: z.string(), state: z.string().optional(), reason: z.string().optional(), consecutiveFailures: z.number().optional(), ts: z.number().optional(), ...venueFacts }),
  "broker.reconnected": object({ broker: z.string(), state: z.string().optional(), reason: z.string().optional(), consecutiveFailures: z.number().optional(), ts: z.number().optional(), ...venueFacts }),
  "marketdata.connected": object({ source: z.string(), symbols: z.array(z.string()).optional(), state: z.string().optional(), reason: z.string().optional(), ts: z.number().optional() }),
  "marketdata.disconnected": object({ source: z.string(), symbols: z.array(z.string()).optional(), state: z.string().optional(), reason: z.string().optional(), ts: z.number().optional() }),
  "marketdata.reconnected": object({ source: z.string(), symbols: z.array(z.string()).optional(), state: z.string().optional(), reason: z.string().optional(), ts: z.number().optional() }),
  // kind arrives with the qkt release that also sends marketdata.recovered; older engines omit it.
  "marketdata.stale": object({ source: z.string(), symbols: z.array(z.string()).optional(), state: z.string().optional(), reason: z.string().optional(), ts: z.number().optional(), kind: z.string().optional() }),
  // Sent once when a symbol that raised marketdata.stale is healthy again.
  "marketdata.recovered": object({ source: z.string(), symbols: z.array(z.string()).optional(), state: z.string().optional(), reason: z.string().optional(), ts: z.number().optional(), unhealthyForMs: z.number().optional() }),
  "snapshot.equity": object({ strategyId: z.string(), realized: z.number(), unrealized: z.number(), equity: z.number(), startingBalance: z.number() }),
  "snapshot.position": object({ strategyId: z.string(), symbol: z.string(),
    legs: z.array(object({ side, qty: z.number(), entryPrice: z.number(), entryTs: z.number() })) }),
  // Any level string is kept as sent (e.g. TRACE): logs are display-only, so an unknown level
  // needs no reducer change and must not cost the envelope.
  log: object({ level: z.string().min(1), logger: z.string(), message: z.string() }),
  "trade.closed": object({ orderId: z.string(), symbol: z.string(), side, qty: z.number(), price: z.number(),
    realized: z.number(), entryTs: z.number().optional(), ts: z.number(), strategyId: opt(z.string()), ...fillFacts }),
  "state.account": object({
    broker: z.string(), currency: z.string(), balance: z.number(), equity: z.number(),
    margin: z.number().optional(), marginFree: z.number().optional(),
    openProfit: z.number().optional(), marginLevel: z.number().optional(),
    login: z.string().optional(), server: z.string().optional(), name: z.string().optional(),
    ...venueFacts,
  }),
  "state.positions": object({
    broker: z.string(),
    positions: z.array(object({
      ticket: z.string(), symbol: z.string(), side,
      qty: z.number(), entryPrice: z.number(), currentPrice: z.number().optional(),
      profit: z.number().optional(), swap: z.number().optional(),
      openedAt: z.number().optional(), strategyId: z.string().nullable().optional(),
      stopLoss: z.number().optional(), takeProfit: z.number().optional(),
      requestedStopLoss: z.number().optional(), requestedTakeProfit: z.number().optional(),
      magic: z.number().optional(), clientOrderId: z.string().optional(),
      positionId: opt(z.string()), attribution: opt(z.string()), instrument: instrument.nullable().optional(),
      initialStop: opt(z.number()), initialTarget: opt(z.number()), riskAmount: opt(z.number()),
    })),
    ...venueFacts,
  }),
  "state.orders": object({
    broker: z.string(),
    orders: z.array(object({
      ticket: z.string(), symbol: z.string(), side, orderType: z.string().optional(),
      qty: z.number(), price: z.number().optional(),
      stopLoss: z.number().optional(), takeProfit: z.number().optional(),
      expiresAt: z.number().optional(), createdAt: z.number().optional(),
      magic: z.number().optional(), clientOrderId: z.string().optional(),
      strategyId: z.string().nullable().optional(),
      attribution: opt(z.string()), instrument: instrument.nullable().optional(),
    })),
    ...venueFacts,
  }),
  "broker.deal": object({
    broker: z.string(), dealTicket: z.string(), positionTicket: z.string().optional(),
    orderTicket: z.string().optional(), symbol: z.string().optional(), side: side.optional(),
    entry: z.string().optional(), qty: z.number(), price: z.number(),
    profit: z.number(), commission: z.number().optional(), swap: z.number().optional(),
    fee: z.number().optional(), magic: z.number().optional(), comment: z.string().optional(),
    clientOrderId: z.string().optional(), ts: z.number(),
    strategyId: z.string().nullable().optional(),
    // profit is gross; costs[] (when sent) replaces commission/swap/fee, which then repeat it.
    costs: z.array(cost).optional(), realizedSource: opt(z.string()),
    ...fillFacts, ...venueFacts,
  }),
  "portfolio.configured": object({ portfolioId: z.string(), ts: z.number().optional() }),
  "portfolio.allocation.updated": object({ portfolioId: z.string(), ts: z.number().optional() }),
  "portfolio.exposure.updated": object({ portfolioId: z.string(), ts: z.number().optional() }),
  "portfolio.equity.updated": object({ portfolioId: z.string(), equity: z.number().optional(), realized: z.number().optional(), unrealized: z.number().optional(), ts: z.number().optional() }),
  // Durable-state health, emitted when strategy-state persistence becomes unsafe.
  "state.persistence": object({
    enabled: z.boolean(), totalWrites: z.number().optional(), slowWrites: z.number().optional(), failedWrites: z.number().optional(),
    consecutiveFailures: z.number().optional(), failureEpisodes: z.number().optional(), queueSize: z.number().optional(),
    callerRunsTotal: z.number().optional(),
  }),
  "instance.roster": object({ strategies: z.array(z.string()) }),
} as const;

export type EventType = keyof typeof payloadByType;
