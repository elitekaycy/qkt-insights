import type { FastifyInstance } from "fastify";
import { listInstances, listStrategies, listOrders, listTrades, searchEvents, equityCurve, instanceHealth, listLogs, strategyStats, performanceReport, dailyNets, drawdownPeriods, postLossStats, tradeBreakdowns, closedTrades, listDeals, accountEquity, accountDrawdown, listIngestObservations, dowHourMatrix, rollingStats, costDecomposition, contributionRanking, normalizedPerformance, excursionStats, executionQuality, monitorSummaries, listMonitorEvents, type Db, type LiveStateStore, type Monitors } from "@qkt-insights/store";
import { requireSession } from "./auth.js";
import { TtlCache } from "./cache.js";

export interface RestDeps { db: Db; liveState: LiveStateStore; monitors: Monitors }

const LIMIT = (q: Record<string, string | undefined>) => Math.min(Number(q.limit ?? 200), 1000);

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const guard = { preHandler: requireSession };
  // Hot reads only — /live/state must stay uncached so WS reconciliation sees broker truth.
  const cache = new TtlCache();
  const need = (reply: any, v: string | undefined, name: string): v is string => {
    if (!v) { reply.code(400).send({ error: `${name} required` }); return false; }
    return true;
  };

  app.get("/instances", guard, async (req) => cache.get(req.url, () => listInstances(deps.db)));
  app.get("/health/instances", guard, async (req) => cache.get(req.url, () => instanceHealth(deps.db)));
  app.get("/health/monitors", guard, async () => ({
    monitors: monitorSummaries(deps.db, deps.monitors, Date.now()),
    events: listMonitorEvents(deps.db, 50),
  }));

  app.get<{ Querystring: Record<string, string> }>("/strategies", guard, async (req, reply) => {
    const i = req.query.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => listStrategies(deps.db, i));
  });

  app.get<{ Querystring: Record<string, string> }>("/orders", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => listOrders(deps.db, { instanceId: i, strategyId: q.strategy, symbol: q.symbol, state: q.state, limit: LIMIT(q) }));
  });

  // Also the one WS reconciliation misses: a fill lands on the wire the instant it
  // happens, but a browser opened between polls has nothing until the next one —
  // caching only bounds how many of those get the same DB round trip.
  app.get<{ Querystring: Record<string, string> }>("/trades", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => listTrades(deps.db, { instanceId: i, strategyId: q.strategy, symbol: q.symbol, limit: LIMIT(q) }));
  });

  app.get<{ Querystring: Record<string, string> }>("/search", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.q, "q")) return;
    return searchEvents(deps.db, { q: q.q, instanceId: q.instance, limit: LIMIT(q) });
  });

  app.get<{ Querystring: Record<string, string> }>("/logs", guard, async (req, reply) => {
    const q = req.query; const i = q.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => listLogs(deps.db, { instanceId: i, strategyId: q.strategy, level: q.level, q: q.q, limit: LIMIT(q) }));
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
    const include = q.include ? new Set(q.include.split(",")) : null;
    const want = (k: string) => include == null || include.has(k);
    return cache.get(req.url, () => ({
      report: want("report") ? performanceReport(deps.db, f) : undefined,
      dailyNets: want("dailyNets") ? dailyNets(deps.db, f) : undefined,
      drawdownPeriods: want("drawdownPeriods") ? drawdownPeriods(deps.db, f) : undefined,
      postLoss: want("postLoss") ? postLossStats(deps.db, f) : undefined,
      breakdowns: want("breakdowns") ? tradeBreakdowns(deps.db, f) : undefined,
      closes: want("closes") ? closedTrades(deps.db, f) : undefined,
      dowHour: want("dowHour") ? dowHourMatrix(deps.db, f) : undefined,
      rolling: want("rolling") ? rollingStats(deps.db, f, q.window ? Number(q.window) : undefined) : undefined,
      costs: want("costs") ? costDecomposition(deps.db, f) : undefined,
      contribution: want("contribution") ? contributionRanking(deps.db, f) : undefined,
      normalized: want("normalized") ? normalizedPerformance(deps.db, f) : undefined,
      excursions: want("excursions") ? excursionStats(deps.db, f) : undefined,
      execution: want("execution") ? executionQuality(deps.db, f) : undefined,
    }));
  });

  app.get<{ Querystring: Record<string, string> }>("/equity", guard, async (req, reply) => {
    const q = req.query;
    if (!need(reply, q.instance, "instance") || !need(reply, q.strategy, "strategy")) return;
    const f = { instanceId: q.instance, strategyId: q.strategy,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined,
      points: q.points ? Math.min(Number(q.points), 5000) : undefined };
    return cache.get(req.url, () => equityCurve(deps.db, f));
  });

  app.get("/live/state", guard, async () => deps.liveState.snapshot(Date.now()));

  app.get<{ Querystring: Record<string, string> }>("/deals", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    const f = { instanceId: q.instance, strategyId: q.strategy, limit: LIMIT(q),
      before: q.before ? Number(q.before) : undefined };
    return cache.get(req.url, () => listDeals(deps.db, f));
  });

  app.get<{ Querystring: Record<string, string> }>("/account/equity", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    return accountEquity(deps.db, { instanceId: q.instance,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined });
  });

  app.get<{ Querystring: Record<string, string> }>("/account/drawdown", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    return accountDrawdown(deps.db, { instanceId: q.instance });
  });

  app.get<{ Querystring: Record<string, string> }>("/ingest/observations", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    return listIngestObservations(deps.db, {
      instanceId: q.instance,
      kind: q.kind,
      sinceTs: q.since ? Number(q.since) : undefined,
      limit: LIMIT(q),
    });
  });
}
