import type { FastifyInstance } from "fastify";
import { BatchSchema } from "@qkt-insights/contract";
import { ingestAck, ingestEvents, persistStateEvent, touchInstance, type Db, type LiveBus, type LiveStateStore } from "@qkt-insights/store";

export interface CollectorDeps { db: Db; bus: LiveBus; liveState: LiveStateStore; ingestToken: string }

export function registerCollector(app: FastifyInstance, deps: CollectorDeps): void {
  app.post("/ingest", async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${deps.ingestToken}`) return reply.code(401).send({ error: "unauthorized" });

    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid batch", detail: parsed.error.message });

    const { instanceId, events } = parsed.data;
    const mismatch = events.find((e) => e.instanceId !== instanceId);
    if (mismatch) {
      return reply.code(400).send({
        error: "instance mismatch",
        detail: `batch instanceId ${instanceId} does not match envelope ${mismatch.id} instanceId ${mismatch.instanceId}`,
      });
    }
    // Last-value state lives in memory only; everything durable goes to the db.
    const stateEvents = events.filter((e) => e.type.startsWith("state."));
    const rest = events.filter((e) => !e.type.startsWith("state."));
    const sinceTs = events.length > 0 ? Math.min(...events.map((e) => e.ts)) : Date.now();
    const accepted = ingestEvents(deps.db, instanceId, rest);
    for (const e of stateEvents) {
      deps.liveState.upsert(instanceId, e);
      persistStateEvent(deps.db, instanceId, e);
    }
    // state.* writes no durable row, but the 10s broker poll is the freshest proof
    // the instance is alive — bump the heartbeat so Health doesn't read it as stale.
    if (stateEvents.length > 0)
      touchInstance(deps.db, instanceId,
        Math.max(...stateEvents.map((e) => e.ts)),
        Math.max(...stateEvents.map((e) => e.seq)));
    for (const e of events) deps.bus.publish(e);
    return reply.code(200).send({
      accepted: accepted + stateEvents.length,
      ack: {
        ...ingestAck(deps.db, instanceId, sinceTs),
        received: events.length,
        acknowledgedIds: events.map((e) => e.id),
      },
    });
  });
}
