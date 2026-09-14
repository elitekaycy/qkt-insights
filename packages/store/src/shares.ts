import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export type ShareKind = "overview" | "portfolio" | "strategy";
export type Visibility = "public" | "private";

export interface ShareRow {
  instanceId: string;
  kind: ShareKind;
  /** "" for the overview, the portfolio group id, or the strategy id. */
  subject: string;
  /** null = inherit from the enclosing scope. */
  visibility: Visibility | null;
  token: string;
}

const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** qkt-forge shards one logical book as book, book_2, book_3; the dashboard groups them as one portfolio. */
export function portfolioGroupOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const id = metadata?.portfolioId;
  return typeof id === "string" && id.length > 0 ? id.replace(/_\d+$/u, "") : null;
}

export interface ResolvedVisibility {
  overview: boolean;
  portfolios: Map<string, boolean>;
  strategies: Map<string, boolean>;
}

/**
 * Effective visibility: a strategy's own setting, else its portfolio's, else the overview's;
 * private when nothing is set. A portfolio is its own setting, else the overview's.
 */
export function resolveVisibility(
  rows: ShareRow[],
  strategies: Array<{ strategyId: string; metadata: Record<string, unknown> | null }>,
): ResolvedVisibility {
  const explicit = (kind: ShareKind, subject: string) => rows.find((r) => r.kind === kind && r.subject === subject)?.visibility ?? null;
  const overview = explicit("overview", "") === "public";
  const portfolios = new Map<string, boolean>();
  const out = new Map<string, boolean>();
  for (const s of strategies) {
    const group = portfolioGroupOf(s.metadata);
    let portfolioPublic: boolean | null = null;
    if (group != null) {
      const own = explicit("portfolio", group);
      portfolioPublic = own == null ? overview : own === "public";
      portfolios.set(group, portfolioPublic);
    }
    const own = explicit("strategy", s.strategyId);
    out.set(s.strategyId, own != null ? own === "public" : portfolioPublic ?? overview);
  }
  return { overview, portfolios, strategies: out };
}

interface DbShareRow { instance_id: string; kind: ShareKind; subject: string; visibility: Visibility | null; token: string; exposed: number }

function fromDb(r: DbShareRow): ShareRow {
  return { instanceId: r.instance_id, kind: r.kind, subject: r.subject, visibility: r.visibility, token: r.token };
}

export class Shares {
  constructor(private readonly db: Db) {}

  list(instanceId: string): ShareRow[] {
    return (this.db.prepare("SELECT * FROM shares WHERE instance_id=?").all(instanceId) as DbShareRow[]).map(fromDb);
  }

  /** Sets or clears (null) the explicit visibility; the subject's token is created if missing and kept. */
  set(instanceId: string, kind: ShareKind, subject: string, visibility: Visibility | null, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO shares (instance_id, kind, subject, visibility, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (instance_id, kind, subject) DO UPDATE SET visibility=excluded.visibility, updated_at=excluded.updated_at`,
      )
      .run(instanceId, kind, subject, visibility, newToken(), now, now);
  }

  ensureToken(instanceId: string, kind: ShareKind, subject: string, now = Date.now()): string {
    this.db
      .prepare("INSERT OR IGNORE INTO shares (instance_id, kind, subject, visibility, token, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)")
      .run(instanceId, kind, subject, newToken(), now, now);
    return (this.db.prepare("SELECT token FROM shares WHERE instance_id=? AND kind=? AND subject=?").get(instanceId, kind, subject) as { token: string }).token;
  }

  /** The subject's token, marked as handed out: from now on it is revoked if the subject stops being public. */
  expose(instanceId: string, kind: ShareKind, subject: string, now = Date.now()): string {
    const token = this.ensureToken(instanceId, kind, subject, now);
    this.db.prepare("UPDATE shares SET exposed=1 WHERE instance_id=? AND kind=? AND subject=? AND exposed=0").run(instanceId, kind, subject);
    return token;
  }

  /** Subjects on the instance whose current token has been handed out. */
  exposed(instanceId: string): ShareRow[] {
    return (this.db.prepare("SELECT * FROM shares WHERE instance_id=? AND exposed=1").all(instanceId) as DbShareRow[]).map(fromDb);
  }

  instancesWithExposedLinks(): string[] {
    return (this.db.prepare("SELECT DISTINCT instance_id id FROM shares WHERE exposed=1").all() as Array<{ id: string }>).map((r) => r.id);
  }

  /** Replaces the subject's token; the previous link stops resolving at once and nothing is exposed yet. */
  rotate(instanceId: string, kind: ShareKind, subject: string, now = Date.now()): string {
    this.ensureToken(instanceId, kind, subject, now);
    const token = newToken();
    this.db.prepare("UPDATE shares SET token=?, exposed=0, updated_at=? WHERE instance_id=? AND kind=? AND subject=?").run(token, now, instanceId, kind, subject);
    return token;
  }

  byToken(token: string): ShareRow | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const row = this.db.prepare("SELECT * FROM shares WHERE token=?").get(token) as DbShareRow | undefined;
    return row ? fromDb(row) : undefined;
  }
}
