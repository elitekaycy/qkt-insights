import type { FastifyBaseLogger } from "fastify";
import { listInstances, RETENTION_DAYS, type Db, type MarketDataEpisode, type MarketDataEpisodes, type MonitorCheck, type MonitorTransition, type Monitors } from "@qkt-insights/store";

/*
 * The uptime loop. Every tick it derives one heartbeat monitor per reporting
 * instance from the collector's own last_seen, probes every declared HTTP
 * target, optionally judges each instance's open market-data episodes, records
 * the results, and pushes each up/down transition to the configured channels. It runs beside the collector because the collector is
 * what receives the heartbeats; the trading path never waits on it.
 */

export interface HttpMonitor {
  name: string;
  url: string;
  /** Top-level JSON fields the body must carry; any mismatch is a failed check. */
  expect?: Record<string, string | number | boolean>;
  /** Sent with the probe, e.g. the gateway's bearer key: its /health is behind auth. */
  headers?: Record<string, string>;
}

export interface Channels {
  /** Full Telegram sendMessage URL plus chat id; the bot qkt and the guardian already use. */
  telegram?: { url: string; chatId: string };
  /** Receives the transition as JSON; for Discord/Slack/ntfy/Kuma or anything with a webhook. */
  webhook?: string;
  /** GET on every tick as "insights is alive": healthchecks.io, a Kuma push monitor, etc. */
  deadman?: string;
}

export interface MarketDataMonitor {
  episodes: MarketDataEpisodes;
  /** An episode open longer than this takes the instance's market-data monitor down. */
  alertAfterMs: number;
}

export interface MonitorRunnerDeps {
  db: Db;
  monitors: Monitors;
  http: HttpMonitor[];
  /** Absent unless INSIGHTS_MARKETDATA_MONITOR is on. */
  marketData?: MarketDataMonitor | null;
  channels: Channels;
  /** Prefix on every alert so boxes sharing one chat can be told apart. */
  brand: string | null;
  log: FastifyBaseLogger;
}

/** Three missed 30s pulses, matching the guardian's own healthcheck. */
export const HEARTBEAT_STALE_MS = 90_000;
export const TICK_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

const HEARTBEAT_TARGET = "collector heartbeat";
export const MARKETDATA_ALERT_AFTER_S = 180;

export function marketDataMonitorName(instanceId: string): string {
  return `${instanceId} market data`;
}

export function parseHttpMonitors(json: string | undefined): HttpMonitor[] {
  if (!json?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`INSIGHTS_MONITORS is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("INSIGHTS_MONITORS must be a JSON array");
  const seen = new Set<string>();
  return parsed.map((m, i) => {
    if (typeof m !== "object" || m == null) throw new Error(`INSIGHTS_MONITORS[${i}] must be an object`);
    const { name, url, expect, headers } = m as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) throw new Error(`INSIGHTS_MONITORS[${i}].name is required`);
    if (typeof url !== "string" || !/^https?:\/\//u.test(url)) throw new Error(`INSIGHTS_MONITORS[${i}].url must be an http(s) URL`);
    if (seen.has(name)) throw new Error(`INSIGHTS_MONITORS has two monitors named ${name}`);
    seen.add(name);
    const monitor: HttpMonitor = { name, url };
    if (expect != null) {
      if (typeof expect !== "object" || Array.isArray(expect)) throw new Error(`INSIGHTS_MONITORS[${i}].expect must be an object`);
      for (const [k, v] of Object.entries(expect as Record<string, unknown>)) {
        if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`INSIGHTS_MONITORS[${i}].expect.${k} must be a string, number or boolean`);
      }
      monitor.expect = expect as HttpMonitor["expect"];
    }
    if (headers != null) {
      if (typeof headers !== "object" || Array.isArray(headers)) throw new Error(`INSIGHTS_MONITORS[${i}].headers must be an object`);
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof v !== "string") throw new Error(`INSIGHTS_MONITORS[${i}].headers.${k} must be a string`);
      }
      monitor.headers = headers as HttpMonitor["headers"];
    }
    return monitor;
  });
}

/**
 * Off unless INSIGHTS_MARKETDATA_MONITOR is on: an engine that predates marketdata.recovered
 * never closes an episode, so turning this on for it would page until its next restart.
 */
export function parseMarketDataMonitor(env: NodeJS.ProcessEnv): { alertAfterMs: number } | null {
  const flag = env.INSIGHTS_MARKETDATA_MONITOR?.trim().toLowerCase() ?? "";
  if (["", "0", "false", "off", "no"].includes(flag)) return null;
  if (!["1", "true", "on", "yes"].includes(flag)) {
    throw new Error(`INSIGHTS_MARKETDATA_MONITOR must be 1 or 0, got ${env.INSIGHTS_MARKETDATA_MONITOR}`);
  }
  const raw = env.INSIGHTS_MARKETDATA_ALERT_AFTER_S?.trim();
  const seconds = raw ? Number(raw) : MARKETDATA_ALERT_AFTER_S;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`INSIGHTS_MARKETDATA_ALERT_AFTER_S must be a positive whole number of seconds, got ${raw}`);
  }
  return { alertAfterMs: seconds * 1000 };
}

/** "45s", "12m", "1h05m", "2d03h". */
export function episodeDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

/** The kind when qkt sent one, else read from the reason older engines send. */
function episodeCause(e: MarketDataEpisode): string {
  const reason = e.reason ?? "";
  if (e.kind === "clock_skew" || (e.kind == null && /clock skew/iu.test(reason))) return "clock skew";
  if (e.kind === "outlier" || (e.kind == null && /outlier/iu.test(reason))) return "outliers";
  if (e.kind === "stale" || (e.kind == null && /quote age/iu.test(reason))) return "quote age";
  return e.kind ?? (reason || "stale");
}

/** e.g. "market data stale: PROP_S01:EURUSD 12m (quote age), PROP_S01:XAUUSD 12m (clock skew)". */
export function formatEpisodes(episodes: MarketDataEpisode[], now: number): string {
  return `market data stale: ${episodes.map((e) => `${e.symbol} ${episodeDuration(now - e.since)} (${episodeCause(e)})`).join(", ")}`;
}

export function marketDataCheck(episodes: MarketDataEpisode[], alertAfterMs: number, now: number): MonitorCheck {
  const overdue = episodes.filter((e) => now - e.since > alertAfterMs);
  return overdue.length === 0 ? { up: true } : { up: false, detail: formatEpisodes(overdue, now) };
}

export function channelsFromEnv(env: NodeJS.ProcessEnv): Channels {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return {
    telegram: token && chatId ? { url: `https://api.telegram.org/bot${token}/sendMessage`, chatId } : undefined,
    webhook: env.ALERT_WEBHOOK_URL?.trim() || undefined,
    deadman: env.DEADMAN_URL?.trim() || undefined,
  };
}

export async function probe(m: HttpMonitor): Promise<MonitorCheck> {
  const started = performance.now();
  try {
    const res = await fetch(m.url, { headers: m.headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) return { up: false, latencyMs, detail: `HTTP ${res.status}` };
    if (!m.expect) return { up: true, latencyMs };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { up: false, latencyMs, detail: "body is not JSON" };
    }
    const fields = (typeof body === "object" && body != null ? body : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(m.expect)) {
      if (fields[k] !== v) return { up: false, latencyMs, detail: `${k}=${String(fields[k])}` };
    }
    return { up: true, latencyMs };
  } catch (e) {
    const err = e as Error;
    const detail = err.name === "TimeoutError" ? `no response in ${PROBE_TIMEOUT_MS / 1000}s` : (err.cause as Error | undefined)?.message ?? err.message;
    return { up: false, detail };
  }
}

export function formatTransition(t: MonitorTransition, brand: string | null): string {
  const who = brand ? `${brand} · ${t.name}` : t.name;
  if (t.status === "up") return `${who} is UP`;
  return `${who} is DOWN: ${t.detail ?? "check failed"}`;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Best effort, in order, every channel tried even if one fails. A dead chat must never stop the caller. */
export async function sendAlert(
  text: string,
  fields: Record<string, unknown>,
  deps: Pick<MonitorRunnerDeps, "channels" | "brand" | "log">,
): Promise<void> {
  const { telegram, webhook } = deps.channels;
  if (telegram) {
    await post(telegram.url, { chat_id: telegram.chatId, text })
      .catch((e: Error) => deps.log.warn({ err: e.message, ...fields }, "telegram alert failed"));
  }
  if (webhook) {
    await post(webhook, { ...fields, brand: deps.brand, text })
      .catch((e: Error) => deps.log.warn({ err: e.message, ...fields }, "webhook alert failed"));
  }
}

export async function notify(t: MonitorTransition, deps: MonitorRunnerDeps): Promise<void> {
  await sendAlert(formatTransition(t, deps.brand), { ...t }, deps);
}

/**
 * The sign-in events worth a message. Single failures are left to the log so a guessing run
 * cannot flood the chat; the lockout it trips is announced once.
 */
export function authAlertText(e: { kind: string; ip: string; userAgent?: string; lock?: "ip" | "global" }, brand: string | null): string | null {
  const who = brand ? `${brand} · dashboard` : "dashboard";
  const device = e.userAgent ? ` (${e.userAgent.slice(0, 80)})` : "";
  if (e.kind === "login") return `${who}: new sign-in from ${e.ip}${device}`;
  if (e.kind === "logout-all") return `${who}: every session was signed out from ${e.ip}`;
  if (e.kind === "lockout" && e.lock === "global") return `${who}: sign-in locked for everyone after too many failed attempts (last from ${e.ip})`;
  if (e.kind === "lockout") return `${who}: sign-in locked for ${e.ip} after repeated failed attempts`;
  return null;
}

export async function tick(deps: MonitorRunnerDeps, now = Date.now()): Promise<MonitorTransition[]> {
  const transitions: MonitorTransition[] = [];
  const names = new Set<string>();
  const push = (t: MonitorTransition | null) => { if (t) transitions.push(t); };

  // Silence is measured on the collector's clock (heard_at), never the instance's: a VPS
  // with a skewed clock must not read as dead. An instance silent past the retention
  // window was decommissioned, not lost: its outage has long been announced, so it leaves
  // the monitor list rather than staying red.
  //
  // Market-data episodes are aged on the instance's clock (the stale report's own ts): the
  // collector cannot know when the quotes really went stale, only when qkt said so.
  const md = deps.marketData;
  const monitored = new Set<string>();
  for (const inst of listInstances(deps.db)) {
    const silentMs = now - (inst.heardAt ?? inst.lastSeen);
    if (silentMs > RETENTION_DAYS * 86_400_000) continue;
    names.add(inst.id);
    push(deps.monitors.record(inst.id, "heartbeat", HEARTBEAT_TARGET,
      { up: silentMs <= HEARTBEAT_STALE_MS, detail: `silent for ${Math.round(silentMs / 1000)}s` }, now));
    if (md) {
      const name = marketDataMonitorName(inst.id);
      names.add(name);
      monitored.add(inst.id);
      push(deps.monitors.record(name, "marketdata", `quote health · alert after ${md.alertAfterMs / 1000}s`,
        marketDataCheck(md.episodes.open(inst.id), md.alertAfterMs, now), now));
    }
  }
  md?.episodes.retain(monitored);

  const checks = await Promise.all(deps.http.map(probe));
  deps.http.forEach((m, i) => {
    names.add(m.name);
    push(deps.monitors.record(m.name, "http", m.url, checks[i]!, now));
  });
  deps.monitors.retain(names);

  for (const t of transitions) {
    deps.log.info({ monitor: t.name, status: t.status, detail: t.detail }, "monitor transition");
    await notify(t, deps);
  }

  if (deps.channels.deadman) {
    await fetch(deps.channels.deadman, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
      .catch((e: Error) => deps.log.warn({ err: e.message }, "deadman ping failed"));
  }
  return transitions;
}

/** Ticks immediately, then every intervalMs; the timer is unref'd. Returns the stop function. */
export function startMonitors(deps: MonitorRunnerDeps, intervalMs = TICK_MS): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    tick(deps)
      .catch((e: Error) => deps.log.error({ err: e.message }, "monitor tick failed"))
      .finally(() => { running = false; });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
