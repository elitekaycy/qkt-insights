import type { FastifyInstance } from "fastify";
import { BatchSchema } from "@qkt-insights/contract";
import { ingestEvents, type Db, type LiveBus, type LiveStateStore } from "@qkt-insights/store";

export interface CollectorDeps { db: Db; bus: LiveBus; liveState: LiveStateStore; ingestToken: string }

export function registerCollector(app: FastifyInstance, deps: CollectorDeps): void {
  app.post("/ingest", async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${deps.ingestToken}`) return reply.code(401).send({ error: "unauthorized" });

    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid batch", detail: parsed.error.message });

    const { instanceId, events } = parsed.data;
    // Last-value state lives in memory only; everything durable goes to the db.
    const stateEvents = events.filter((e) => e.type.startsWith("state."));
    const rest = events.filter((e) => !e.type.startsWith("state."));
    const accepted = ingestEvents(deps.db, instanceId, rest);
    for (const e of stateEvents) deps.liveState.upsert(instanceId, e);
    for (const e of events) deps.bus.publish(e);
    return reply.code(200).send({ accepted: accepted + stateEvents.length });
  });
}
