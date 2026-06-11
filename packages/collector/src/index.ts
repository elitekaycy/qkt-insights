import type { FastifyInstance } from "fastify";
import { BatchSchema } from "@qkt-insights/contract";
import { ingestEvents, type Db, type LiveBus } from "@qkt-insights/store";

export interface CollectorDeps { db: Db; bus: LiveBus; ingestToken: string }

export function registerCollector(app: FastifyInstance, deps: CollectorDeps): void {
  app.post("/ingest", async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${deps.ingestToken}`) return reply.code(401).send({ error: "unauthorized" });

    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid batch", detail: parsed.error.message });

    const { instanceId, events } = parsed.data;
    const accepted = ingestEvents(deps.db, instanceId, events);
    for (const e of events) deps.bus.publish(e);
    return reply.code(200).send({ accepted });
  });
}
