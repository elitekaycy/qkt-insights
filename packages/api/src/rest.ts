import type { FastifyInstance } from "fastify";
import { listInstances, listStrategies, listTrades, searchEvents, equityCurve, instanceHealth, searchLogs, logPage, strategyStats, listDeals, accountEquity, accountDrawdown, accountPerformance, accountRisk, monitorSummaries, withJournalStrategies, listMonitorEvents, type AccountLimits, type Db, type LiveStateStore, type Monitors } from "@qkt-insights/store";
import { CONTRACT_VERSION, SUPPORTED_MAJORS } from "@qkt-insights/contract";
import { UNATTRIBUTED_STRATEGY } from "@qkt-insights/contract/query";
import { requireSession } from "./auth.js";
import { TtlCache } from "./cache.js";
import { performanceBundle } from "./performance.js";
import { Revalidated } from "./revalidate.js";
import { registerRoundTrips } from "./roundTrips.js";

export interface RestDeps {
  db: Db; liveState: LiveStateStore; monitors: Monitors;
  /** Per-account risk limits (INSIGHTS_ACCOUNT_LIMITS); the strategies' qkt risk config otherwise. */
  accountLimits?: AccountLimits;
}

const LIMIT = (q: Record<string, string | undefined>) => Math.min(Number(q.limit ?? 200), 1000);

/** Points /account/equity returns unless the caller asks for more (`points`) or every minute (`resolution=full`). */
export const ACCOUNT_EQUITY_POINTS = 2000;
const ACCOUNT_EQUITY_MAX_POINTS = 20_000;

function accountEquityPoints(q: Record<string, string | undefined>): number | undefined {
  if (q.resolution === "full") return undefined;
  const n = Number(q.points);
  return Number.isFinite(n) && n > 0 ? Math.min(n, ACCOUNT_EQUITY_MAX_POINTS) : ACCOUNT_EQUITY_POINTS;
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const guard = { preHandler: requireSession };
  // Hot reads only — /live/state must stay uncached so WS reconciliation sees broker truth.
  const cache = new TtlCache();
  const versioned = new Revalidated(deps.db);
  const need = (reply: any, v: string | undefined, name: string): v is string => {
    if (!v) { reply.code(400).send({ error: `${name} required` }); return false; }
    return true;
  };

  app.get("/instances", guard, async (req) => cache.get(req.url, () => listInstances(deps.db)));
  app.get("/health/instances", guard, async (req) => cache.get(req.url, () => instanceHealth(deps.db)));
  // The contract /ingest reads, for Health; qkt asks the same of GET /ingest/capabilities with its token.
  app.get("/health/contract", guard, async () => ({ contractVersion: CONTRACT_VERSION, majors: [...SUPPORTED_MAJORS] }));
  app.get("/health/monitors", guard, async () => ({
    monitors: monitorSummaries(deps.db, deps.monitors, Date.now()),
    events: listMonitorEvents(deps.db, 50),
  }));

  app.get<{ Querystring: Record<string, string> }>("/strategies", guard, async (req, reply) => {
    const i = req.query.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => listStrategies(deps.db, i));
  });

  // Also the one WS reconciliation misses: a fill lands on the wire the instant it
  // happens, but a browser opened between polls has nothing until the next one —
  // caching only bounds how many of those get the same DB round trip.
  app.get<{ Querystring: Record<string, string> }>("/trades", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return versioned.send(req, reply, [{ instance: i }], () => listTrades(deps.db, { instanceId: i, strategyId: q.strategy, symbol: q.symbol, limit: LIMIT(q) }));
  });

  app.get<{ Querystring: Record<string, string> }>("/search", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.q, "q")) return;
    return searchEvents(deps.db, { q: q.q, instanceId: q.instance, limit: LIMIT(q) });
  });

  app.get<{ Querystring: Record<string, string> }>("/logs", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    // logger (part of the name), from and to (ms, [from, to)) narrow further; all optional
    const ms = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : undefined);
    return cache.get(req.url, () => searchLogs(deps.db, { instanceId: i, strategyId: logStrategy(q.strategy), level: q.level, q: q.q, logger: q.logger,
      from: ms(q.from), to: ms(q.to), limit: LIMIT(q) }));
  });

  // The Logs page: the same filters, newest first, a page at a time by `cursor`; the first page
  // also says how many lines the whole query matches (`total`).
  app.get<{ Querystring: Record<string, string> }>("/logs/page", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    const ms = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : undefined);
    return cache.get(req.url, () => logPage(deps.db, { instanceId: i, strategyId: logStrategy(q.strategy), level: q.level, q: q.q, logger: q.logger,
      from: ms(q.from), to: ms(q.to), limit: LIMIT(q), cursor: q.cursor }));
  });

  app.get<{ Querystring: Record<string, string> }>("/stats", guard, async (req, reply) => {
    const q = req.query;
    if (!need(reply, q.instance, "instance") || !need(reply, q.strategy, "strategy")) return;
    const f = { instanceId: q.instance, strategyId: q.strategy };
    return cache.get(req.url, () => strategyStats(deps.db, f));
  });

  // One round trip for the whole analytics view; profitFactor "inf" survives JSON as a string.
  // ?include=a,b limits which aggregates run — Overview needs only dailyNets, the close
  // map only closes; the full detail page omits include and gets everything.
  app.get<{ Querystring: Record<string, string> }>("/performance", guard, async (req, reply) => {
    const q = req.query;
    if (!need(reply, q.instance, "instance") || !need(reply, q.strategy, "strategy")) return;
    const f = { instanceId: q.instance, strategyId: q.strategy,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined };
    // Excursions read position marks, which move while a position is open; the rest never does.
    const marks = typeof q.include !== "string" || q.include.split(",").includes("excursions");
    const scopes = [{ strategy: f }, ...(marks ? [{ marks: f.instanceId }] : [])];
    return versioned.send(req, reply, scopes, () => performanceBundle(deps.db, f, q.include, q.window));
  });

  app.get<{ Querystring: Record<string, string> }>("/equity", guard, async (req, reply) => {
    const q = req.query;
    if (!need(reply, q.instance, "instance") || !need(reply, q.strategy, "strategy")) return;
    const f = { instanceId: q.instance, strategyId: q.strategy,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined,
      points: q.points ? Math.min(Number(q.points), 5000) : undefined };
    return versioned.send(req, reply, [{ strategy: f }], () => equityCurve(deps.db, f));
  });

  app.get("/live/state", guard, async () => withJournalStrategies(deps.db, deps.liveState.snapshot(Date.now())));

  app.get<{ Querystring: Record<string, string> }>("/deals", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    const f = { instanceId: q.instance, strategyId: q.strategy, limit: LIMIT(q),
      before: q.before ? Number(q.before) : undefined };
    return versioned.send(req, reply, [{ instance: q.instance }], () => listDeals(deps.db, f));
  });

  // At most ACCOUNT_EQUITY_POINTS points by default: the full minute series is megabytes.
  app.get<{ Querystring: Record<string, string> }>("/account/equity", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return versioned.send(req, reply, [{ account: i }], () => accountEquity(deps.db, { instanceId: i,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined, points: accountEquityPoints(q) }));
  });

  app.get<{ Querystring: Record<string, string> }>("/account/drawdown", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return versioned.send(req, reply, [{ account: i }], () => accountDrawdown(deps.db, { instanceId: i }));
  });

  // Every close on the account: retired strategies and unattributed deals included.
  app.get<{ Querystring: Record<string, string> }>("/account/summary", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return versioned.send(req, reply, [{ instance: i }, { account: i }], () => accountPerformance(deps.db, { instanceId: i,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined }));
  });

  // Drawdown and daily loss against each account's own limits.
  app.get<{ Querystring: Record<string, string> }>("/account/risk", guard, async (req, reply) => {
    const i = req.query.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => accountRisk(deps.db, { instanceId: i, limits: deps.accountLimits, now: Date.now() }));
  });

  registerRoundTrips(app, deps);
}

/** `strategy=` on the log endpoints: a strategy id, or `unattributed` for the lines no strategy wrote (as the round-trip endpoints read it). */
function logStrategy(v: string | undefined): string | null | undefined {
  return v === UNATTRIBUTED_STRATEGY ? null : v || undefined;
}
