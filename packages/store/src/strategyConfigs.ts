import { EffectiveConfigSchema, type EffectiveConfig, type Envelope } from "@qkt-insights/contract";
import type { Db } from "./db.js";
import { brokerCurrency } from "./currencies.js";
import { statement } from "./statements.js";

/*
 * The configuration each version of a strategy ran on. qkt states an allow-list of resolved settings on
 * strategy.started (effectiveConfig, hashed by effectiveConfigSha256) and sends it once per qkt process,
 * strategy and sha: a later start at that sha says effectiveConfigOmitted instead. Each (instance, strategy,
 * sha) is one row, its config kept the first time it arrives and only the fields the contract names
 * (EffectiveConfigSchema). It lives in this table alone, never in events, strategy metadata or the live bus
 * (withoutEffectiveConfig), and no public view reads it.
 */

export type StrategyConfigState = "stored" | "not-received";

export interface StrategyConfigVersion {
  sha256: string;
  firstSeen: number;
  lastSeen: number;
  /** Starts seen on this configuration. */
  starts: number;
  state: StrategyConfigState;
  config: EffectiveConfig | null;
}

export interface StrategyConfigView {
  /** The sha of the strategy's most recent start, or null when its qkt states none. */
  running: string | null;
  /** Newest first by last start. */
  versions: StrategyConfigVersion[];
  /**
   * The currencies the running configuration's accounts report at the venue, A to Z. Empty until every
   * one of them has reported: the configured currency is then all that is known.
   */
  accountCurrencies: string[];
}

/** `e` without its effective config, for every store but strategy_configs: events, metadata, the live bus. */
export function withoutEffectiveConfig<T extends Envelope>(e: T): T {
  if (e.type !== "strategy.started" || !("effectiveConfig" in e.payload)) return e;
  const { effectiveConfig: _config, ...payload } = e.payload as Record<string, unknown>;
  return { ...e, payload } as T;
}

/** Records the configuration a strategy.started states; a start without a sha records nothing. */
export function recordStrategyConfig(db: Db, instanceId: string, strategyId: string, e: Envelope): void {
  if (e.type !== "strategy.started") return;
  const p = e.payload as Record<string, unknown>;
  if (typeof p.effectiveConfigSha256 !== "string" || p.effectiveConfigSha256 === "") return;
  const parsed = EffectiveConfigSchema.safeParse(p.effectiveConfig);
  const config = p.effectiveConfig != null && parsed.success ? JSON.stringify(parsed.data) : null;
  statement(db,
    `INSERT INTO strategy_configs (instance_id, strategy_id, sha256, config, omitted, starts, first_seen, last_seen)
     VALUES (@i, @s, @sha, @config, @omitted, 1, @ts, @ts)
     ON CONFLICT(instance_id, strategy_id, sha256) DO UPDATE SET
       config = coalesce(config, @config),
       omitted = max(omitted, @omitted),
       starts = starts + 1,
       first_seen = min(first_seen, @ts),
       last_seen = max(last_seen, @ts)`,
  ).run({ i: instanceId, s: strategyId, sha: p.effectiveConfigSha256, config, omitted: p.effectiveConfigOmitted === true ? 1 : 0, ts: e.ts });
}

interface ConfigRow { sha256: string; firstSeen: number; lastSeen: number; starts: number; config: string | null }

/** Every configuration a strategy has run on, newest first. */
export function strategyConfigs(db: Db, instanceId: string, strategyId: string): StrategyConfigView {
  const rows = statement(db,
    `SELECT sha256, first_seen firstSeen, last_seen lastSeen, starts, config
       FROM strategy_configs WHERE instance_id = ? AND strategy_id = ?
      ORDER BY last_seen DESC, sha256`,
  ).all(instanceId, strategyId) as ConfigRow[];
  const versions = rows.map((r): StrategyConfigVersion => ({
    sha256: r.sha256, firstSeen: r.firstSeen, lastSeen: r.lastSeen, starts: r.starts,
    state: r.config == null ? "not-received" : "stored",
    config: r.config == null ? null : JSON.parse(r.config) as EffectiveConfig,
  }));
  const running = runningSha(db, instanceId, strategyId);
  const config = versions.find((v) => v.sha256 === running)?.config;
  return { running, versions, accountCurrencies: venueCurrencies(db, instanceId, config?.accounts ?? []) };
}

function venueCurrencies(db: Db, instanceId: string, accounts: ReadonlyArray<{ name?: string | null }>): string[] {
  const found = accounts.map((a) => (a.name ? brokerCurrency(db, instanceId, a.name) : null));
  return found.length === 0 || found.includes(null) ? [] : [...new Set(found as string[])].sort();
}

/** The sha the latest start stated: none after a downgrade to a qkt that does not state one. */
function runningSha(db: Db, instanceId: string, strategyId: string): string | null {
  const row = statement(db,
    "SELECT json_extract(metadata, '$.effectiveConfigSha256') sha FROM strategies WHERE instance_id = ? AND strategy_id = ?",
  ).get(instanceId, strategyId) as { sha: string | null } | undefined;
  return row?.sha ?? null;
}
