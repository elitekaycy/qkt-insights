import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, ingestEvents, listStrategies, strategyConfigs, withoutEffectiveConfig, type Db } from "../src/index.js";

const I = "fwd";
const T0 = Date.UTC(2026, 9, 28, 9);
const H = 3_600_000;
const CONFIG = {
  schema: 1, kind: "standalone", tradingMode: "demo",
  accounts: [{ name: "EXNESS", type: "mt5", environment: "demo", tickPollIntervalMs: 500 }],
  currency: { value: "USD", source: "configured" },
  risk: { appliesTo: "strategy", maxDailyLoss: { value: 500, source: "configured" }, maxDrawdownFraction: { source: "default" } },
};

function started(ts: number, sha: string | null, extra: Record<string, unknown> = {}): Envelope {
  return {
    v: 1, instanceId: I, id: `strategy-started-gold-${ts}-${sha}`, seq: 1, ts, strategyId: "gold", type: "strategy.started",
    payload: { strategyId: "gold", ts, ...(sha ? { effectiveConfigSha256: sha } : {}), ...extra },
  } as Envelope;
}

function fresh(events: Envelope[]): Db {
  const db = openDb(":memory:");
  ingestEvents(db, I, events);
  return db;
}

describe("strategy configs", () => {
  it("keeps each config once and moves only its last start on a repeat", () => {
    const db = fresh([
      started(T0, "aa", { effectiveConfig: CONFIG }),
      started(T0 + H, "aa", { effectiveConfigOmitted: true }),
      started(T0 + 2 * H, "aa", { effectiveConfig: { ...CONFIG, tradingMode: "live" } }),
    ]);
    const view = strategyConfigs(db, I, "gold");
    expect(view.running).toBe("aa");
    expect(view.versions).toHaveLength(1);
    expect(view.versions[0]).toMatchObject({ sha256: "aa", firstSeen: T0, lastSeen: T0 + 2 * H, starts: 3, state: "stored" });
    expect(view.versions[0]!.config).toMatchObject({ tradingMode: "demo" });
  });

  it("lists every config newest first, and says when one was never received", () => {
    const db = fresh([
      started(T0, "aa", { effectiveConfig: CONFIG }),
      started(T0 + H, "bb", { effectiveConfigOmitted: true }),
    ]);
    const view = strategyConfigs(db, I, "gold");
    expect(view.running).toBe("bb");
    expect(view.versions.map((v) => [v.sha256, v.state])).toEqual([["bb", "not-received"], ["aa", "stored"]]);
    expect(view.versions[0]!.config).toBeNull();
  });

  it("a config that arrives after an omission fills its version", () => {
    const db = fresh([started(T0, "aa", { effectiveConfigOmitted: true }), started(T0 + H, "aa", { effectiveConfig: CONFIG })]);
    expect(strategyConfigs(db, I, "gold").versions[0]).toMatchObject({ state: "stored", starts: 2 });
  });

  it("a qkt that states no config has none running, even after one that did", () => {
    expect(strategyConfigs(fresh([started(T0, null)]), I, "gold")).toEqual({ running: null, versions: [] });
    const view = strategyConfigs(fresh([started(T0, "aa", { effectiveConfig: CONFIG }), started(T0 + H, null)]), I, "gold");
    expect(view.running).toBeNull();
    expect(view.versions.map((v) => v.sha256)).toEqual(["aa"]);
  });

  it("never keeps the config in events or metadata, and keeps its sha for the running version", () => {
    const db = fresh([started(T0, "aa", { effectiveConfig: CONFIG })]);
    expect(JSON.stringify(listStrategies(db, I)[0]!.metadata)).not.toContain("maxDailyLoss");
    expect(listStrategies(db, I)[0]!.metadata).toMatchObject({ effectiveConfigSha256: "aa" });
    const raw = db.prepare("SELECT payload FROM events WHERE type = 'strategy.started'").all() as Array<{ payload: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.payload).not.toContain("maxDailyLoss");
    expect(withoutEffectiveConfig(started(T0, "aa", { effectiveConfig: CONFIG })).payload).not.toHaveProperty("effectiveConfig");
  });

  it("stores only the fields the contract names, whatever a qkt sends", () => {
    const planted = {
      ...CONFIG, futureSecret: "PLANTED-1",
      currency: { value: "https://user:PLANTED-2@gw.example/x", source: "configured" },
      risk: { ...CONFIG.risk, apiKey: "PLANTED-3" },
      accounts: [{ name: "EXNESS", gatewayUrl: "PLANTED-4", type: "mt5" }],
    };
    const db = fresh([started(T0, "aa", { effectiveConfig: planted })]);
    const stored = db.prepare("SELECT config FROM strategy_configs").get() as { config: string };
    expect(stored.config).not.toContain("PLANTED");
    expect(JSON.parse(stored.config)).toMatchObject({ currency: { source: "configured" }, risk: { maxDailyLoss: { value: 500 } }, accounts: [{ name: "EXNESS", type: "mt5" }] });
  });

  it("is per instance and per strategy", () => {
    const db = fresh([started(T0, "aa", { effectiveConfig: CONFIG })]);
    expect(strategyConfigs(db, "other", "gold").versions).toEqual([]);
    expect(strategyConfigs(db, I, "silver")).toEqual({ running: null, versions: [] });
  });
});
