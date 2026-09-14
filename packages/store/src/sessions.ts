import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export const SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60_000;
export const SESSION_IDLE_MS = 3 * 24 * 60 * 60_000;
/** last_seen is written at most this often, so a busy dashboard does not write on every request. */
export const SESSION_TOUCH_MS = 60_000;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface SessionRow { created_at: number; last_seen: number; expires_at: number }

/** Server-side admin sessions: random tokens, hashed at rest, idle and absolute expiry. */
export class Sessions {
  constructor(private readonly db: Db) {}

  create(meta: { ip?: string; userAgent?: string }, now = Date.now()): string {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions (id_hash, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hash(token), now, now, now + SESSION_ABSOLUTE_MS, meta.ip ?? null, meta.userAgent?.slice(0, 256) ?? null);
    return token;
  }

  validate(token: string | undefined, now = Date.now()): boolean {
    if (!token || !TOKEN_PATTERN.test(token)) return false;
    const id = hash(token);
    const row = this.db.prepare("SELECT created_at, last_seen, expires_at FROM sessions WHERE id_hash=?").get(id) as SessionRow | undefined;
    if (!row) return false;
    if (now > row.expires_at || now - row.last_seen > SESSION_IDLE_MS) {
      this.db.prepare("DELETE FROM sessions WHERE id_hash=?").run(id);
      return false;
    }
    if (now - row.last_seen >= SESSION_TOUCH_MS) this.db.prepare("UPDATE sessions SET last_seen=? WHERE id_hash=?").run(now, id);
    return true;
  }

  hasLiveSessionFrom(ip: string, now = Date.now()): boolean {
    return this.db
      .prepare("SELECT 1 FROM sessions WHERE ip=? AND expires_at >= ? AND last_seen >= ? LIMIT 1")
      .get(ip, now, now - SESSION_IDLE_MS) != null;
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    this.db.prepare("DELETE FROM sessions WHERE id_hash=?").run(hash(token));
  }

  revokeAll(): number {
    return this.db.prepare("DELETE FROM sessions").run().changes;
  }

  prune(now = Date.now()): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?").run(now, now - SESSION_IDLE_MS).changes;
  }
}
