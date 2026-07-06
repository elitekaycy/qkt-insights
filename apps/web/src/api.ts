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

export async function login(username: string, password: string): Promise<boolean> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "same-origin",
  });
  return res.ok;
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
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
  insightsSent: number | null;
  insightsFailed: number | null;
  insightsDropped: number | null;
  insightsQueued: number | null;
  insightsJournalEnabled: boolean | number | null;
  insightsJournalPending: number | null;
  insightsHealthTs: number | null;
}
export interface StrategyRow {
  strategyId: string;
  firstSeen: number;
  lastSeen: number;
  startingBalance: number | null;
  metadata: Record<string, unknown> | null;
  realizedNet: number | null;
  dealCount: number;
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
/** A unified blotter row: a broker-deal close (raw=null) or an engine fill (raw set). */
export interface TradeView {
  key: string;
  ts: number;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  realized: number | null;
  searchKey: string;
  raw: TradeRow | null;
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
  magic: number | null;
  comment: string | null;
  strategyId: string | null;
  ts: number;
}
export interface AccountEquityPoint {
  broker: string;
  minuteTs: number;
  balance: number | null;
  equity: number | null;
  openProfit: number | null;
}

export interface BreakdownRow {
  key: string;
  net: number;
  trades: number;
  wins: number;
}
export interface TradeBreakdowns {
  bySymbol: BreakdownRow[];
  byHour: BreakdownRow[];
  byDow: BreakdownRow[];
  byVolume: BreakdownRow[];
  holdTime: BreakdownRow[] | null;
  distribution: { from: number; to: number; count: number }[];
}
