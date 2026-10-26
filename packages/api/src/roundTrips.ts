import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseQuery, UNATTRIBUTED_STRATEGY, type ParsedQuery } from "@qkt-insights/contract/query";
import {
  listRoundTrips, positionPath, PATH_BUCKETS, roundTripAnalytics, roundTripDetail, roundTripFacets, roundTripPages, roundTripTotals, ROUND_TRIP_SORTS, tripPrice,
  type Db, type RoundTripQuery, type TripRow, type RoundTripScope, type RoundTripSort, type RoundTripTotals,
} from "@qkt-insights/store";
import { requireSession } from "./auth.js";
import { Revalidated } from "./revalidate.js";

/*
 * Round trips for the Trades page, a strategy's trades and the calendar's day drill: one query
 * language (`q`, parsed by the same code as the web bar), keyset pages, totals of the whole
 * match in the first page, a CSV of the whole match, and one round trip in full for the drawer.
 */

export const ROUND_TRIP_PAGE_MAX = 500;
const Q_MAX = 500;

type Query = Record<string, string | undefined>;

export interface RoundTripRequest {
  scope: RoundTripScope;
  parsed: ParsedQuery;
  sort: RoundTripSort;
  dir: "asc" | "desc";
}

/** Validates the shared parameters; a string is the 400 message. */
export function readRoundTripRequest(db: Db, q: Query): RoundTripRequest | string {
  const instanceId = q.instance;
  if (!instanceId) return "instance required";
  if ((q.q ?? "").length > Q_MAX) return `q longer than ${Q_MAX} characters`;
  const sort = (q.sort ?? "entry") as RoundTripSort;
  if (!Object.hasOwn(ROUND_TRIP_SORTS, sort)) return `sort must be one of ${Object.keys(ROUND_TRIP_SORTS).join(", ")}`;
  const dir = q.dir ?? "desc";
  if (dir !== "asc" && dir !== "desc") return "dir must be asc or desc";
  const since = q.from != null ? Number(q.from) : undefined;
  if (since !== undefined && !Number.isFinite(since)) return "from must be epoch milliseconds";
  const scope: RoundTripScope = { instanceId, since };
  if (q.strategy) scope.strategyId = q.strategy === UNATTRIBUTED_STRATEGY ? null : q.strategy;
  return { scope, parsed: parseFor(db, scope, q.q ?? ""), sort, dir };
}

/** Parses `q` against what the scope holds, so prefixes and bare instrument names resolve as the bar resolved them. */
export function parseFor(db: Db, scope: RoundTripScope, text: string): ParsedQuery {
  if (!text.trim()) return parseQuery("");
  const f = roundTripFacets(db, scope);
  return parseQuery(text, {
    strategies: f.strategies.flatMap((s) => (s.id ? [s.id] : [])),
    instruments: f.instruments.map((i) => i.name),
  });
}

function limitOf(q: Query, fallback: number): number | string {
  if (q.limit == null) return fallback;
  const n = Number(q.limit);
  return Number.isInteger(n) && n >= 1 && n <= ROUND_TRIP_PAGE_MAX ? n : `limit must be 1..${ROUND_TRIP_PAGE_MAX}`;
}

export interface RoundTripResponse {
  rows: TripRow[];
  nextCursor: string | null;
  /** Present on the first page (no cursor): the whole match. */
  totals: RoundTripTotals | null;
  query: { canonical: string; errors: string[] };
}

/** Prices at the instrument's precision; the stop and target also raw, as the engine computed them. */
const CSV_COLUMNS: Array<[string, (r: TripRow) => unknown]> = [
  ["ticket", (r) => r.id], ["strategy", (r) => r.strategyId ?? UNATTRIBUTED_STRATEGY], ["instrument", (r) => r.instrument],
  ["symbol", (r) => r.symbol], ["side", (r) => r.side], ["status", (r) => r.status],
  ["entry_utc", (r) => (r.entryTs != null ? new Date(r.entryTs).toISOString() : "")], ["entry_price", (r) => tripPrice(r.entryPrice, r.priceDigits)],
  ["exit_utc", (r) => (r.exitTs != null ? new Date(r.exitTs).toISOString() : "")], ["exit_price", (r) => tripPrice(r.exitPrice, r.priceDigits)],
  ["size", (r) => r.qty], ["pnl", (r) => r.pnl], ["r", (r) => r.r], ["risk", (r) => r.risk], ["held_ms", (r) => r.holdMs],
  ["ended", (r) => r.ended], ["stop", (r) => tripPrice(r.stopPrice, r.priceDigits)], ["target", (r) => tripPrice(r.targetPrice, r.priceDigits)],
  ["stop_raw", (r) => r.stopPrice], ["target_raw", (r) => r.targetPrice], ["legs", (r) => r.legs],
];

/** One CSV field: quoted when it must be, and a text cell a spreadsheet would run as a formula is defused. */
export function csvField(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerRoundTrips(app: FastifyInstance, deps: { db: Db }): void {
  const guard = { preHandler: requireSession };
  const versioned = new Revalidated(deps.db);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

  app.get<{ Querystring: Query }>("/round-trips", guard, async (req, reply) => {
    const r = readRoundTripRequest(deps.db, req.query);
    if (typeof r === "string") return bad(reply, r);
    const limit = limitOf(req.query, 100);
    if (typeof limit === "string") return bad(reply, limit);
    const cursor = req.query.cursor ?? null;
    return versioned.send(req, reply, [{ instance: r.scope.instanceId }], (): RoundTripResponse => {
      const q: RoundTripQuery = { ...r.scope, filter: r.parsed.filter, sort: r.sort, dir: r.dir, cursor, limit };
      const page = listRoundTrips(deps.db, q);
      return { ...page, totals: cursor ? null : roundTripTotals(deps.db, q), query: { canonical: r.parsed.canonical, errors: r.parsed.errors } };
    });
  });

  // Every aggregate of a strategy's journal sections, for the same scope and query as the list.
  app.get<{ Querystring: Query }>("/round-trips/analytics", guard, async (req, reply) => {
    const r = readRoundTripRequest(deps.db, req.query);
    if (typeof r === "string") return bad(reply, r);
    return versioned.send(req, reply, [{ instance: r.scope.instanceId }], () => ({
      ...roundTripAnalytics(deps.db, { ...r.scope, filter: r.parsed.filter }),
      query: { canonical: r.parsed.canonical, errors: r.parsed.errors },
    }));
  });

  app.get<{ Querystring: Query }>("/round-trips/facets", guard, async (req, reply) => {
    const i = req.query.instance;
    if (!i) return bad(reply, "instance required");
    const scope: RoundTripScope = { instanceId: i };
    if (req.query.strategy) scope.strategyId = req.query.strategy === UNATTRIBUTED_STRATEGY ? null : req.query.strategy;
    return versioned.send(req, reply, [{ instance: i }], () => roundTripFacets(deps.db, scope));
  });

  // The whole match, streamed page by page: an export never holds every row at once.
  app.get<{ Querystring: Query }>("/round-trips/export", guard, async (req, reply) => {
    const r = readRoundTripRequest(deps.db, req.query);
    if (typeof r === "string") return bad(reply, r);
    const q: RoundTripQuery = { ...r.scope, filter: r.parsed.filter, sort: r.sort, dir: r.dir };
    const db = deps.db;
    function* lines(): Generator<string> {
      yield `${CSV_COLUMNS.map(([h]) => h).join(",")}\n`;
      for (const page of roundTripPages(db, q)) yield page.map((row) => `${CSV_COLUMNS.map(([, f]) => csvField(f(row))).join(",")}\n`).join("");
    }
    const day = new Date().toISOString().slice(0, 10);
    const name = `round-trips-${r.scope.instanceId.replace(/[^\w.-]/g, "_")}-${day}.csv`;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "private, no-store")
      .send(Readable.from(lines()));
  });

  app.get<{ Params: { id: string }; Querystring: Query }>("/round-trips/:id", guard, async (req, reply) => {
    const i = req.query.instance;
    if (!i) return bad(reply, "instance required");
    const id = req.params.id;
    if (id.length > 128) return bad(reply, "id too long");
    const detail = await versioned.send(req, reply, [{ instance: i }, { marks: i }], () => roundTripDetail(deps.db, i, id));
    if (detail === null) return reply.code(404).send({ error: "no such round trip" });
    return detail;
  });

  app.get<{ Params: { id: string }; Querystring: Query }>("/round-trips/:id/path", guard, async (req, reply) => {
    const i = req.query.instance;
    if (!i) return bad(reply, "instance required");
    const id = req.params.id;
    if (id.length > 128) return bad(reply, "id too long");
    const bucket = req.query.bucket != null ? Number(req.query.bucket) : undefined;
    if (bucket !== undefined && !(PATH_BUCKETS as readonly number[]).includes(bucket)) return bad(reply, `bucket must be one of ${PATH_BUCKETS.join(", ")}`);
    const path = await versioned.send(req, reply, [{ instance: i }, { marks: i }], () => positionPath(deps.db, i, id, bucket));
    if (path === null) return reply.code(404).send({ error: "no such round trip" });
    return path;
  });
}
