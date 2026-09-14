import type { FastifyInstance } from "fastify";
import type { Views } from "@qkt-insights/store";
import { requireSession } from "./auth.js";

export interface ViewsDeps { views: Views; now?: () => number }

const DAY_MS = 86_400_000;
export const VIEW_RANGES: Record<string, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, "90d": 90 * DAY_MS };

type Query = Record<string, unknown>;
const text = (v: unknown, max = 256): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** Viewership of shared links, for the signed-in operator only. */
export function registerViews(app: FastifyInstance, deps: ViewsDeps): void {
  const now = deps.now ?? Date.now;
  const guard = { preHandler: requireSession };

  app.get<{ Querystring: Query }>("/views/summary", guard, async (req, reply) => {
    const instanceId = text(req.query.instance);
    if (!instanceId) return reply.code(400).send({ error: "instance required" });
    const range = text(req.query.range, 8) ?? "30d";
    const span = VIEW_RANGES[range];
    if (span == null) return reply.code(400).send({ error: `range must be one of ${Object.keys(VIEW_RANGES).join(", ")}` });
    const to = now() + 1;
    return deps.views.summary({ instanceId, from: to - span, to, kind: text(req.query.kind, 16), subject: text(req.query.subject) });
  });

  app.get<{ Querystring: Query }>("/views", guard, async (req, reply) => {
    const instanceId = text(req.query.instance);
    if (!instanceId) return reply.code(400).send({ error: "instance required" });
    const limit = Number(text(req.query.limit, 8) ?? 200);
    const before = Number(text(req.query.before, 20));
    return deps.views.list({
      instanceId,
      limit: Number.isFinite(limit) ? limit : 200,
      q: text(req.query.q, 100) || undefined,
      kind: text(req.query.kind, 16),
      subject: text(req.query.subject),
      before: Number.isFinite(before) && before > 0 ? before : undefined,
    });
  });
}
