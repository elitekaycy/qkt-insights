import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { get } from "../api";
import { tripParams, type CurrencyNet, type TripScope } from "./data";

/*
 * The journal aggregates (/round-trips/analytics): every card, chart and table of a strategy's
 * sections from one call over the same scope and query as its round-trip list. Shapes mirror
 * packages/store/src/tripAnalytics.ts.
 */

export interface TripBucket {
  key: string;
  label: string;
  /** The query token that selects this bucket's trades. */
  filter: string;
  n: number;
  wins: number;
  losses: number;
  pnl: number;
}

export interface TripDay { day: string; n: number; wins: number; losses: number; pnl: number }
export interface TripMonth extends TripDay { grossWin: number; grossLoss: number }
export interface TripPoint { id: string; exitTs: number; pnl: number; cum: number }

export interface TripAnalytics {
  total: number;
  matched: number;
  /** `pnl` per account currency (RoundTripTotals.currencies); absent from an older collector. */
  currencies?: CurrencyNet[];
  closed: number;
  open: number;
  pnl: number;
  grossWin: number;
  grossLoss: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  profitFactor: number | "inf" | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  expectancy: number | null;
  r: { n: number; avg: number | null; total: number | null };
  best: { id: string; pnl: number } | null;
  worst: { id: string; pnl: number } | null;
  avgHoldMs: number | null;
  maxDd: number;
  maxDdWindow: { from: number; to: number } | null;
  streaks: { current: number; maxWin: number; maxLoss: number };
  postLoss: Array<{ n: number; sample: number; nextWinRate: number; nextAvg: number }>;
  trades: TripPoint[];
  tradesTruncated: boolean;
  daily: TripDay[];
  monthly: TripMonth[];
  side: TripBucket[];
  ended: TripBucket[];
  hold: TripBucket[];
  instrument: TripBucket[];
  weekday: TripBucket[];
  hour: TripBucket[];
  query: { canonical: string; errors: string[] };
}

/** The aggregates for a scope and query; the previous answer stays on screen while the next loads. */
export function useTripAnalytics(scope: TripScope | null, q: string) {
  return useQuery({
    queryKey: ["round-trip-analytics", scope, q],
    enabled: scope != null,
    queryFn: () => get<TripAnalytics>(`/round-trips/analytics?${tripParams(scope!, q, "exit", "asc")}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}
