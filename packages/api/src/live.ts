import type { FastifyInstance } from "fastify";
import type { LiveBus } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";

export interface LiveDeps { bus: LiveBus }

interface Filter { instance?: string; strategy?: string; types?: Set<string> }

function matches(e: Envelope, f: Filter): boolean {
  if (f.instance && e.instanceId !== f.instance) return false;
  if (f.strategy && e.strategyId !== f.strategy) return false;
  if (f.types && !f.types.has(e.type)) return false;
  return true;
}

export function registerLive(app: FastifyInstance, deps: LiveDeps): void {
  app.get("/live", { websocket: true }, (socket, req) => {
    const q = req.query as Record<string, string>;
    const filter: Filter = {
      instance: q.instance,
      strategy: q.strategy,
      types: q.types ? new Set(q.types.split(",")) : undefined,
    };
    const off = deps.bus.subscribe((e) => {
      if (matches(e, filter) && socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    });
    socket.on("close", off);
  });
}
