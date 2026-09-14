import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  accountDrawdown, accountEquity, closedTrades, fullyClosedPositions, listDeals, listStrategyRoster, listTrades, openPositionsAt, portfolioGroupOf,
  resolveVisibility, strategyEquityCurve, strategyStats, type Db, type LiveStateStore, type ShareKind, type ShareRow, type Shares, type StrategyRow,
} from "@qkt-insights/store";
import { isSameOrigin, requireSession } from "./auth.js";
import type { TtlCache } from "./cache.js";
import { WindowCounter } from "./limits.js";
import { performanceBundle } from "./performance.js";
import { accountLabeller, publicBundle, publicDeal, publicStrategy, publicTrade } from "./publicView.js";

export const PUBLIC_REQUESTS_PER_MINUTE = 240;
/** Uncached public computations allowed per minute for one link, and for one client IP. */
export const PUBLIC_COMPUTE_PER_MINUTE = 120;
export const PUBLIC_COMPUTE_PER_IP_PER_MINUTE = 60;
/** Milliseconds of computation per minute for one link, and for one client IP. */
export const PUBLIC_COMPUTE_MS_PER_MINUTE = 30_000;
export const PUBLIC_COMPUTE_MS_PER_IP_PER_MINUTE = 15_000;
const SCOPE_KEY = "public-scope:";

/**
 * Makes every link re-resolve what it covers. Cached answers are keyed by the scope they were
 * computed for, so a link whose scope changed can never be served its old answers, fresh or
 * stale, while links whose scope did not change keep theirs.
 */
export function invalidateShareScopes(cache: TtlCache): void {
  cache.deletePrefix(SCOPE_KEY);
}
const DAY_MS = 86_400_000;

export interface SharesDeps {
  db: Db;
  shares: Shares;
  /** Shared with the public routes; cleared on every change so a revoked link dies at once. */
  cache: TtlCache;
}

interface ShareState { visibility: "public" | "private" | null; effective: boolean; token: string | null }

function isEffective(vis: ReturnType<typeof resolveVisibility>, row: Pick<ShareRow, "kind" | "subject">): boolean {
  if (row.kind === "overview") return vis.overview;
  return (row.kind === "portfolio" ? vis.portfolios : vis.strategies).get(row.subject) === true;
}

/**
 * Replaces every handed-out link whose subject is no longer public, however that happened: an
 * admin toggle, an inherited setting, or deploy metadata moving a strategy into a private
 * portfolio. A revoked link stays dead even if its subject becomes public again.
 */
export function revokeHiddenShares(db: Db, shares: Shares, instanceId: string): number {
  const exposed = shares.exposed(instanceId);
  if (exposed.length === 0) return 0;
  const vis = resolveVisibility(shares.list(instanceId), listStrategyRoster(db, instanceId));
  let revoked = 0;
  for (const row of exposed) {
    if (!isEffective(vis, row)) {
      shares.rotate(instanceId, row.kind, row.subject);
      revoked++;
    }
  }
  return revoked;
}

/** revokeHiddenShares across every instance with a handed-out link; the server runs it on a timer. */
export function sweepHiddenShares(db: Db, shares: Shares): number {
  return shares.instancesWithExposedLinks().reduce((n, id) => n + revokeHiddenShares(db, shares, id), 0);
}

function sharesView(db: Db, shares: Shares, instanceId: string) {
  revokeHiddenShares(db, shares, instanceId);
  const roster = listStrategyRoster(db, instanceId);
  const rows = shares.list(instanceId);
  const vis = resolveVisibility(rows, roster);
  const state = (kind: ShareKind, subject: string, effective: boolean): ShareState => ({
    visibility: rows.find((r) => r.kind === kind && r.subject === subject)?.visibility ?? null,
    effective,
    // A link exists only for what is public now; a private subject hands out no token.
    token: effective ? shares.expose(instanceId, kind, subject) : null,
  });
  return {
    overview: state("overview", "", vis.overview),
    portfolios: [...vis.portfolios.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, effective]) => ({ id, ...state("portfolio", id, effective) })),
    strategies: roster.map((s) => ({ id: s.strategyId, ...state("strategy", s.strategyId, vis.strategies.get(s.strategyId) ?? false) })),
  };
}

const ShareSubject = {
  type: "object",
  required: ["instance", "kind", "subject"],
  additionalProperties: false,
  properties: {
    instance: { type: "string", minLength: 1, maxLength: 256 },
    kind: { type: "string", enum: ["overview", "portfolio", "strategy"] },
    subject: { type: "string", maxLength: 256 },
    visibility: { type: ["string", "null"], enum: ["public", "private", null] },
  },
} as const;

interface ShareBody { instance: string; kind: ShareKind; subject: string; visibility?: "public" | "private" | null }

/** True when the subject names something that exists on the instance. */
function subjectExists(db: Db, body: ShareBody): boolean {
  const roster = listStrategyRoster(db, body.instance);
  if (body.kind === "overview") {
    return body.subject === "" && (roster.length > 0 || db.prepare("SELECT 1 FROM instances WHERE id=?").get(body.instance) != null);
  }
  if (body.kind === "strategy") return roster.some((s) => s.strategyId === body.subject);
  return roster.some((s) => portfolioGroupOf(s.metadata) === body.subject);
}

export function registerShares(app: FastifyInstance, deps: SharesDeps): void {
  const guard = { preHandler: requireSession };

  app.get<{ Querystring: { instance?: string } }>("/shares", guard, async (req, reply) => {
    if (!req.query.instance) return reply.code(400).send({ error: "instance required" });
    return sharesView(deps.db, deps.shares, req.query.instance);
  });

  const mutate = (apply: (body: ShareBody) => void) => async (req: FastifyRequest<{ Body: ShareBody }>, reply: FastifyReply) => {
    if (!isSameOrigin(req)) return reply.code(403).send({ error: "cross-origin request refused" });
    if (!subjectExists(deps.db, req.body)) return reply.code(404).send({ error: "no such subject" });
    apply(req.body);
    // Links that stopped being public, including those public only through inheritance, are
    // replaced before the view is built.
    revokeHiddenShares(deps.db, deps.shares, req.body.instance);
    invalidateShareScopes(deps.cache);
    return sharesView(deps.db, deps.shares, req.body.instance);
  };

  app.put<{ Body: ShareBody }>("/shares", { ...guard, schema: { body: { ...ShareSubject, required: [...ShareSubject.required, "visibility"] } } }, mutate((b) => {
    // The overview has nothing to inherit from: clearing it means private.
    const visibility = b.kind === "overview" && b.visibility == null ? "private" : b.visibility ?? null;
    deps.shares.set(b.instance, b.kind, b.subject, visibility);
  }));

  app.post<{ Body: ShareBody }>("/shares/rotate", { ...guard, schema: { body: ShareSubject } }, mutate((b) => {
    deps.shares.rotate(b.instance, b.kind, b.subject);
  }));
}

export interface PublicDeps {
  db: Db;
  liveState: LiveStateStore;
  shares: Shares;
  cache: TtlCache;
  /** How far behind now every public figure is cut off. */
  delayMs: number;
  now?: () => number;
  requestsPerMinute?: number;
  /** Uncached computations per minute for one link; the same budget per client IP is PUBLIC_COMPUTE_PER_IP_PER_MINUTE. */
  computeBudgetPerMinute?: number;
  /** Milliseconds of computation per minute for one link. */
  computeMsPerMinute?: number;
}

interface Scope {
  /** What the link covers, as a cache key component: answers for another scope never match. */
  fingerprint: string;
  share: ShareRow;
  instanceId: string;
  strategies: StrategyRow[];
  allowed: Set<string>;
  /** Account balance, equity, drawdown and open P&L belong to the whole account: overview links only. */
  accountLevel: boolean;
}

function resolveScope(db: Db, shares: Shares, share: ShareRow, cutoff: number): Scope | null {
  const roster = listStrategyRoster(db, share.instanceId);
  const vis = resolveVisibility(shares.list(share.instanceId), roster);
  // A strategy first seen inside the delay window is not public yet.
  const isPublic = (s: StrategyRow) => vis.strategies.get(s.strategyId) === true && s.firstSeen <= cutoff;
  let strategies: StrategyRow[];
  if (share.kind === "overview") {
    if (!vis.overview) return null;
    strategies = roster.filter((s) => s.active && isPublic(s));
  } else if (share.kind === "portfolio") {
    if (vis.portfolios.get(share.subject) !== true) return null;
    strategies = roster.filter((s) => s.active && portfolioGroupOf(s.metadata) === share.subject && isPublic(s));
  } else {
    const row = roster.find((s) => s.strategyId === share.subject);
    if (!row || vis.strategies.get(row.strategyId) !== true) return null;
    strategies = isPublic(row) ? [row] : [];
  }
  const allowed = new Set(strategies.map((s) => s.strategyId));
  const fingerprint = createHash("sha256").update(JSON.stringify([share.kind, share.subject, [...allowed].sort()])).digest("hex").slice(0, 16);
  return { fingerprint, share, instanceId: share.instanceId, strategies, allowed, accountLevel: share.kind === "overview" };
}

type Query = Record<string, unknown>;

/** Only single string values count; a repeated parameter arrives as an array and is ignored. */
function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The range presets the dashboard offers. A requested `from` snaps to the nearest one, so every
 * viewer and every drifting `Date.now() - range` shares a single cache entry per preset.
 */
const RANGE_PRESETS: Array<[string, number]> = [["24h", DAY_MS], ["7d", 7 * DAY_MS], ["30d", 30 * DAY_MS]];

function rangePreset(v: unknown, cutoff: number): string {
  const from = Number(text(v));
  if (!Number.isFinite(from) || from <= 0) return "all";
  const age = cutoff - from;
  if (age > 60 * DAY_MS) return "all";
  let best = RANGE_PRESETS[0]!;
  for (const preset of RANGE_PRESETS) if (Math.abs(age - preset[1]) < Math.abs(age - best[1])) best = preset;
  return best[0];
}

function presetFrom(preset: string, cutoff: number): number | undefined {
  const ms = RANGE_PRESETS.find(([key]) => key === preset)?.[1];
  return ms == null ? undefined : cutoff - ms;
}

function snap(v: unknown, choices: number[], fallback: number): number {
  const n = Number(text(v));
  if (!Number.isFinite(n)) return fallback;
  return choices.reduce((best, c) => (Math.abs(n - c) < Math.abs(n - best) ? c : best), choices[0]!);
}

const INCLUDABLE = new Set(["report", "dailyNets", "drawdownPeriods", "postLoss", "breakdowns", "closes", "dowHour", "rolling", "costs", "contribution", "normalized", "excursions"]);

const NOT_FOUND = Symbol("not found");

interface Route<P> {
  /** Reduces the query to the few values that change the answer; they alone form the cache key. */
  params: (q: Query, scope: Scope, cutoff: number) => P | typeof NOT_FOUND;
  compute: (scope: Scope, p: P, cutoff: number) => unknown;
  /** Shapes the cached answer per request without recomputing it (e.g. picking included keys). */
  present?: (value: unknown, q: Query) => unknown;
  /** Cheap enough to skip the compute budget, so a busy link still says what it is. */
  free?: boolean;
}

export function registerPublic(app: FastifyInstance, deps: PublicDeps): void {
  const now = deps.now ?? Date.now;
  const budget = new WindowCounter(deps.requestsPerMinute ?? PUBLIC_REQUESTS_PER_MINUTE, 60_000);
  const perLink = new WindowCounter(deps.computeBudgetPerMinute ?? PUBLIC_COMPUTE_PER_MINUTE, 60_000);
  const perIp = new WindowCounter(PUBLIC_COMPUTE_PER_IP_PER_MINUTE, 60_000);
  const linkMsLimit = deps.computeMsPerMinute ?? PUBLIC_COMPUTE_MS_PER_MINUTE;
  const perLinkMs = new WindowCounter(linkMsLimit, 60_000);
  const perIpMs = new WindowCounter(PUBLIC_COMPUTE_MS_PER_IP_PER_MINUTE, 60_000);
  const sweep = setInterval(() => { budget.sweep(); perLink.sweep(); perIp.sweep(); perLinkMs.sweep(); perIpMs.sweep(); }, 60_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  const route = <P>(path: string, r: Route<P>) => {
    app.get<{ Params: { token: string }; Querystring: Query }>(`/public/:token${path}`, async (req, reply) => {
      reply.header("x-robots-tag", "noindex, nofollow");
      if (!budget.hit(req.ip)) {
        return reply.code(429).header("retry-after", Math.max(1, Math.ceil(budget.retryAfterMs(req.ip) / 1000))).send({ error: "too many requests" });
      }
      const share = deps.shares.byToken(req.params.token);
      if (!share) return reply.code(404).send({ error: "not found" });
      const cutoff = now() - deps.delayMs;
      const scope = await deps.cache.get(`${SCOPE_KEY}${share.token}`, () => resolveScope(deps.db, deps.shares, share, cutoff));
      if (!scope) {
        if (revokeHiddenShares(deps.db, deps.shares, share.instanceId) > 0) invalidateShareScopes(deps.cache);
        return reply.code(404).send({ error: "not found" });
      }
      const p = r.params(req.query, scope, cutoff);
      if (p === NOT_FOUND) return reply.code(404).send({ error: "not found" });
      const key = `public:${share.token}:${scope.fingerprint}:${path}:${JSON.stringify(p)}`;
      let value = deps.cache.peek<unknown>(key);
      if (value === undefined) {
        // Budgets are per link and per client, so one busy viewer cannot starve other links.
        // Requests and time are both bounded: a single computation on a large instance can take long.
        const affordable = r.free || (
          perLink.count(share.token) < (deps.computeBudgetPerMinute ?? PUBLIC_COMPUTE_PER_MINUTE) && perIp.count(req.ip) < PUBLIC_COMPUTE_PER_IP_PER_MINUTE
          && perLinkMs.count(share.token) < linkMsLimit && perIpMs.count(req.ip) < PUBLIC_COMPUTE_MS_PER_IP_PER_MINUTE);
        if (!affordable) {
          const stale = deps.cache.peekStale<unknown>(key);
          if (stale === undefined) {
            const wait = Math.max(perLink.retryAfterMs(share.token), perIp.retryAfterMs(req.ip), perLinkMs.retryAfterMs(share.token), perIpMs.retryAfterMs(req.ip));
            return reply.code(503).header("retry-after", Math.max(1, Math.ceil(wait / 1000))).send({ error: "busy, try again shortly" });
          }
          value = stale;
        } else {
          if (!r.free) {
            perLink.hit(share.token);
            perIp.hit(req.ip);
          }
          const started = performance.now();
          value = await deps.cache.get(key, () => r.compute(scope, p, cutoff));
          if (!r.free) {
            const spent = performance.now() - started;
            perLinkMs.add(share.token, spent);
            perIpMs.add(req.ip, spent);
          }
        }
      }
      return reply.send(r.present ? r.present(value, req.query) : value);
    });
  };

  const strategyOf = (q: Query, scope: Scope): string | typeof NOT_FOUND => {
    const id = text(q.strategy);
    return id != null && scope.allowed.has(id) ? id : NOT_FOUND;
  };
  const optionalStrategy = (q: Query, scope: Scope): { strategy: string | null } | typeof NOT_FOUND => {
    if (q.strategy === undefined) return { strategy: null };
    const id = strategyOf(q, scope);
    return id === NOT_FOUND ? NOT_FOUND : { strategy: id };
  };
  /** Every close-derived figure on a public link excludes positions still open at the cutoff. */
  const strict = (scope: Scope, strategyId: string, cutoff: number, from?: number) =>
    ({ instanceId: scope.instanceId, strategyId, from, to: cutoff, closedPositionsOnly: true }) as const;

  route("/meta", {
    free: true,
    params: () => ({}),
    compute: (scope, _p, cutoff) => ({ kind: scope.share.kind, instanceId: scope.instanceId, subject: scope.share.subject, delayMinutes: Math.round(deps.delayMs / 60_000), asOf: cutoff }),
  });

  route("/strategies", {
    params: () => ({}),
    compute: (scope, _p, cutoff) => scope.strategies.map((s) => publicStrategy(s, closedTrades(deps.db, strict(scope, s.strategyId, cutoff)), cutoff)),
  });

  route("/stats", {
    params: (q, scope) => { const id = strategyOf(q, scope); return id === NOT_FOUND ? NOT_FOUND : { strategy: id }; },
    compute: (scope, p, cutoff) => {
      const f = strict(scope, p.strategy, cutoff);
      const closes = closedTrades(deps.db, f);
      const stats = strategyStats(deps.db, f, cutoff);
      // Engine fill counts and snapshot equity would include positions still open at the cutoff.
      if (closes.length === 0) {
        return { ...stats, tradeCount: 0, buyCount: 0, sellCount: 0, volume: 0, realizedPnl: null, equity: null, returnPct: null, winRate: null, maxDrawdownPct: null, sharpe: null };
      }
      return {
        ...stats, tradeCount: closes.length, buyCount: closes.filter((c) => c.side === "BUY").length,
        sellCount: closes.filter((c) => c.side === "SELL").length, volume: closes.reduce((a, c) => a + Math.abs(c.qty), 0),
      };
    },
  });

  // Rebuilt from closed positions only: snapshot equity would carry unrealized P&L.
  route("/equity", {
    params: (q, scope, cutoff) => { const id = strategyOf(q, scope); return id === NOT_FOUND ? NOT_FOUND : { strategy: id, range: rangePreset(q.from, cutoff) }; },
    compute: (scope, p, cutoff) => strategyEquityCurve(deps.db, strict(scope, p.strategy, cutoff, presetFrom(p.range, cutoff))),
  });

  route("/performance", {
    params: (q, scope, cutoff) => {
      const id = strategyOf(q, scope);
      return id === NOT_FOUND ? NOT_FOUND : { strategy: id, range: rangePreset(q.from, cutoff), window: snap(q.window, [30, 60, 90], 30) };
    },
    compute: (scope, p, cutoff) => publicBundle(performanceBundle(deps.db, strict(scope, p.strategy, cutoff, presetFrom(p.range, cutoff)), undefined, String(p.window))),
    present: (value, q) => {
      const include = text(q.include);
      if (!include) return value;
      const wanted = new Set(include.split(",").filter((k) => INCLUDABLE.has(k)));
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => wanted.has(k)));
    },
  });

  // Only fills of positions closed by the cutoff: an entry fill of a position still open then would reveal it.
  route("/trades", {
    params: (q, scope) => { const s = optionalStrategy(q, scope); return s === NOT_FOUND ? NOT_FOUND : { ...s, limit: snap(q.limit, [100, 500, 1000], 500) }; },
    compute: (scope, p, cutoff) => {
      const ids = p.strategy ? [p.strategy] : [...scope.allowed];
      const closedOrders = new Set<string>();
      for (const id of ids) {
        for (const c of closedTrades(deps.db, strict(scope, id, cutoff)) as Array<{ orderId: string | null; entryOrderId?: string | null; exitOrderId?: string | null }>) {
          for (const orderId of [c.orderId, c.entryOrderId, c.exitOrderId]) if (orderId) closedOrders.add(orderId);
        }
      }
      return listTrades(deps.db, { instanceId: scope.instanceId, strategyId: p.strategy ?? undefined, limit: p.limit * 5, to: cutoff })
        .filter((t) => t.strategyId != null && scope.allowed.has(t.strategyId) && closedOrders.has((t.payload as { orderId?: string }).orderId ?? ""))
        .slice(0, p.limit)
        .map(publicTrade);
    },
  });

  route("/deals", {
    params: (q, scope) => { const s = optionalStrategy(q, scope); return s === NOT_FOUND ? NOT_FOUND : { ...s, limit: snap(q.limit, [100, 500, 1000], 500) }; },
    compute: (scope, p, cutoff) => {
      const closed = fullyClosedPositions(deps.db, { instanceId: scope.instanceId, to: cutoff });
      return listDeals(deps.db, { instanceId: scope.instanceId, strategyId: p.strategy ?? undefined, limit: p.limit * 5, before: cutoff + 1 })
        .filter((d) => d.strategyId != null && scope.allowed.has(d.strategyId) && d.positionTicket != null && closed.has(d.positionTicket))
        .slice(0, p.limit)
        .map(publicDeal);
    },
  });

  route("/live/state", {
    params: () => ({}),
    compute: (scope, _p, cutoff) => {
      if (!scope.accountLevel) return { accounts: [], positions: [], orders: [] };
      const label = accountLabeller();
      const currency = deps.liveState.snapshot(now()).accounts.find((a) => a.instanceId === scope.instanceId)?.currency ?? "USD";
      const latest = new Map<string, { minuteTs: number; balance: number | null; equity: number | null; openProfit: number | null }>();
      for (const p of accountEquity(deps.db, { instanceId: scope.instanceId, from: cutoff - DAY_MS, to: cutoff })) latest.set(p.broker, p);
      const accounts = [...latest.entries()].map(([broker, p]) => ({
        instanceId: scope.instanceId, broker: label(broker), currency, balance: p.balance ?? 0, equity: p.equity ?? 0,
        openProfit: p.openProfit ?? 0, lastSeen: p.minuteTs, stale: false,
      }));
      // A count and a total at the cutoff only: any per-position or per-strategy figure moves with
      // price across polls and reveals direction and size.
      const open = openPositionsAt(deps.db, { instanceId: scope.instanceId, at: cutoff }).filter((p) => p.strategyId != null && scope.allowed.has(p.strategyId));
      // With a single open position the total would be that position's own P&L.
      const unrealized = open.length >= 2 ? open.reduce((a, p) => a + (p.profit ?? 0), 0) : null;
      return { accounts, positions: [], orders: [], openPositions: { count: open.length, unrealized } };
    },
  });

  route("/account/equity", {
    params: (q, scope, cutoff) => (scope.accountLevel ? { range: rangePreset(q.from, cutoff) } : NOT_FOUND),
    compute: (scope, p, cutoff) => {
      const label = accountLabeller();
      return accountEquity(deps.db, { instanceId: scope.instanceId, from: presetFrom(p.range, cutoff), to: cutoff }).map((row) => ({ ...row, broker: label(row.broker) }));
    },
  });

  route("/account/drawdown", {
    params: (_q, scope) => (scope.accountLevel ? {} : NOT_FOUND),
    compute: (scope, _p, cutoff) => {
      const label = accountLabeller();
      return accountDrawdown(deps.db, { instanceId: scope.instanceId, to: cutoff }).map((row) => ({ ...row, broker: label(row.broker) }));
    },
  });
}
