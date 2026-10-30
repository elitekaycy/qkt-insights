import { z } from "zod";

/*
 * What qkt states a strategy runs on (strategy.started effectiveConfig, 1.5.0). qkt builds it from an allow-list;
 * this is the collector's own: only the fields named here are stored, a string can only be a short word, and a
 * field that does not fit is dropped alone. A field qkt adds later stays out until it is named here.
 */

const word = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

const number = optional(z.number());
/** A resolved setting: its value (none when the limit is off or unset) and where the value came from. */
const setting = optional(z.object({
  value: optional(z.union([z.number(), word])),
  source: optional(z.enum(["configured", "default"])),
}));

const account = z.object({
  name: optional(word), type: optional(word), connector: optional(word), adapter: optional(word),
  environment: optional(word), tickPollIntervalMs: number,
});

export const EffectiveConfigSchema = z.object({
  schema: number,
  kind: optional(z.enum(["standalone", "portfolio_child", "bot_session"])),
  tradingMode: optional(z.enum(["paper", "demo", "contest", "live"])),
  runtimeMode: setting,
  accounts: optional(z.array(account)),
  currency: setting,
  startingBalance: setting,
  book: optional(z.object({
    name: optional(word),
    capital: setting,
    weight: number,
    allocatedCapital: number,
    maxGrossExposure: setting,
    maxNetExposure: setting,
    maxSymbolConcentration: setting,
    allocationMethod: setting,
    targetVol: number,
    deRiskSteps: optional(z.array(z.object({ drawdown: number, factor: number, cooldownBars: number }))),
  })),
  risk: optional(z.object({
    appliesTo: optional(z.enum(["strategy", "book"])),
    maxDailyLoss: setting,
    maxDrawdownFraction: setting,
    totalDdBasis: setting,
    maxDailyDrawdownFraction: setting,
    dailyDdBasis: setting,
    liveEquityBasis: setting,
  })),
  strategyRisk: optional(z.object({
    maxDailyLoss: setting,
    maxPositionSize: setting,
    maxOpenPositions: setting,
    maxDrawdownFraction: setting,
    maxDailyDrawdownFraction: setting,
    maxTradesPerDay: setting,
    cooldownAfterLossMs: setting,
    cooldownAfterLosses: setting,
    lossStreakHalt: setting,
    lossStreakHaltScope: setting,
  })),
  orders: optional(z.object({
    maxOrderQty: setting,
    maxOrderNotional: setting,
    priceCollarFraction: setting,
    marginFloorPct: setting,
    measuredUsageHours: setting,
    measuredUsageMaxQty: setting,
    runawayMaxRoundTrips10m: setting,
    runawayMaxBrokerRejections1m: setting,
  })),
  marketData: optional(z.object({
    candleCloseGraceMs: setting,
    staleAgeMultiple: setting,
    minStaleAgeMs: setting,
    outlierSigma: setting,
    maxClockSkewMs: setting,
    quietAlertAfterMs: setting,
  })),
});

export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;
export type EffectiveSetting = NonNullable<EffectiveConfig["runtimeMode"]>;
