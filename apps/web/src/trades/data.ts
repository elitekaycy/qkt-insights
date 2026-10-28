import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { get } from "../api";
import { useView } from "../view";

/*
 * Round trips as the collector serves them (/round-trips): one row per position, entry to exit.
 * The same shapes come from a shared link's delayed endpoint, without tickets and stops.
 */

export interface RoundTrip {
  /** The venue position ticket. */
  id: string;
  broker: string | null;
  strategyId: string | null;
  symbol: string;
  instrument: string;
  /** The instrument's kind as qkt states it on the deals (cfd, equity, spot, perpetual, future, option); absent or null when not stated. */
  kind?: string | null;
  /** What one unit of `qty` is (lots, shares, coins, contracts, or a unit qkt names); absent or null when unknown. */
  unit?: string | null;
  /** Underlying per unit of `qty`, as stated. */
  contractSize?: number | null;
  side: "long" | "short";
  status: "open" | "closed";
  entryTs: number | null;
  entryPrice: number | null;
  exitTs: number | null;
  exitPrice: number | null;
  qty: number;
  pnl: number | null;
  /** With an `exit:` window: what the closing legs inside it realized, when others closed outside it; else null. */
  pnlInExit: number | null;
  holdMs: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  risk: number | null;
  r: number | null;
  ended: "stop" | "tp" | "signal" | "venue" | "manual" | null;
  legs: number;
  entryOrderId: string | null;
  /** "deal": a venue position; "ledger": one engine close no broker deal stands for (paper). */
  source: "deal" | "ledger";
  /** Why the position closed, as qkt stated it (STOP, TAKE_PROFIT, SIGNAL, MANUAL, TIMED, STOP_OUT, ...); null when not stated. */
  closeReason?: string | null;
  /** Decimals the venue quotes this instrument with. */
  priceDigits: number;
}

export interface RoundTripTotals {
  total: number;
  matched: number;
  closed: number;
  open: number;
  /** With an `exit:` window: the realized of the matched trips' closing legs inside it. */
  net: number;
  netInExit: boolean;
  wins: number;
  losses: number;
  winRate: number | null;
  avg: number | null;
  best: number | null;
  worst: number | null;
}

export interface RoundTripPage {
  rows: RoundTrip[];
  nextCursor: string | null;
  totals: RoundTripTotals | null;
  query: { canonical: string; errors: string[] };
}

export interface RoundTripFacets {
  strategies: Array<{ id: string | null; n: number }>;
  instruments: Array<{ name: string; n: number }>;
  days: string[];
  sizes: number[];
}

export interface TimelineStep { ts: number; kind: string; title: string; detail: string | null; source: "engine" | "venue"; sinceMs: number | null }
export interface Slippage { reference: number; fill: number; points: number; money: number | null; basis: "reference price" | "stop" | "target" }
export interface RoundTripLeg {
  dealTicket: string; orderTicket: string | null; broker: string; symbol: string | null; side: string | null; entry: string | null;
  qty: number | null; price: number | null; profit: number | null; commission: number | null; swap: number | null; fee: number | null;
  net: number; comment: string | null; ts: number;
}
export interface RoundTripDetail {
  trip: RoundTrip;
  legs: RoundTripLeg[];
  timeline: TimelineStep[];
  entrySlippage: Slippage | null;
  exitSlippage: Slippage | null;
  excursion: { mae: number; mfe: number; marks: number } | null;
  events: Array<{ id: string; type: string; ts: number; seq: number; strategyId: string | null; payload: unknown }>;
}

export type SortKey = "entry" | "exit" | "pnl" | "r" | "held" | "size" | "strategy" | "symbol" | "side" | "entryPrice" | "exitPrice" | "ended" | "ticket";

export interface TripScope {
  instanceId: string;
  /** A strategy page's strategy; "unattributed" for the unclaimed ones. */
  strategy?: string;
  /** Range start (ms): round trips still open or closed since. */
  from?: number;
}

/** The URL query for one request; the only place a scope becomes parameters. */
export function tripParams(scope: TripScope, q: string, sort: SortKey, dir: "asc" | "desc"): URLSearchParams {
  const p = new URLSearchParams({ instance: scope.instanceId });
  if (scope.strategy) p.set("strategy", scope.strategy);
  if (scope.from) p.set("from", String(scope.from));
  if (q) p.set("q", q);
  p.set("sort", sort);
  p.set("dir", dir);
  return p;
}

const PAGE = 200;

/**
 * Pages of round trips as the list scrolls, newest first by default. The previous answer stays
 * on screen while a new query loads, so typing never blanks the table.
 */
export function useRoundTrips(scope: TripScope | null, q: string, sort: SortKey, dir: "asc" | "desc", pageSize = PAGE) {
  const view = useView();
  return useInfiniteQuery({
    queryKey: ["round-trips", scope, q, sort, dir, pageSize],
    enabled: scope != null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = tripParams(scope!, q, sort, dir);
      // a shared link serves one page (its cursor would carry a ticket)
      p.set("limit", String(view.public ? Math.min(pageSize, 500) : pageSize));
      if (pageParam) p.set("cursor", pageParam);
      return get<RoundTripPage>(`/round-trips?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

/** Strategies, instruments, exit days and common sizes in scope: what completions offer. */
export function useTripFacets(instanceId: string | null, strategy?: string) {
  return useQuery({
    queryKey: ["round-trip-facets", instanceId, strategy ?? null],
    enabled: !!instanceId,
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId! });
      if (strategy) p.set("strategy", strategy);
      return get<RoundTripFacets>(`/round-trips/facets?${p}`);
    },
    staleTime: 60_000,
  });
}

export function useTripDetail(instanceId: string | null, id: string | null) {
  return useQuery({
    queryKey: ["round-trip", instanceId, id],
    enabled: !!instanceId && !!id,
    queryFn: () => get<RoundTripDetail>(`/round-trips/${encodeURIComponent(id!)}?instance=${encodeURIComponent(instanceId!)}`),
  });
}

/** One candle of venue marks on the UTC grid (/round-trips/:id/path). */
export interface PathCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  marks: number;
}

/** A venue mark: the price the position would close at, and its P&L excluding swap. */
export interface PathMark {
  ts: number;
  price: number | null;
  pnl: number;
}

/** The path a position took while held, from the broker poll's marks. */
export interface PositionPath {
  ticket: string;
  status: "open" | "closed";
  side: "long" | "short";
  entry: { ts: number; price: number | null } | null;
  exit: { ts: number; price: number | null } | null;
  stopPrice: number | null;
  targetPrice: number | null;
  bucketMs: number;
  buckets: number[];
  candles: PathCandle[];
  pnl: Array<{ ts: number; pnl: number }>;
  best: PathMark | null;
  worst: PathMark | null;
  last: (PathMark & { swap: number | null }) | null;
  marks: number;
  firstMarkTs: number | null;
  longestGap: { from: number; to: number } | null;
  /** Stretches of at least 15 minutes without a mark, in time order (capped; `gaps` counts all). */
  gapSpans: Array<{ from: number; to: number }>;
  /** Stretches of an hour or more at one unchanged price: a closed market or no quotes. */
  flatSpans: Array<{ from: number; to: number }>;
  gaps: number;
}

/** The held path of one position at a candle size (null: the server's choice); polled while it is open. */
export function usePositionPath(instanceId: string | null, id: string | null, bucketMs: number | null, open: boolean) {
  return useQuery({
    queryKey: ["round-trip-path", instanceId, id, bucketMs],
    enabled: !!instanceId && !!id,
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId! });
      if (bucketMs != null) p.set("bucket", String(bucketMs));
      return get<PositionPath>(`/round-trips/${encodeURIComponent(id!)}/path?${p}`);
    },
    // keep the chart while another candle size loads, never another position's path
    placeholderData: (previous, query) => (query?.queryKey[2] === id ? previous : undefined),
    refetchInterval: open ? 30_000 : false,
  });
}
