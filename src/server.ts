import Fastify from "fastify";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { openDb, checkpoint, LiveBus, LiveStateStore, pruneRetention, pruneStaleStrategies } from "@qkt-insights/store";
import { registerCollector } from "@qkt-insights/collector";
import { registerAuth, registerRest, registerLive, hasSession } from "@qkt-insights/api";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Mode = "collect" | "serve" | "run";

export function parseMode(argv: string[]): Mode {
  const m = argv[0] ?? "run";
  if (m === "collect" || m === "serve" || m === "run") return m;
  throw new Error(`unknown mode: ${m}`);
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null) throw new Error(`missing env ${name}`);
  return v;
}

export async function buildServer(mode: Mode) {
  const db = openDb(env("INSIGHTS_DB", "/data/insights.db"));
  const bus = new LiveBus();
  const liveState = new LiveStateStore();
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/healthz", async () => ({ ok: true, mode }));

  registerCollector(app, { db, bus, liveState, ingestToken: env("INGEST_TOKEN") });
  // WAL upkeep: fold the WAL back into the main file every 10 minutes so it cannot grow
  // past its size limit between checkpoints. unref so the timer never holds the process open.
  const upkeep = setInterval(() => {
    try {
      checkpoint(db);
    } catch (err) {
      app.log.error({ err }, "wal checkpoint failed");
    }
  }, 10 * 60_000);
  upkeep.unref();

  // Retention: prune operational logs/events and stale position marks past the window so the DB
  // does not grow unbounded (trade events and open-position history are kept — see pruneRetention).
  // Run once shortly after boot (covers restart-heavy periods) and weekly thereafter. unref so
  // neither timer holds the process open.
  const prune = () => {
    try {
      const now = Date.now();
      const r = pruneRetention(db, now);
      if (r.logs || r.events || r.valuations)
        app.log.info({ ...r }, "retention prune");
      // Retire strategies that stopped reporting past the window (e.g. a swapped-out book) along
      // with all their data, so old registrations don't linger in the dashboard forever.
      const s = pruneStaleStrategies(db, now);
      if (s.strategies)
        app.log.info({ ...s }, "stale strategies pruned");
    } catch (e) {
      app.log.error(e, "retention prune failed");
    }
  };
  const firstPrune = setTimeout(prune, 5 * 60_000);
  firstPrune.unref();
  const retention = setInterval(prune, 7 * 24 * 60 * 60_000);
  retention.unref();

  if (mode === "serve" || mode === "run") {
    await app.register(cookie);
    await app.register(websocket);
    registerAuth(app, {
      username: env("ADMIN_USERNAME"),
      passwordHash: await argon2.hash(env("ADMIN_PASSWORD")),
      sessionSecret: env("SESSION_SECRET", env("INGEST_TOKEN")),
    });
    registerRest(app, { db, liveState });
    registerLive(app, { bus, authenticate: hasSession });
    // Persist the in-memory account state once a minute so the equity curve
    // survives restarts; unref so the timer never holds the process open.
    const rollup = setInterval(() => liveState.flushRollup(db, Date.now()), 60_000);
    rollup.unref();
  }

  if (mode === "run") {
    const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
    if (existsSync(webDist)) {
      // One image serves many dashboards (one per qkt box). INSIGHTS_NAME is the
      // label that tells the installed apps apart on a phone's home screen; it is
      // stamped into the manifest here rather than at build time.
      const brand = process.env.INSIGHTS_NAME?.trim() || null;
      app.get("/brand", async () => ({ name: brand }));
      const manifestPath = join(webDist, "manifest.webmanifest");
      if (brand && existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const branded = JSON.stringify({ ...manifest, name: `${brand} · qkt-insights`, short_name: brand.slice(0, 12) });
        app.get("/manifest.webmanifest", async (_req, reply) => reply.type("application/manifest+json").send(branded));
      }
      // wildcard: the explicit routes above win over the static handler, and assets
      // written after boot are still served
      await app.register(fastifyStatic, { root: webDist });
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.method === "GET" && !req.url.startsWith("/api")) return reply.sendFile("index.html");
        return reply.code(404).send({ error: "not found" });
      });
    }
  }

  return app;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const app = await buildServer(mode);
  const port = Number(process.env.PORT ?? 8420);
  await app.listen({ port, host: "0.0.0.0" });
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
