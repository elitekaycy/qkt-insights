import { digitsFrom } from "@qkt-insights/contract/prices";
import { mt5AccountId, redactAccountIdentity } from "@qkt-insights/contract/accountIdentity";
import type { Db } from "./db.js";
import { statement } from "./statements.js";

/*
 * Facts the collector infers from MT5 conventions, for envelopes that do not state them. qkt states
 * each of these explicitly since the release that sends `venue`/`accountId` and the fill facts
 * (`positionId`, `closeReason`, `attribution`, `instrument`, `riskAmount`); an envelope that carries
 * the explicit fact never reaches the function here that infers it. What remains are producers older
 * than that release, so this module can be deleted once none of them reports any more.
 *
 * Every inference counts its use (inferenceCounts, onInference), so a deployment can tell whether
 * anything still depends on it.
 */

/** One kind of inference, named after the convention it relies on. */
export type Inference =
  | "deal-comment-strategy"
  | "deal-comment-ended"
  | "engine-events-ended"
  | "ticket-entry-order"
  | "login-server-account"
  | "profile-label"
  | "price-digits";

const counts = new Map<Inference, number>();
const listeners = new Set<(kind: Inference, count: number) => void>();

function used(kind: Inference): void {
  const n = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, n);
  for (const l of listeners) l(kind, n);
}

/** How often each inference ran in this process. */
export function inferenceCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

/** Calls `listener` on every inference with its running count; returns the unsubscribe. */
export function onInference(listener: (kind: Inference, count: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The strategy a `dsl-<strategy>` deal comment names, prefix-matched against the instance's
 * strategies in both directions (MT5 truncates comments to 31 characters); only a unique match wins.
 * For a deal that states no `attribution`.
 */
export function strategyFromDealComment(db: Db, instanceId: string, comment: string | null): string | null {
  if (comment == null || !comment.startsWith("dsl-") || comment.length <= 4) return null;
  used("deal-comment-strategy");
  const tag = comment.slice(4);
  const matches = (statement(db, "SELECT strategy_id s FROM strategies WHERE instance_id=?").all(instanceId) as { s: string }[])
    .map((r) => r.s)
    .filter((s) => s.startsWith(tag) || tag.startsWith(s));
  return matches.length === 1 ? matches[0]! : null;
}

/** How the round trip ended, as the projection names it. */
export type Ended = "stop" | "tp" | "so" | "manual" | "signal";

/** MT5 rewrites the comment of a deal its stop, target or stop-out closed: "[sl 4120.0]", "[tp ...]", "[so ...]". */
export function endedFromDealComment(comment: string | null): Ended | null {
  const c = (comment ?? "").toLowerCase();
  const ended = c.startsWith("[sl") ? "stop" : c.startsWith("[tp") ? "tp" : c.startsWith("[so") ? "so" : null;
  if (ended) used("deal-comment-ended");
  return ended;
}

/** Engine events near a timestamp, by type: what the round-trip reducer reads them through. */
export type EventsNear = (type: string, ts: number) => Array<Record<string, unknown>>;

/**
 * Who closed a position, from the engine events around its last close: a `qkt bot close` of the
 * ticket is a person, an engine order closing the ticket is the strategy. Nothing found: what an
 * earlier read said (the events age out), else null.
 */
export function endedFromEngineEvents(near: EventsNear, position: string, ts: number, prior: string | null): Ended | null {
  used("engine-events-ended");
  if (near("bot.close", ts).some((p) => p.ticket === position)) return "manual";
  if (near("order.submit", ts).some((p) => p.closesTicket === position)) return "signal";
  return prior === "manual" || prior === "signal" ? prior : null;
}

/**
 * The engine order that opened a position, by the MT5 convention that an order's broker id is the
 * venue ticket its entry deal carries. The orders table maps the ticket to the order id; when it
 * does not (the accept never reached that row, or the id belongs to another run), the
 * `order.accepted` near the entry that carries the ticket names it. An order id repeats across
 * engine restarts, so only the submit near the entry is its own.
 */
export function entryOrderByTicket(db: Db, instanceId: string, ticket: string | null, entryTs: number | null, near: EventsNear):
  { orderId: string | null; submit: Record<string, unknown> | undefined } {
  if (ticket == null) return { orderId: null, submit: undefined };
  used("ticket-entry-order");
  const stored = (statement(db,
    "SELECT order_id o FROM orders WHERE instance_id=? AND broker_order_id=? ORDER BY created_ts ASC LIMIT 1",
  ).get(instanceId, ticket) as { o: string } | undefined)?.o ?? null;
  if (entryTs == null) return { orderId: stored, submit: undefined };
  const submits = near("order.submit", entryTs);
  const submitOf = (id: string | null) => (id == null ? undefined : submits.find((p) => p.orderId === id));
  const own = submitOf(stored);
  if (own) return { orderId: stored, submit: own };
  const accepted = near("order.accepted", entryTs)
    .find((p) => p.brokerOrderId != null && String(p.brokerOrderId) === ticket && typeof p.orderId === "string");
  const acceptedId = (accepted?.orderId as string | undefined) ?? null;
  const viaAccept = submitOf(acceptedId);
  return viaAccept ? { orderId: acceptedId, submit: viaAccept } : { orderId: stored ?? acceptedId, submit: undefined };
}

/**
 * The account id of an account state that states no `accountId`. Only MT5 reported account state
 * before qkt stated the id, so its login and server are an MT5 account, named the way qkt names it
 * (the opaque `mt5:` id, contract accountIdentity.ts).
 */
export function accountIdFromLogin(login: string | undefined, server: string | undefined): string | null {
  if (!login || !server) return null;
  used("login-server-account");
  return mt5AccountId(login, server);
}

/**
 * `payload` with its account credentials replaced (contract redactAccountIdentity): what the
 * collector keeps, stores and pushes. An id derived from an older qkt's login and server counts
 * as the login-server inference.
 */
export function withoutAccountCredentials<T>(payload: T): T {
  return redactAccountIdentity(payload, () => used("login-server-account"));
}

/** The broker label of a per-profile copy without its profile suffix: "ICM_S05" -> "ICM". */
export function profileLabel(broker: string): string {
  const label = broker.replace(/_S\d+$/u, "");
  if (label !== broker) used("profile-label");
  return label;
}

/** An instrument's price precision read from its prices and its name, when the venue states no tick size. */
export function digitsFromPrices(prices: readonly number[], instrument: string): number {
  used("price-digits");
  return digitsFrom(prices, instrument);
}

/**
 * SQL: the account money one point of a round trip `t` was worth, inferred from the venue's gross
 * over the price move (both must agree on direction). For a round trip whose entry stated no risk.
 */
export const INFERRED_POINT_VALUE = `(CASE WHEN t.entry_price IS NOT NULL AND t.exit_price IS NOT NULL
    AND (CASE t.side WHEN 'long' THEN t.exit_price - t.entry_price ELSE t.entry_price - t.exit_price END) <> 0
    AND t.gross / (CASE t.side WHEN 'long' THEN t.exit_price - t.entry_price ELSE t.entry_price - t.exit_price END) > 0
  THEN t.gross / (CASE t.side WHEN 'long' THEN t.exit_price - t.entry_price ELSE t.entry_price - t.exit_price END) END)`;
