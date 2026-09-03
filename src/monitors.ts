import type { FastifyBaseLogger } from "fastify";
import { listInstances, RETENTION_DAYS, type Db, type MonitorCheck, type MonitorTransition, type Monitors } from "@qkt-insights/store";

/*
 * The uptime loop. Every tick it derives one heartbeat monitor per reporting
 * instance from the collector's own last_seen, probes every declared HTTP
 * target, records the results, and pushes each up/down transition to the
 * configured channels. It runs beside the collector because the collector is
 * what receives the heartbeats; the trading path never waits on it.
 */

export interface HttpMonitor {
  name: string;
  url: string;
  /** Top-level JSON fields the body must carry; any mismatch is a failed check. */
  expect?: Record<string, string | number | boolean>;
}

export interface Channels {
  /** Full Telegram sendMessage URL plus chat id; the bot qkt and the guardian already use. */
  telegram?: { url: string; chatId: string };
  /** Receives the transition as JSON; for Discord/Slack/ntfy/Kuma or anything with a webhook. */
  webhook?: string;
  /** GET on every tick as "insights is alive": healthchecks.io, a Kuma push monitor, etc. */
  deadman?: string;
}

export interface MonitorRunnerDeps {
  db: Db;
  monitors: Monitors;
  http: HttpMonitor[];
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
    const { name, url, expect } = m as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) throw new Error(`INSIGHTS_MONITORS[${i}].name is required`);
    if (typeof url !== "string" || !/^https?:\/\//u.test(url)) throw new Error(`INSIGHTS_MONITORS[${i}].url must be an http(s) URL`);
    if (seen.has(name)) throw new Error(`INSIGHTS_MONITORS has two monitors named ${name}`);
    seen.add(name);
    if (expect == null) return { name, url };
    if (typeof expect !== "object" || Array.isArray(expect)) throw new Error(`INSIGHTS_MONITORS[${i}].expect must be an object`);
    for (const [k, v] of Object.entries(expect as Record<string, unknown>)) {
      if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`INSIGHTS_MONITORS[${i}].expect.${k} must be a string, number or boolean`);
    }
    return { name, url, expect: expect as HttpMonitor["expect"] };
  });
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
    const res = await fetch(m.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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

/** Best effort, in order, every channel tried even if one fails. A dead chat must never stop the loop. */
export async function notify(t: MonitorTransition, deps: MonitorRunnerDeps): Promise<void> {
  const text = formatTransition(t, deps.brand);
  const { telegram, webhook } = deps.channels;
  if (telegram) {
    await post(telegram.url, { chat_id: telegram.chatId, text })
      .catch((e: Error) => deps.log.warn({ err: e.message, monitor: t.name }, "telegram alert failed"));
  }
  if (webhook) {
    await post(webhook, { ...t, brand: deps.brand, text })
      .catch((e: Error) => deps.log.warn({ err: e.message, monitor: t.name }, "webhook alert failed"));
  }
}

export async function tick(deps: MonitorRunnerDeps, now = Date.now()): Promise<MonitorTransition[]> {
  const transitions: MonitorTransition[] = [];
  const names = new Set<string>();
  const push = (t: MonitorTransition | null) => { if (t) transitions.push(t); };

  // An instance silent past the retention window was decommissioned, not lost: its
  // outage has long been announced, so it leaves the monitor list rather than staying red.
  for (const inst of listInstances(deps.db)) {
    const silentMs = now - inst.lastSeen;
    if (silentMs > RETENTION_DAYS * 86_400_000) continue;
    names.add(inst.id);
    push(deps.monitors.record(inst.id, "heartbeat", HEARTBEAT_TARGET,
      { up: silentMs <= HEARTBEAT_STALE_MS, detail: `silent for ${Math.round(silentMs / 1000)}s` }, now));
  }

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
