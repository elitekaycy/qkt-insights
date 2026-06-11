import type { FastifyInstance } from "fastify";
import { listInstances, listStrategies, listOrders, listTrades, searchEvents, equityCurve, instanceHealth, listLogs, strategyStats, type Db } from "@qkt-insights/store";
import { requireSession } from "./auth.js";

export interface RestDeps { db: Db }

const LIMIT = (q: Record<string, string | undefined>) => Math.min(Number(q.limit ?? 200), 1000);

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const guard = { preHandler: requireSession };
  const need = (reply: any, v: string | undefined, name: string): v is string => {
    if (!v) { reply.code(400).send({ error: `${name} required` }); return false; }
    return true;
  };

  app.get("/instances", guard, async () => listInstances(deps.db));
  app.get("/health/instances", guard, async () => instanceHealth(deps.db));

  app.get<{ Querystring: Record<string, string> }>("/strategies", guard, async (req, reply) => {
    const i = req.query.instance; if (!need(reply, i, "instance")) return;
    return listStrategies(deps.db, i);
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
    return strategyStats(deps.db, { instanceId: q.instance, strategyId: q.strategy });
  });

  app.get<{ Querystring: Record<string, string> }>("/equity", guard, async (req, reply) => {
    const q = req.query;
    if (!need(reply, q.instance, "instance") || !need(reply, q.strategy, "strategy")) return;
    return equityCurve(deps.db, { instanceId: q.instance, strategyId: q.strategy,
      from: q.from ? Number(q.from) : undefined, to: q.to ? Number(q.to) : undefined });
  });
}
