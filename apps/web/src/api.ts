export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
  }
}

export class NotFound extends Error {
  constructor(url: string) {
    super(`${url} -> 404`);
  }
}

/**
 * Prefix for every data read. Empty for the signed-in dashboard; "/public/<token>" on a shared
 * link, where the same pages read the token-scoped, delayed endpoints instead.
 */
let apiBase = "";

export function setApiBase(base: string): void {
  apiBase = base;
}

export async function get<T>(url: string): Promise<T> {
  const res = await fetch(`${apiBase}${url}`, { credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 404) throw new NotFound(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export type LoginResult = "ok" | "denied" | "locked" | "refused" | "unreachable";

export async function login(username: string, password: string, code?: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(code ? { username, password, code } : { username, password }),
      credentials: "same-origin",
    });
  } catch {
    return "unreachable";
  }
  if (res.ok) return "ok";
  if (res.status === 429) return "locked";
  // 403 is the cross-origin guard (a proxy rewriting Host), never a wrong password: retrying would only lock the account
  if (res.status === 403) return "refused";
  return res.status === 401 || res.status === 400 ? "denied" : "unreachable";
}

/** Whether sign-in also needs an authenticator code. Assumes none when the collector cannot say. */
export async function loginNeedsCode(): Promise<boolean> {
  try {
    const res = await fetch("/auth/methods", { credentials: "same-origin" });
    return res.ok && ((await res.json()) as { totp?: boolean }).totp === true;
  } catch {
    return false;
  }
}

/** Ends the server session. Resolves false when the request could not be sent — the
 *  caller decides how to finish the sign-out once the link is back. */
export async function logout(): Promise<boolean> {
  try {
    const res = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ends every session on every device, this one included. */
export async function logoutEverywhere(): Promise<boolean> {
  try {
    const res = await fetch("/auth/logout-all", { method: "POST", credentials: "same-origin" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface InstanceRow {
  id: string;
  name: string | null;
  firstSeen: number;
  lastSeen: number;
  lastSeq: number;
  heardAt: number | null;
  silentFrom: number | null;
  silentTo: number | null;
}
export interface HealthRow {
  instanceId: string;
  lastSeen: number;
  lastSeq: number;
  /** The newest envelope's sequence number (any type that carries one) and that envelope's time. */
  latestSeq: number | null;
  latestSeqTs: number | null;
  /** Deployed now; retiredStrategies are rows a newer roster or a month of silence has left behind. */
  strategies: number;
  retiredStrategies: number;
  insightsSent: number | null;
  /** POST attempts that failed since qkt started; each is retried (from the journal when on), so it is not a loss. */
  insightsFailed: number | null;
  /** Envelopes qkt gave up on: the only loss. */
  insightsDropped: number | null;
  insightsQueued: number | null;
  insightsJournalEnabled: boolean | number | null;
  insightsJournalPending: number | null;
  insightsHealthTs: number | null;
  /** Envelopes /ingest acknowledged but kept raw (unknown type, bad payload, unsupported major), per type and major. */
  quarantined: QuarantineCount[];
}
/** The contract the collector's /ingest reads (`GET /health/contract`). */
export interface ContractInfo {
  contractVersion: string;
  /** Envelope `v` values it accepts; any other is quarantined. */
  majors: number[];
}
export interface QuarantineCount {
  type: string | null;
  v: number | null;
  count: number;
  lastReceivedAt: number;
  /** The newest one's reason. */
  reason: string;
}
export type MonitorStatus = "up" | "down" | "pending";
export interface StripBucket {
  ts: number;
  /** null = no checks recorded in the bucket (the collector was not running) and no outage known in it. */
  status: "up" | "down" | null;
  checks: number;
  downs: number;
}
export interface MonitorSummary {
  name: string;
  kind: "heartbeat" | "http" | "marketdata";
  target: string;
  status: MonitorStatus;
  since: number | null;
  lastCheck: number | null;
  latencyMs: number | null;
  detail: string | null;
  failures: number;
  strip: StripBucket[];
  /** Minutes up over the window's minutes since the monitor's first record; outage minutes are down, unchecked ones not up. */
  uptime24h: number | null;
  uptime30d: number | null;
  /** Share of those minutes nothing checked and no outage covers (counted against uptime). */
  unchecked24h: number | null;
  unchecked30d: number | null;
}
export interface MonitorEventRow {
  monitor: string;
  ts: number;
  status: "up" | "down";
  detail: string | null;
}
export interface MonitorsView {
  monitors: MonitorSummary[];
  events: MonitorEventRow[];
}

/** GET /health/reconciliation: the nightly venue reconciliation as its latest run stored it (store reconciliation.ts). */
/** external: the balance moved with no deal in the window (a deposit, withdrawal or credit); not a failure. */
export type ReconciledDayStatus = "ok" | "external" | "diff" | "incomplete";
export type ReconciledDayReason = "no-deals" | "deals-differ" | "no-prior-balance" | "no-balance";
export interface ReconciledDay {
  /** "YYYY-MM-DD", UTC. */
  day: string;
  status: ReconciledDayStatus;
  reason: ReconciledDayReason | null;
  /** The minutes of the two balance snapshots compared; the deals counted are those in (startTs, endTs]. */
  startTs: number | null;
  endTs: number | null;
  startBalance: number | null;
  endBalance: number | null;
  balanceChange: number | null;
  dealNet: number | null;
  /** balanceChange minus dealNet: what no stored deal explains. */
  diff: number | null;
  deals: number;
  checkedAt: number;
}
export interface ReconciledPosition { ticket: string; symbol: string | null; side: string | null; qty: number | null }
export interface ReconciledPositions {
  status: "ok" | "diff" | "stale";
  venueAt: number | null;
  venueCount: number;
  insightsCount: number;
  missing: ReconciledPosition[];
  gone: ReconciledPosition[];
  mismatched: Array<{ ticket: string; symbol: string | null; field: "side" | "qty"; venue: string | number; insights: string | number }>;
}
export interface ReconciledLedger {
  status: "ok" | "diff";
  trips: number;
  tripsNet: number;
  dealsNet: number;
  diff: number;
  mismatched: Array<{ ticket: string; realized: number; dealsNet: number }>;
}
export interface AccountReconciliation {
  account: string;
  label: string;
  firstDay: string | null;
  lastDay: string | null;
  throughDay: string | null;
  daysOk: number;
  daysDiff: number;
  /** Days the balance moved without a deal (deposits, withdrawals, credits). */
  daysExternal: number;
  daysIncomplete: number;
  /** Days not ok, newest first. */
  days: ReconciledDay[];
  positions: ReconciledPositions;
  ledger: ReconciledLedger;
  checkedAt: number;
}
export interface ReconciliationView {
  instanceId: string;
  digits: number;
  checkedAt: number | null;
  /** Canonical deals the latest run could give to no account, per label: never in an account's checks. */
  unassigned: { deals: number; labels: Array<{ broker: string; deals: number }> };
  accounts: AccountReconciliation[];
}
export interface StrategyRow {
  strategyId: string;
  firstSeen: number;
  lastSeen: number;
  startingBalance: number | null;
  /** Operator-declared capital (STRATEGY_CAPITAL); wins over startingBalance as the strategy's base. */
  definedCapital: number | null;
  metadata: Record<string, unknown> | null;
  realizedNet: number | null;
  dealCount: number;
  /** In the instance's latest deployed roster. False = lingering from a prior bench topology. */
  active: boolean;
  /** Current engine risk halt. The halt fields are absent on shared links, which never show live risk state. */
  halted?: boolean;
  haltReason?: string | null;
  /** Null when the engine predates qkt v0.52.0 and did not say. */
  haltScope?: "TRANSIENT" | "DAILY" | "PERSISTENT" | null;
  /** True when only `qkt resume <name>` clears the halt; null when unknown. */
  haltPersistent?: boolean | null;
  haltedAt?: number | null;
  /** True when haltedAt is only a bound (the halt began at or before it): a restart re-asserted it and no earlier record is stored. */
  haltedBefore?: boolean;
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
export interface LogRow {
  id: string;
  strategyId: string | null;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  logger: string;
  message: string;
  ts: number;
}
export interface StrategyStats {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volume: number;
  realizedPnl: number | null;
  equity: number | null;
  startingBalance: number | null;
  returnPct: number | null;
  winRate: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  /** End-of-day points behind sharpe; it is null below MIN_RATIO_DAYS. */
  ratioDays: number;
}
export interface EquityPoint {
  ts: number;
  equity: number;
  realized: number;
  unrealized: number;
}
export interface SearchHit {
  id: string;
  instanceId: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface PerformanceReport {
  profitFactor: number | "inf" | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  kelly: number | null;
  grossProfit: number;
  grossLoss: number;
  largestWin: number | null;
  largestLoss: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownAbs: number | null;
  drawdownDurationDays: number | null;
  recoveryFactor: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  /** End-of-day points behind the ratios; they are null below MIN_RATIO_DAYS (20). */
  ratioDays: number;
  wins: number;
  losses: number;
  winRate: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number;
  daysTraded: number;
  profitableDays: number;
  bestDay: number | null;
  worstDay: number | null;
  avgDayPnl: number | null;
  totalNet: number;
  approximate: boolean;
}
export interface DayNet {
  day: string;
  net: number;
  trades: number;
}
export interface DrawdownPeriod {
  peakTs: number;
  troughTs: number;
  recoveryTs: number | null;
  depth: number;
  depthPct: number;
  lengthDays: number;
  recoveryDays: number | null;
}
export interface PostLossRow {
  n: number;
  sample: number;
  nextWinRate: number;
  nextAvg: number;
}
export interface ClosedTradeRow {
  ts: number;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  realized: number;
  entryTs: number | null;
  orderId: string | null;
  /** Engine orders linked through broker tickets; only on deals-backed closes. */
  entryOrderId?: string | null;
  exitOrderId?: string | null;
}
export interface PerformanceBundle {
  breakdowns: TradeBreakdowns | null;
  report: PerformanceReport;
  dailyNets: DayNet[];
  drawdownPeriods: DrawdownPeriod[];
  postLoss: PostLossRow[];
  closes: ClosedTradeRow[];
  /** Edge analytics — present unless the request narrowed `include`. */
  dowHour?: DowHourCell[] | null;
  rolling?: RollingPoint[];
  costs?: CostDecomposition | null;
  contribution?: ContributionRanking | null;
  excursions?: ExcursionStats | null;
}
/** A close anywhere on the account; strategyId null is a deal no strategy claimed. */
export interface AccountClose extends ClosedTradeRow {
  strategyId: string | null;
  /** The symbol without its broker-profile prefix. */
  instrument: string;
}
export interface AccountBucket {
  key: string | null;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  venues?: string[];
}
/** Every close on the account: retired strategies and unattributed deals included. */
export interface AccountSummary {
  closes: AccountClose[];
  dailyNets: DayNet[];
  totalNet: number;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  sumWins: number;
  sumLosses: number;
  /** Gross = before commission, swap and fee. Null without broker deals. */
  costs: { grossProfit: number; commission: number; swap: number; fee: number; net: number } | null;
  byInstrument: AccountBucket[];
  byStrategy: AccountBucket[];
  /** Capital each traded month's return is measured against. */
  monthBases: PeriodBase[];
}
export interface PeriodBase { period: string; base: number; source: "account equity" | "start balance" }
/** Drawdown and daily-loss consumption of one venue account against its own limits. */
export interface AccountRiskRow {
  account: string;
  label: string;
  source: "account limits" | "strategy risk config" | null;
  basis: "peak" | "static";
  startBalance: number | null;
  startBalanceSource: "configured" | "strategy risk config" | "first recorded balance" | null;
  balance: number | null;
  equity: number | null;
  peakEquity: number | null;
  drawdown: { used: number | null; usedPct: number | null; reference: number | null; cap: number | null };
  dailyLoss: {
    used: number | null; cap: number | null; dayStart: number; resetHour: number; timezone: string;
    includesFloating: boolean; dayStartBalance: number | null; realizedToday: number;
    /** Older collectors omit these three: the day-start balance is then the reference. */
    base?: "balance" | "higher"; dayStartEquity?: number | null; reference?: number | null;
  };
}
export interface AccountDrawdownRow {
  broker: string; currentEquity: number | null; peakEquity: number | null;
  peakTs: number | null; currentDdPct: number | null; maxDdPct: number | null; points: number;
}

export interface LiveAccount {
  instanceId: string;
  broker: string;
  currency: string;
  balance: number;
  equity: number;
  margin?: number;
  marginFree?: number;
  openProfit?: number;
  marginLevel?: number;
  login?: string;
  server?: string;
  name?: string;
  /** The opaque venue account id (`mt5:<16 hex>`, `vgp:<16 hex>`), as the collector resolved it. `login` is masked, `server` never sent. */
  accountId?: string;
  connector?: string;
  adapter?: string;
  lastSeen: number;
  stale: boolean;
}
export interface LivePositionRow {
  ticket: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  currentPrice?: number;
  profit?: number;
  swap?: number;
  openedAt?: number;
  strategyId?: string | null;
  stopLoss?: number;
  takeProfit?: number;
  requestedStopLoss?: number;
  requestedTakeProfit?: number;
  magic?: number;
  clientOrderId?: string;
  /** The instrument's kind as qkt states it (cfd, equity, spot, perpetual, future, option). */
  kind?: string;
  /** What one unit of `qty` is: lots, shares, coins, contracts, or a unit qkt names. */
  unit?: string;
  contractSize?: number;
}
export interface LivePendingOrderRow {
  ticket: string;
  symbol: string;
  side: string;
  orderType?: string;
  qty: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  expiresAt?: number;
  createdAt?: number;
  magic?: number;
  clientOrderId?: string;
  strategyId?: string | null;
}
export interface LivePositionGroup {
  instanceId: string;
  broker: string;
  at: number;
  stale: boolean;
  list: LivePositionRow[];
}
export interface LiveStateSnapshot {
  accounts: LiveAccount[];
  positions: LivePositionGroup[];
  /** Shared overview links only: how many positions were open at the cutoff and their total unrealized P&L. */
  openPositions?: { count: number; unrealized: number | null };
  /** Shared links only: open P&L per strategy, as marked at the cutoff. */
  openByStrategy?: Record<string, number>;
  orders: Array<{ instanceId: string; broker: string; at: number; stale: boolean; list: LivePendingOrderRow[] }>;
}
export interface DealRow {
  id: string;
  broker: string;
  dealTicket: string;
  positionTicket: string | null;
  orderTicket: string | null;
  symbol: string | null;
  side: string | null;
  entry: string | null;
  qty: number | null;
  price: number | null;
  profit: number | null;
  commission: number | null;
  swap: number | null;
  fee: number | null;
  magic: number | null;
  comment: string | null;
  strategyId: string | null;
  ts: number;
}
export interface AccountEquityPoint {
  broker: string;
  /** The venue account the label belongs to: labels of one account share it. */
  account: string;
  minuteTs: number;
  balance: number | null;
  equity: number | null;
  openProfit: number | null;
}

export interface BreakdownRow {
  key: string;
  /** bySymbol only: venue symbols folded into this instrument (absent on shared links). */
  venues?: string[];
  net: number;
  trades: number;
  wins: number;
  /** Standard error of the mean per-trade P&L; null under 2 trades. */
  se: number | null;
}
export interface TradeBreakdowns {
  bySymbol: BreakdownRow[];
  byHour: BreakdownRow[];
  byDow: BreakdownRow[];
  byVolume: BreakdownRow[];
  holdTime: BreakdownRow[] | null;
  distribution: { from: number; to: number; count: number }[];
}
export interface DowHourCell {
  /** 0 = Monday … 6 = Sunday, UTC. */
  dow: number;
  hour: number;
  n: number;
  net: number;
  mean: number;
  /** Wins over decided round trips, breakeven excluded; null when none was decided. */
  winRate: number | null;
}
export interface RollingPoint {
  day: string;
  sharpe: number | null;
  winRate: number | null;
  meanNet: number | null;
}
export interface CostRow {
  key: string;
  grossProfit: number;
  commission: number;
  swap: number;
  fee: number;
  net: number;
  trades: number;
}
export interface CostDecomposition {
  byMonth: CostRow[];
  total: CostRow;
}
export interface ContributionRow {
  key: string;
  /** bySymbol only: venue symbols folded into this instrument (absent on shared links). */
  venues?: string[];
  net: number;
  trades: number;
  /** Wins over decided round trips, breakeven excluded; null when none was decided. */
  winRate: number | null;
  expectancy: number;
  share: number | null;
}
export interface ContributionRanking {
  bySymbol: ContributionRow[];
  byDirection: ContributionRow[];
  totalNet: number;
}
export interface ExcursionRow {
  ticket: string;
  symbol: string;
  side: string;
  ts: number;
  exitPnl: number;
  mae: number;
  mfe: number;
  capturePct: number | null;
  observations: number;
}
export interface ExcursionStats {
  rows: ExcursionRow[];
  closedTrades: number;
  sampledTrades: number;
  coveragePct: number;
  averageMae: number;
  averageMfe: number;
  /** Median exit/MFE over winning trades; null when none had a favorable excursion. */
  medianWinnerCapturePct: number | null;
  winnersWithCapture: number;
  sampled: true;
}
export type ShareKind = "overview" | "portfolio" | "strategy";
export type ShareVisibility = "public" | "private";

export interface ShareState {
  /** The setting made on this subject itself; null = inherited. */
  visibility: ShareVisibility | null;
  effective: boolean;
  /** Present only while the subject is public. */
  token: string | null;
  /** Views of this subject's links within the viewership retention window. */
  views: number;
}

export interface SharesView {
  overview: ShareState;
  portfolios: Array<ShareState & { id: string }>;
  strategies: Array<ShareState & { id: string }>;
}

export interface PublicMeta {
  kind: ShareKind;
  instanceId: string;
  subject: string;
  delayMinutes: number;
  asOf: number;
}

async function sendShare(method: "PUT" | "POST", url: string, body: unknown): Promise<SharesView> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as SharesView;
}

export function setShareVisibility(instance: string, kind: ShareKind, subject: string, visibility: ShareVisibility | null): Promise<SharesView> {
  return sendShare("PUT", "/shares", { instance, kind, subject, visibility });
}

export function rotateShareLink(instance: string, kind: ShareKind, subject: string): Promise<SharesView> {
  return sendShare("POST", "/shares/rotate", { instance, kind, subject });
}

export function shareUrl(token: string): string {
  return `${location.origin}/p/${token}`;
}

export interface ViewBreakdown { key: string | null; views: number }
export interface ViewDay { day: string; views: number; visitors: number }

export interface ViewSummary {
  views: number;
  visitors: number;
  links: Array<{ kind: ShareKind; subject: string; views: number; visitors: number }>;
  pages: ViewBreakdown[];
  strategies: ViewBreakdown[];
  browsers: ViewBreakdown[];
  os: ViewBreakdown[];
  devices: ViewBreakdown[];
  countries: ViewBreakdown[];
  referrers: ViewBreakdown[];
  languages: ViewBreakdown[];
  daily: ViewDay[];
}

export interface ViewRow {
  ts: number;
  kind: ShareKind;
  subject: string;
  page: string;
  strategyId: string | null;
  visitor: string;
  browser: string | null;
  os: string | null;
  device: string | null;
  country: string | null;
  referrer: string | null;
  language: string | null;
}

/**
 * Reports a page view from a shared link. Fire and forget: a lost beacon only undercounts. The
 * referrer is reduced to the referring site's host before it leaves the browser.
 */
export function reportPublicView(page: string, strategy?: string | null): void {
  if (!apiBase.startsWith("/public/")) return;
  let referrer: string | undefined;
  try {
    const host = document.referrer ? new URL(document.referrer).host : "";
    if (host && host !== location.host) referrer = host;
  } catch {
    referrer = undefined;
  }
  const body = JSON.stringify({ page, ...(strategy ? { strategy } : {}), ...(referrer ? { referrer } : {}) });
  const url = `${apiBase}/view`;
  const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
  if (!sent) void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}

/** Sharpe, Sortino and Calmar need this many UTC days with a close; below it they show "—". */
export const MIN_RATIO_DAYS = 20;
