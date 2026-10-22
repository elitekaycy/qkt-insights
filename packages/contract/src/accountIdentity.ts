import { createHash } from "node:crypto";

/*
 * Venue account identity without the account's credentials. qkt and the collector name an account
 * by an opaque id, never by its login and server:
 *
 *   MT5:     "mt5:" + the first 16 hex characters of sha256("<login>@<server>")
 *   gateway: "vgp:" + the first 16 hex characters of sha256("<adapter>:<account login>")
 *
 * qkt computes the same id (com.qkt.broker.VenueAccountId), so an id qkt states and one derived
 * here from an older release's login and server name the same account. The collector stores only
 * these ids and a masked login ("•••9381"); the raw login and server never reach the database.
 */

const OPAQUE = /^(?:mt5|vgp):[0-9a-f]{16}$/u;
const MASK = "•••";

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** The opaque id of MT5 account `login` on `server`. */
export function mt5AccountId(login: string, server: string): string {
  return `mt5:${digest(`${login}@${server}`)}`;
}

/** The opaque id of gateway account `accountLogin` on `adapter`. */
export function vgpAccountId(adapter: string, accountLogin: string): string {
  return `vgp:${digest(`${adapter}:${accountLogin}`)}`;
}

/** Whether `id` is already an opaque account id. */
export function isOpaqueAccountId(id: string): boolean {
  return OPAQUE.test(id);
}

/**
 * The opaque form of an account id in any form qkt or an operator wrote it: opaque already,
 * `mt5:<login>@<server>`, a bare `<login>@<server>`, or `vgp:<adapter>:<login>`. Any other id (a
 * broker label, `paper:local`, `*`) holds no credentials and is returned as given.
 */
export function opaqueAccountId(id: string): string {
  if (isOpaqueAccountId(id)) return id;
  const mt5 = /^(?:mt5:)?([^:@]+)@(.+)$/u.exec(id);
  if (mt5) return mt5AccountId(mt5[1]!, mt5[2]!);
  const vgp = /^vgp:([^:]+):(.+)$/u.exec(id);
  if (vgp) return vgpAccountId(vgp[1]!, vgp[2]!);
  return id;
}

/** A login with all but its last four characters hidden ("•••9381"); a masked login is returned as given. */
export function maskLogin(login: string): string {
  if (login.startsWith(MASK)) return login;
  return login.length <= 4 ? `${MASK}${login}` : `${MASK}${login.slice(-4)}`;
}

/** Log text with the `login=` / `server=` values and account-mismatch details qkt may write replaced. */
export function redactAccountText(text: string): string {
  if (!/login|server/iu.test(text)) return text;
  return text
    .replace(/\b(login|server)=('[^']*'|"[^"]*"|[^\s,;)]+)/giu, "$1=[redacted]")
    .replace(/\b(account (?:login|server) mismatch):.*$/gimu, "$1: [redacted]");
}

type Json = unknown;

function scrub(value: Json, depth: number, derived?: () => void): Json {
  if (depth > 32 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = scrub(v, depth + 1, derived);
      if (s !== v) changed = true;
      return s;
    });
    return changed ? out : value;
  }
  const obj = value as Record<string, Json>;
  let out: Record<string, Json> | null = null;
  const edit = () => (out ??= { ...obj });
  const login = obj.login;
  const server = obj.server;
  if (typeof obj.accountId === "string") {
    const id = opaqueAccountId(obj.accountId);
    if (id !== obj.accountId) edit().accountId = id;
  } else if (obj.accountId == null && (typeof login === "string" || typeof login === "number") && typeof server === "string" && server !== "" && !String(login).startsWith(MASK)) {
    // An older qkt states no accountId; the id it would have stated, from the login and server.
    edit().accountId = mt5AccountId(String(login), server);
    derived?.();
  }
  if (typeof login === "string" || typeof login === "number") {
    const masked = maskLogin(String(login));
    if (masked !== login) edit().login = masked;
  }
  if ("server" in obj) delete edit().server;
  if (typeof obj.message === "string") {
    const message = redactAccountText(obj.message);
    if (message !== obj.message) edit().message = message;
  }
  for (const [k, v] of Object.entries(out ?? obj)) {
    if (k === "accountId" || k === "login" || k === "message") continue;
    const s = scrub(v, depth + 1, derived);
    if (s !== v) edit()[k] = s;
  }
  return out ?? obj;
}

/**
 * `payload` with every account credential replaced, at any depth: `accountId` in its opaque form
 * (derived from `login` and `server` when an older qkt states none), `login` masked, `server`
 * dropped, and log `message` text redacted. Idempotent; returns `payload` itself when nothing changed.
 * `derived` is called each time an id had to be derived from a login and server.
 */
export function redactAccountIdentity<T>(payload: T, derived?: () => void): T {
  return scrub(payload, 0, derived) as T;
}
