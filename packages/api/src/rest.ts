import type { FastifyInstance } from "fastify";
import { listInstances, listStrategies, listOrders, listTrades, searchEvents, equityCurve, instanceHealth, listLogs, strategyStats, performanceReport, dailyNets, drawdownPeriods, postLossStats, tradeBreakdowns, closedTrades, listDeals, accountEquity, listIngestObservations, type Db, type LiveStateStore } from "@qkt-insights/store";
import { requireSession } from "./auth.js";
import { TtlCache } from "./cache.js";

export interface RestDeps { db: Db; liveState: LiveStateStore }

const LIMIT = (q: Record<string, string | undefined>) => Math.min(Number(q.limit ?? 200), 1000);

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const guard = { preHandler: requireSession };
  // Hot reads only — /live/state must stay uncached so WS reconciliation sees broker truth.
  const cache = new TtlCache();
  const need = (reply: any, v: string | undefined, name: string): v is string => {
    if (!v) { reply.code(400).send({ error: `${name} required` }); return false; }
    return true;
  };

  app.get("/instances", guard, async () => listInstances(deps.db));
  app.get("/health/instances", guard, async () => instanceHealth(deps.db));

  app.get<{ Querystring: Record<string, string> }>("/strategies", guard, async (req, reply) => {
    const i = req.query.instance; if (!need(reply, i, "instance")) return;
    return cache.get(req.url, () => listStrategies(deps.db, i));
  });

  app.get<{ Querystring: Record<string, string> }>("/orders", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    return listOrders(deps.db, { instanceId: q.instance, strategyId: q.strategy, symbol: q.symbol, state: q.state, limit: LIMIT(q) });
  });

  app.get<{ Querystring: Record<string, string> }>("/trades", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    return listTrades(deps.db, { instanceId: q.instance, strategyId: q.strategy, symbol: q.symbol, limit: LIMIT(q) });
  });

  app.get<{ Querystring: Record<string, string> }>("/search", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.q, "q")) return;
    return searchEvents(deps.db, { q: q.q, instanceId: q.instance, limit: LIMIT(q) });
  });

  app.get<{ Querystring: Record<string, string> }>("/logs", guard, async (req, reply) => {
    const q = req.query; if (!need(reply, q.instance, "instance")) return;
    return listLogs(deps.db, { instanceId: q.instance, strategyId: q.strategy, level: q.level, q: q.q, limit: LIMIT(q) });
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
