import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { openDb, LiveBus } from "@qkt-insights/store";
import { registerCollector } from "@qkt-insights/collector";
import { registerAuth, registerRest, registerLive } from "@qkt-insights/api";
import { existsSync } from "node:fs";
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
  const app = Fastify({ logger: true });

  registerCollector(app, { db, bus, ingestToken: env("INGEST_TOKEN") });

  if (mode === "serve" || mode === "run") {
    await app.register(cookie);
    await app.register(websocket);
    registerAuth(app, { passwordHash: env("ADMIN_PASSWORD_HASH"), sessionSecret: env("SESSION_SECRET", env("INGEST_TOKEN")) });
    registerRest(app, { db });
    registerLive(app, { bus });
  }

  if (mode === "run") {
    const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
    if (existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, wildcard: false });
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
