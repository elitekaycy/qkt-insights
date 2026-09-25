import Fastify from "fastify";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { openDb, checkpoint, LiveBus, LiveStateStore, MarketDataEpisodes, Monitors, Sessions, Shares, Views, pruneRetention, pruneStaleStrategies, replaceStrategyCapital } from "@qkt-insights/store";
import { registerCollector } from "@qkt-insights/collector";
import {
  REQUESTS_PER_MINUTE, TotpVerifier, TtlCache, generateTotpSecret, hasSession, registerAuth, registerLive, registerPublic, registerRest, registerSecurity,
  invalidateShareScopes, registerShares, registerViews, sweepHiddenShares, totpUri,
} from "@qkt-insights/api";
import { authAlertText, channelsFromEnv, parseHttpMonitors, parseMarketDataMonitor, sendAlert, startMonitors } from "./monitors.js";
import { parseStrategyCapital } from "./capital.js";
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

function secret(name: string, minLength: number): string {
  const v = env(name);
  if (v.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  return v;
}

/**
 * Which peers may set X-Forwarded-For/-Proto. The default trusts loopback and Docker's bridge
 * range 172.16.0.0/12: a host proxy such as Caddy reaches a published port through the bridge
 * gateway, and a proxy container such as Traefik sits on the bridge itself. Tailscale, LAN and
 * public peers are not trusted, so they cannot spoof their address past the rate limits. Every
 * container on a bridge network is trusted.
 */
export const DEFAULT_TRUST_PROXY = "loopback,172.16.0.0/12";

function trustProxy(value: string | undefined): string | boolean {
  const v = value?.trim();
  if (!v) return DEFAULT_TRUST_PROXY;
  if (v === "false") return false;
  return v;
}

/** Minutes public views run behind live data; whole minutes from 0 to one day. */
export function publicDelayMinutes(value: string | undefined): number {
  const v = value?.trim();
  if (!v) return 15;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1440) throw new Error("PUBLIC_DELAY_MINUTES must be a whole number of minutes from 0 to 1440");
  return n;
}

export function totpSetupText(account: string): string {
  const s = generateTotpSecret();
  return [
    "Add this to the collector's environment, then restart it:",
    "",
    `  ADMIN_TOTP_SECRET=${s}`,
    "",
    "Scan or paste this into an authenticator app (1Password, Google Authenticator, Aegis):",
    "",
    `  ${totpUri(s, account)}`,
    "",
  ].join("\n");
}

export async function buildServer(mode: Mode) {
  const capitals = parseStrategyCapital(process.env.STRATEGY_CAPITAL);
  const db = openDb(env("INSIGHTS_DB", "/data/insights.db"));
  replaceStrategyCapital(db, capitals);
  const bus = new LiveBus();
  const liveState = new LiveStateStore();
  const monitors = new Monitors(db);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", trustProxy: trustProxy(process.env.TRUST_PROXY) });
  // One image serves many dashboards (one per qkt box). INSIGHTS_NAME is the
  // label that tells the installed apps apart on a phone's home screen and the
  // prefix on every alert from this box.
  const brand = process.env.INSIGHTS_NAME?.trim() || null;

  registerSecurity(app, { requestsPerMinute: REQUESTS_PER_MINUTE });
  app.get("/healthz", async () => ({ ok: true, mode }));

  registerCollector(app, { db, bus, liveState, ingestToken: secret("INGEST_TOKEN", 24) });
  const channels = channelsFromEnv(process.env);
  // Uptime runs beside the collector: it is the process that receives the heartbeats.
  const marketData = parseMarketDataMonitor(process.env);
  const stopMonitors = startMonitors({
    db, monitors, brand, log: app.log,
    http: parseHttpMonitors(process.env.INSIGHTS_MONITORS),
    marketData: marketData && { episodes: new MarketDataEpisodes(db), alertAfterMs: marketData.alertAfterMs },
    channels,
  });
  app.addHook("onClose", async () => stopMonitors());
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
      if (r.logs || r.events || r.valuations || r.views)
        app.log.info({ ...r }, "retention prune");
      // Retire strategies that stopped reporting past the window (e.g. a swapped-out book) along
      // with all their data, so old registrations don't linger in the dashboard forever.
      if (r.monitors) app.log.info({ monitors: r.monitors }, "monitor history pruned");
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
    const totpSecret = process.env.ADMIN_TOTP_SECRET?.trim();
    let totp: TotpVerifier | undefined;
    try {
      totp = totpSecret ? new TotpVerifier(totpSecret) : undefined;
    } catch {
      throw new Error("ADMIN_TOTP_SECRET must be a base32 secret (generate one with the totp-setup command)");
    }
    registerAuth(app, {
      username: env("ADMIN_USERNAME"),
      passwordHash: await argon2.hash(secret("ADMIN_PASSWORD", 12)),
      sessions: new Sessions(db),
      totp,
      onEvent: (e) => {
        const entry = { auth: e.kind, ip: e.ip, userAgent: e.userAgent, lock: e.lock };
        if (e.kind === "login" || e.kind === "logout-all") app.log.info(entry, "auth");
        else app.log.warn(entry, "auth");
        const text = authAlertText(e, brand);
        if (text) void sendAlert(text, { kind: `auth.${e.kind}`, ip: e.ip }, { channels, brand, log: app.log });
      },
    });
    registerRest(app, { db, liveState, monitors });
    registerLive(app, { bus, authenticate: hasSession });
    const shares = new Shares(db);
    const views = new Views(db);
    const publicCache = new TtlCache(60_000, 1000);
    registerShares(app, { db, shares, cache: publicCache, views });
    registerPublic(app, { db, liveState, shares, cache: publicCache, delayMs: publicDelayMinutes(process.env.PUBLIC_DELAY_MINUTES) * 60_000, views });
    registerViews(app, { views });
    // Links whose subject stopped being public without an admin change (deploy metadata moved a
    // strategy, a strategy was pruned) are replaced within a minute.
    const shareSweep = setInterval(() => {
      try {
        const revoked = sweepHiddenShares(db, shares);
        if (revoked > 0) {
          invalidateShareScopes(publicCache);
          app.log.info({ revoked }, "share links revoked");
        }
      } catch (err) {
        app.log.error({ err }, "share link sweep failed");
      }
    }, 60_000);
    shareSweep.unref();
    app.addHook("onClose", async () => clearInterval(shareSweep));
    // Persist the in-memory account state once a minute so the equity curve
    // survives restarts; unref so the timer never holds the process open.
    const rollup = setInterval(() => liveState.flushRollup(db, Date.now()), 60_000);
    rollup.unref();
  }

  if (mode === "run") {
    const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
    if (existsSync(webDist)) {
      // The brand is stamped into the manifest here rather than at build time.
      app.get("/brand", async () => ({ name: brand }));
      const manifestPath = join(webDist, "manifest.webmanifest");
      if (brand && existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const branded = JSON.stringify({ ...manifest, name: `${brand} · qkt-insights`, short_name: brand.slice(0, 12) });
        app.get("/manifest.webmanifest", async (_req, reply) =>
          reply.type("application/manifest+json").header("cache-control", "no-cache").send(branded),
        );
      }
      // wildcard: the explicit routes above win over the static handler, and assets
      // written after boot are still served. Hashed bundles never change under
      // their name, so browsers may keep them for a year; the shell, worker and
      // manifest must always be revalidated or an update could never land.
      await app.register(fastifyStatic, {
        root: webDist,
        // the plugin's own Cache-Control (max-age=0) would overwrite the one set below
        cacheControl: false,
        setHeaders: (res, path) => {
          res.setHeader("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        },
      });
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.method === "GET" && !req.url.startsWith("/api")) return reply.sendFile("index.html");
        return reply.code(404).send({ error: "not found" });
      });
    }
  }

  return app;
}

async function main() {
  if (process.argv[2] === "totp-setup") {
    process.stdout.write(totpSetupText(process.argv[3] ?? process.env.INSIGHTS_NAME?.trim() ?? "admin"));
    return;
  }
  const mode = parseMode(process.argv.slice(2));
  const app = await buildServer(mode);
  const port = Number(process.env.PORT ?? 8420);
  await app.listen({ port, host: "0.0.0.0" });
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
