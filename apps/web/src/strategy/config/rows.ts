import type { EffectiveAccount, EffectiveConfig, EffectiveSetting } from "../../api";

/*
 * What a strategy runs on, in words: qkt's effective config as grouped label and value rows. Pure, so what each
 * figure reads as is tested. Null stays unknown: a limit with no value reads "None set", never 0.
 */

export const NONE_SET = "None set";
const NOT_STATED = "Not stated";

export interface ConfigRow {
  /** Stable across versions, so two versions can be compared row by row. */
  id: string;
  label: string;
  value: string;
  /** qkt's default rather than a value in the config file. */
  isDefault: boolean;
  /** What the row means, for its tooltip. */
  explain: string;
  /** The config key behind the row, for its tooltip only. */
  yaml?: string;
}

export interface ConfigGroup {
  title: string;
  rows: ConfigRow[];
}

function trimmed(v: number): string {
  return Number(v.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function amount(v: number): string {
  return Number(v.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function percentOf(fraction: number): string {
  return `${trimmed(fraction * 100)}%`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${trimmed(ms)} ms`;
  if (ms < 60_000) return `${trimmed(ms / 1000)} s`;
  if (ms < 3_600_000) return `${trimmed(ms / 60_000)} min`;
  return `${trimmed(ms / 3_600_000)} h`;
}

const WORDS: Record<string, string> = {
  STATIC: "Starting balance",
  TRAILING: "Peak equity",
  BALANCE: "Opening balance",
  EQUITY: "Opening equity",
  VENUE: "Venue account",
  MODELED: "qkt's ledger",
  PERSISTENT: "Until resumed",
  DAILY: "Until the next day",
  FIXED: "Fixed weights",
  INVERSE_VOL: "Inverse volatility",
  ERC: "Equal risk contribution",
  REGIME_WEIGHTED: "By regime",
  dev: "Development",
  paper: "Paper",
  production: "Production",
};

const word = (v: number | string) => (typeof v === "string" ? WORDS[v] ?? v : String(v));

type Format = (v: number) => string;

/** A row for a setting qkt stated; none when this qkt did not state it. */
function row(id: string, label: string, setting: EffectiveSetting | undefined, format: Format, explain: string, yaml: string | undefined, empty = NONE_SET): ConfigRow | null {
  if (!setting) return null;
  const v = setting.value;
  const value = v == null ? empty : typeof v === "number" ? format(v) : word(v);
  return { id, label, value, isDefault: setting.source === "default", explain, yaml };
}

function fact(id: string, label: string, value: string, explain: string): ConfigRow {
  return { id, label, value, isDefault: false, explain };
}

const TRADING_MODE = { paper: "Paper", demo: "Demo", contest: "Contest", live: "Live" } as const;
const ACCOUNT_TYPE: Record<string, string> = { mt5: "MT5", gateway: "Gateway", paper: "Paper" };

function accountRows(accounts: EffectiveAccount[]): ConfigRow[] {
  const many = accounts.length > 1;
  return accounts.flatMap((a, i) => {
    const venue = [a.connector, a.adapter].filter(Boolean).join(" · ");
    const rows = [fact(`account.${i}.name`, many ? `Account ${i + 1}` : "Account", a.name ?? NOT_STATED, venue ? `The brokers: entry this strategy trades through (${venue}).` : "The brokers: entry this strategy trades through.")];
    if (a.type) rows.push(fact(`account.${i}.type`, many ? `Account ${i + 1} type` : "Account type", ACCOUNT_TYPE[a.type] ?? a.type, "The connector qkt reaches this account with."));
    return rows;
  });
}

function pollRows(accounts: EffectiveAccount[]): ConfigRow[] {
  return accounts.map((a, i) => fact(
    `account.${i}.poll`,
    accounts.length > 1 ? `Tick poll: ${a.name ?? i + 1}` : "Tick poll interval",
    a.tickPollIntervalMs != null ? duration(a.tickPollIntervalMs) : "Not polled",
    "How often qkt asks this account's feed for a quote. A feed that streams ticks is not polled. brokers.<name>.tick_poll_interval_ms",
  ));
}

function present(rows: Array<ConfigRow | null>): ConfigRow[] {
  return rows.filter((r): r is ConfigRow => r != null);
}

function accountGroup(c: EffectiveConfig): ConfigGroup {
  return { title: "Account", rows: present([
    ...accountRows(c.accounts ?? []),
    fact("tradingMode", "Trading mode", c.tradingMode ? TRADING_MODE[c.tradingMode] : NOT_STATED, "Paper fills are simulated; demo and live orders go to the venue. Demo and live are as the venue states them."),
    row("currency", "Account currency", c.currency, String, "The currency every money figure below is in.", "account.currency", NOT_STATED),
    row("startingBalance", "Starting balance", c.startingBalance, amount, "The base static drawdown and percent sizing are measured on.", "starting_balance"),
    row("runtimeMode", "qkt runtime mode", c.runtimeMode, String, "Production mode refuses to start without its safety checks; the others do not enforce them.", "runtime.mode"),
  ]) };
}

function riskGroup(c: EffectiveConfig): ConfigGroup {
  const r = c.risk ?? {};
  const s = c.strategyRisk;
  const own = "A cap on this strategy alone, on top of the limits above.";
  const key = (k: string) => `risk.per_strategy.<strategy>.${k}`;
  return { title: "Risk limits", rows: present([
    r.appliesTo ? fact("appliesTo", "These limits watch", r.appliesTo === "book" ? "The whole book" : "Every strategy in this qkt", r.appliesTo === "book" ? "A book's loss and drawdown halts add up all its strategies and stop them together." : "The day's loss adds up every strategy this qkt runs, and any breach stops them all.") : null,
    row("maxDailyLoss", "Max daily loss", r.maxDailyLoss, amount, "Realized loss in one day that halts trading until the next day.", "risk.max_daily_loss"),
    row("maxDrawdown", "Max drawdown", r.maxDrawdownFraction, percentOf, "Total drawdown that halts trading.", "risk.max_drawdown_pct"),
    // A book's static drawdown is measured on the book's capital, which qkt states under the same basis.
    r.appliesTo === "book" && r.totalDdBasis?.value === "STATIC"
      ? { ...row("totalDdBasis", "Drawdown from", r.totalDdBasis, String, "What the total drawdown is measured from.", "risk.total_dd_basis")!, value: "Book capital" }
      : row("totalDdBasis", "Drawdown from", r.totalDdBasis, String, "What the total drawdown is measured from.", "risk.total_dd_basis"),
    row("maxDailyDrawdown", "Max daily drawdown", r.maxDailyDrawdownFraction, percentOf, "Drawdown within one day that halts trading until the next day.", "risk.max_daily_drawdown_pct"),
    row("dailyDdBasis", "Daily drawdown from", r.dailyDdBasis, String, "The reference a day's drawdown is measured from.", "risk.daily_dd_basis"),
    row("liveEquityBasis", "Equity read from", r.liveEquityBasis, String, "Where live equity for these limits comes from.", "risk.live_equity_basis"),
    s ? null : fact("strategyRisk", "This strategy's own limits", NONE_SET, "No risk.per_strategy entry names this strategy."),
    row("own.maxDailyLoss", "This strategy's daily loss", s?.maxDailyLoss, amount, own, key("max_daily_loss")),
    row("own.maxPositionSize", "This strategy's max position", s?.maxPositionSize, trimmed, own, key("max_position_size")),
    row("own.maxOpenPositions", "This strategy's open positions", s?.maxOpenPositions, trimmed, own, key("max_open_positions")),
    row("own.maxDrawdown", "This strategy's drawdown", s?.maxDrawdownFraction, percentOf, own, key("max_drawdown_pct")),
    row("own.maxDailyDrawdown", "This strategy's daily drawdown", s?.maxDailyDrawdownFraction, percentOf, own, key("max_daily_drawdown_pct")),
    row("own.maxTradesPerDay", "This strategy's trades per day", s?.maxTradesPerDay, trimmed, own, key("max_trades_per_day")),
    row("own.cooldown", "Cooldown after a loss", s?.cooldownAfterLossMs, duration, "No new entries for this long after a loss.", key("cooldown_after_loss")),
    row("own.cooldownAfter", "Cooldown after losses in a row", s?.cooldownAfterLosses, trimmed, "How many losses in a row start the cooldown.", key("cooldown_after_loss_after_consecutive")),
    row("own.lossStreak", "Halt after losses in a row", s?.lossStreakHalt, trimmed, "Losing trades in a row that halt this strategy.", key("loss_streak_halt")),
    row("own.lossStreakScope", "Loss-streak halt lasts", s?.lossStreakHaltScope, String, "How long that halt holds.", key("loss_streak_halt_scope")),
  ]) };
}

function bookGroup(c: EffectiveConfig): ConfigGroup | null {
  const b = c.book;
  if (!b) return null;
  const times: Format = (v) => `${trimmed(v)}× capital`;
  const ladder = (b.deRiskSteps ?? [])
    .filter((s) => s.drawdown != null && s.factor != null)
    .map((s) => `${percentOf(s.drawdown!)}: size × ${trimmed(s.factor!)}`);
  return { title: "Book", rows: present([
    b.name ? fact("book.name", "Portfolio", b.name, "The PORTFOLIO this strategy is a child of.") : null,
    row("book.capital", "Book capital", b.capital, amount, "The base the book's halts and caps are measured on.", "book_risk.capital"),
    b.weight != null ? fact("book.weight", "This strategy's weight", percentOf(b.weight), "Its share of the book, from the portfolio's RUN ... WEIGHT.") : null,
    b.allocatedCapital != null ? fact("book.allocated", "Allocated capital", amount(b.allocatedCapital), "Book capital times its weight: what its percent sizing is measured on.") : null,
    row("book.gross", "Max gross exposure", b.maxGrossExposure, times, "Total long plus short notional allowed across the book.", "book_risk.limits.max_gross_exposure"),
    row("book.net", "Max net exposure", b.maxNetExposure, times, "Long minus short notional allowed across the book.", "book_risk.limits.max_net_exposure"),
    row("book.concentration", "Max in one symbol", b.maxSymbolConcentration, times, "Notional allowed in a single symbol.", "book_risk.limits.max_symbol_concentration"),
    row("book.allocation", "Allocation", b.allocationMethod, String, "How the book splits risk across its strategies.", "book_risk.allocation.method"),
    b.targetVol != null ? fact("book.targetVol", "Target volatility", percentOf(b.targetVol), "Annualized volatility the allocation scales the book towards.") : null,
    fact("book.deRisk", "De-risk steps", ladder.length > 0 ? ladder.join("; ") : NONE_SET, "As book drawdown deepens, new risk is scaled to this share of its size. book_risk.de_risk.ladder"),
  ]) };
}

function ordersGroup(c: EffectiveConfig): ConfigGroup {
  const o = c.orders ?? {};
  return { title: "Orders", rows: present([
    row("maxOrderQty", "Max order size", o.maxOrderQty, trimmed, "A larger single order is rejected.", "risk.max_order_qty"),
    row("maxOrderNotional", "Max order value", o.maxOrderNotional, amount, "A single order worth more is rejected.", "risk.max_order_notional"),
    row("priceCollar", "Price collar", o.priceCollarFraction, percentOf, "An order priced further than this from the market is rejected.", "risk.price_collar_pct"),
    row("marginFloor", "Margin floor", o.marginFloorPct, (v) => `${trimmed(v)}%`, "New entries are rejected while margin level is below this.", "risk.margin_floor_pct"),
    row("measuredUsageHours", "Measured-usage window", o.measuredUsageHours, (v) => `${trimmed(v)} h`, "After each deploy, entries stay small for this long.", "risk.measured_usage_hours"),
    row("measuredUsageMaxQty", "Max size in that window", o.measuredUsageMaxQty, trimmed, "The largest entry allowed during the window.", "risk.measured_usage_max_qty"),
    row("runawayRoundTrips", "Runaway: closes in 10 min", o.runawayMaxRoundTrips10m, trimmed, "More closing fills than this in ten minutes halts the strategy.", "risk.max_round_trips_10m"),
    row("runawayRejections", "Runaway: rejections in 1 min", o.runawayMaxBrokerRejections1m, trimmed, "More broker rejections than this in a minute halts the strategy.", "risk.max_broker_rejections_1m"),
  ]) };
}

function marketGroup(c: EffectiveConfig): ConfigGroup {
  const m = c.marketData ?? {};
  return { title: "Market data", rows: present([
    ...pollRows(c.accounts ?? []),
    row("candleCloseGrace", "Candle close grace", m.candleCloseGraceMs, duration, "How long after a bar's window ends a quiet symbol's bar is closed.", "runtime.candle_close_grace_ms"),
    row("minStaleAge", "Quote stale after at least", m.minStaleAgeMs, duration, "The floor of the staleness check.", "market_data.min_stale_age_ms"),
    row("staleMultiple", "Stale at this many usual gaps", m.staleAgeMultiple, (v) => `${trimmed(v)}×`, "A quote is stale past this multiple of the symbol's usual gap between ticks.", "market_data.stale_age_multiple"),
    row("outlierSigma", "Outlier tick rejected at", m.outlierSigma, (v) => `${trimmed(v)} σ`, "A tick this far from the recent mean is dropped.", "market_data.outlier_sigma"),
    row("clockSkew", "Clock skew allowed", m.maxClockSkewMs, duration, "Allowed gap between tick time and qkt's clock.", "market_data.max_clock_skew_ms"),
    row("quietAlert", "Quiet symbol alert after", m.quietAlertAfterMs, duration, "How long a stale quote on an unheld symbol waits before it pages. A held symbol pages at once.", "market_data.quiet_alert_after_ms"),
  ]) };
}

/** The config as the page reads it: Account, Risk limits, Book when it has one, Orders, Market data. */
export function configGroups(c: EffectiveConfig): ConfigGroup[] {
  return [accountGroup(c), riskGroup(c), bookGroup(c), ordersGroup(c), marketGroup(c)].filter((g): g is ConfigGroup => g != null && g.rows.length > 0);
}

export interface ConfigChange {
  label: string;
  from: string | null;
  to: string | null;
}

/** What moved from [before] to [after], row by row; a row only one of them states reads with its other side null. */
export function configChanges(before: EffectiveConfig, after: EffectiveConfig): ConfigChange[] {
  const flat = (c: EffectiveConfig) => new Map(configGroups(c).flatMap((g) => g.rows).map((r) => [r.id, r]));
  const a = flat(before);
  const b = flat(after);
  const changes: ConfigChange[] = [];
  for (const [id, r] of b) {
    const old = a.get(id);
    if (old?.value !== r.value) changes.push({ label: r.label, from: old?.value ?? null, to: r.value });
  }
  for (const [id, r] of a) if (!b.has(id)) changes.push({ label: r.label, from: r.value, to: null });
  return changes;
}
