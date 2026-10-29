import type { Envelope } from "@qkt-insights/contract";
import type { Db } from "./db.js";
import { statement } from "./statements.js";

/*
 * The source of each version a strategy has run. qkt states the strategy file's text on
 * strategy.started (sourceText, cut to 64 KiB; sourceSha256 hashes the whole file) and sends it once
 * per qkt process, strategy and sha: a later start at that sha says sourceTextOmitted instead. Each
 * (instance, strategy, sha) is one row, its text kept the first time it arrives; a repeat start only
 * moves last_seen. The text is the operator's code: it lives in this table alone, never in events,
 * strategy metadata or the live bus (withoutSourceText), and no public view reads it.
 */

/** Why a version shows its text or does not: stored; qkt left it out after an earlier send this collector never got; or qkt sent none. */
export type SourceTextState = "stored" | "not-received" | "not-sent";

export interface StrategySourceVersion {
  sha256: string;
  path: string | null;
  dslVersion: number | null;
  firstSeen: number;
  lastSeen: number;
  /** Starts seen at this version. */
  starts: number;
  /** The stored text is a prefix of a longer file; null when no text is stored. */
  truncated: boolean | null;
  /** UTF-8 bytes of the stored text; null when none. */
  bytes: number | null;
  text: SourceTextState;
}

export interface StrategySourceView {
  /** The sha of the strategy's most recent start, or null when its qkt states none. */
  running: string | null;
  /** Newest first by last start. */
  versions: StrategySourceVersion[];
}

/** `e` without its source text, for every store but strategy_sources: events, metadata, the live bus. */
export function withoutSourceText<T extends Envelope>(e: T): T {
  if (e.type !== "strategy.started" || !("sourceText" in e.payload)) return e;
  const { sourceText: _text, ...payload } = e.payload as Record<string, unknown>;
  return { ...e, payload } as T;
}

/** Records the version a strategy.started states; a start without a sha records nothing. */
export function recordStrategySource(db: Db, instanceId: string, strategyId: string, e: Envelope): void {
  if (e.type !== "strategy.started") return;
  const p = e.payload;
  if (typeof p.sourceSha256 !== "string" || p.sourceSha256 === "") return;
  const text = typeof p.sourceText === "string" ? p.sourceText : null;
  statement(db,
    `INSERT INTO strategy_sources (instance_id, strategy_id, sha256, path, dsl_version, text, truncated, omitted, starts, first_seen, last_seen)
     VALUES (@i, @s, @sha, @path, @dsl, @text, @truncated, @omitted, 1, @ts, @ts)
     ON CONFLICT(instance_id, strategy_id, sha256) DO UPDATE SET
       path = coalesce(@path, path),
       dsl_version = coalesce(@dsl, dsl_version),
       truncated = CASE WHEN text IS NULL THEN @truncated ELSE truncated END,
       text = coalesce(text, @text),
       omitted = max(omitted, @omitted),
       starts = starts + 1,
       first_seen = min(first_seen, @ts),
       last_seen = max(last_seen, @ts)`,
  ).run({
    i: instanceId, s: strategyId, sha: p.sourceSha256,
    path: typeof p.sourcePath === "string" ? p.sourcePath : null,
    dsl: typeof p.dslVersion === "number" ? p.dslVersion : null,
    text,
    truncated: text == null ? null : p.sourceTruncated === true ? 1 : 0,
    omitted: p.sourceTextOmitted === true ? 1 : 0,
    ts: e.ts,
  });
}

interface VersionRow {
  sha256: string; path: string | null; dslVersion: number | null; firstSeen: number; lastSeen: number;
  starts: number; truncated: number | null; bytes: number | null; hasText: number; omitted: number;
}

/** Every version a strategy has run, newest first, without their texts. */
export function strategySources(db: Db, instanceId: string, strategyId: string): StrategySourceView {
  const rows = statement(db,
    `SELECT sha256, path, dsl_version dslVersion, first_seen firstSeen, last_seen lastSeen, starts, truncated,
            length(CAST(text AS BLOB)) bytes, text IS NOT NULL hasText, omitted
       FROM strategy_sources WHERE instance_id = ? AND strategy_id = ?
      ORDER BY last_seen DESC, sha256`,
  ).all(instanceId, strategyId) as VersionRow[];
  const versions = rows.map((r): StrategySourceVersion => ({
    sha256: r.sha256, path: r.path, dslVersion: r.dslVersion, firstSeen: r.firstSeen, lastSeen: r.lastSeen, starts: r.starts,
    truncated: r.hasText ? r.truncated === 1 : null,
    bytes: r.hasText ? r.bytes : null,
    text: r.hasText ? "stored" : r.omitted ? "not-received" : "not-sent",
  }));
  return { running: versions[0]?.sha256 ?? null, versions };
}

/** One version's stored text, or null when there is none. */
export function strategySourceText(db: Db, instanceId: string, strategyId: string, sha256: string): { sha256: string; text: string; truncated: boolean } | null {
  const row = statement(db,
    "SELECT text, truncated FROM strategy_sources WHERE instance_id = ? AND strategy_id = ? AND sha256 = ? AND text IS NOT NULL",
  ).get(instanceId, strategyId, sha256) as { text: string; truncated: number | null } | undefined;
  return row ? { sha256, text: row.text, truncated: row.truncated === 1 } : null;
}
