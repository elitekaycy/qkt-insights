import "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { LiveBus } from "@qkt-insights/store";
import type { Envelope } from "@qkt-insights/contract";

export interface LiveDeps {
  bus: LiveBus;
  // Returns whether the upgrading request carries a valid session. Omitted = open
  // (unit tests); the server always passes the session check.
  authenticate?: (req: { cookies?: Record<string, string | undefined> }) => boolean;
  maxSocketsPerIp?: number;
  /** How often an open socket's session is re-checked, so a revoked session loses the stream. */
  revalidateMs?: number;
}

export const MAX_SOCKETS_PER_IP = 20;
export const SOCKET_REVALIDATE_MS = 60_000;

/** Close codes: 1008 policy violation, 1013 try again later. */
const POLICY = 1008;
const TRY_LATER = 1013;

interface Filter { instance?: string; strategy?: string; types?: Set<string> }

function matches(e: Envelope, f: Filter): boolean {
  if (f.instance && e.instanceId !== f.instance) return false;
  if (f.strategy && e.strategyId !== f.strategy) return false;
  if (f.types && !f.types.has(e.type)) return false;
  return true;
}

function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function registerLive(app: FastifyInstance, deps: LiveDeps): void {
  const maxPerIp = deps.maxSocketsPerIp ?? MAX_SOCKETS_PER_IP;
  const openPerIp = new Map<string, number>();
  app.get("/live", { websocket: true }, (socket, req) => {
    const authed = () => !deps.authenticate || deps.authenticate(req as { cookies?: Record<string, string | undefined> });
    if (!sameOrigin(req.headers.origin, req.headers.host) || !authed()) {
      socket.close(POLICY, "unauthorized");
      return;
    }
    const open = openPerIp.get(req.ip) ?? 0;
    if (open >= maxPerIp) {
      socket.close(TRY_LATER, "too many connections");
      return;
    }
    openPerIp.set(req.ip, open + 1);
    const q = req.query as Record<string, string>;
    const filter: Filter = {
      instance: q.instance,
      strategy: q.strategy,
      types: q.types ? new Set(q.types.split(",")) : undefined,
    };
    const off = deps.bus.subscribe((e) => {
      if (matches(e, filter) && socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    });
    const recheck = setInterval(() => {
      if (!authed()) socket.close(POLICY, "session ended");
    }, deps.revalidateMs ?? SOCKET_REVALIDATE_MS);
    recheck.unref();
    socket.on("close", () => {
      off();
      clearInterval(recheck);
      const left = (openPerIp.get(req.ip) ?? 1) - 1;
      if (left > 0) openPerIp.set(req.ip, left);
      else openPerIp.delete(req.ip);
    });
  });
}
