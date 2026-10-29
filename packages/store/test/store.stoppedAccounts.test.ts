import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@qkt-insights/contract";
import { openDb, accountVenueFacts, ingestEvents, persistStateEvent, LiveStateStore, withStoppedAccounts, type Db } from "../src/index.js";

/*
 * The soak: an Exness demo account and two gateway paper accounts report; a third paper account's daemon was
 * stopped, and the collector restarted since. Every page must still list it, under the name it had while live.
 */
const I = "soak";
const T0 = Date.UTC(2026, 9, 29, 8);
const MIN = 60_000;
const EXNESS = "mt5:748e270a7f5018e5";
const PAPER_F = "vgp:807ce98500e97c3d";
let seq = 1;

function account(broker: string, accountId: string, login: string, venue: Record<string, string>, ts: number, equity = 10_000): Envelope {
  return { v: 1, instanceId: I, id: `acct-${seq}`, seq: seq++, ts, type: "state.account",
    payload: { broker, currency: venue.adapter === "exness" ? "USD" : "USDC", balance: 10_000, equity, login, accountId, venue } } as Envelope;
}

function report(db: Db, live: LiveStateStore, e: Envelope): void {
  live.upsert(I, e);
  persistStateEvent(db, I, e);
  live.flushRollup(db, e.ts);
}

describe("accounts that stopped reporting", () => {
  it("records what each account is, its login masked, and never the raw login or server", () => {
    const db = openDb(":memory:");
    persistStateEvent(db, I, { ...account("EXNESS_O13", EXNESS, "277312618", { connector: "mt5", adapter: "exness", label: "EXNESS_O13", tradeMode: "demo" }, T0),
      payload: { ...account("EXNESS_O13", EXNESS, "277312618", { connector: "mt5", adapter: "exness", label: "EXNESS_O13", tradeMode: "demo" }, T0).payload, server: "Exness-MT5Trial9" } } as Envelope);
    expect(accountVenueFacts(db, I)).toEqual([{ account: EXNESS, label: "EXNESS_O13", currency: "USD", connector: "mt5", adapter: "exness", tradeMode: "demo", login: "•••2618" }]);
    expect(JSON.stringify(db.prepare("SELECT * FROM account_currencies").all())).not.toMatch(/277312618|Trial9/);
  });

  it("lists a stopped account after a restart, stale and stopped, with its last stored minute and venue facts", () => {
    const db = openDb(":memory:");
    const before = new LiveStateStore();
    report(db, before, account("EXNESS_O13", EXNESS, "•••2618", { connector: "mt5", adapter: "exness", label: "EXNESS_O13", tradeMode: "demo" }, T0));
    report(db, before, account("PAPER_F", PAPER_F, "soak-paper-f", { connector: "vgp", adapter: "paper", label: "PAPER_F" }, T0, 9_999.77));
    // the collector restarts; only the Exness account reports again
    const after = new LiveStateStore();
    report(db, after, account("EXNESS_O13", EXNESS, "•••2618", { connector: "mt5", adapter: "exness", label: "EXNESS_O13", tradeMode: "demo" }, T0 + 30 * MIN));
    const snap = withStoppedAccounts(db, after.snapshot(T0 + 30 * MIN), [I], T0 + 30 * MIN);
    expect(snap.accounts.map((a) => [a.broker, a.stale, a.stopped ?? false])).toEqual([["EXNESS_O13", false, false], ["PAPER_F", true, true]]);
    expect(snap.accounts[1]).toMatchObject({ accountId: PAPER_F, currency: "USDC", equity: 9_999.77, balance: 10_000, connector: "vgp", adapter: "paper",
      login: "•••er-f", lastSeen: Math.floor(T0 / MIN) * MIN, profiles: ["PAPER_F"] });
    // the account reporting is never listed twice
    expect(withStoppedAccounts(db, before.snapshot(T0), [I], T0).accounts).toHaveLength(2);
  });

  it("calls an account that reported minutes before a collector restart stale, not stopped, until it reports again", () => {
    const db = openDb(":memory:");
    report(db, new LiveStateStore(), account("PAPER_F", PAPER_F, "soak-paper-f", { connector: "vgp", adapter: "paper", label: "PAPER_F" }, T0));
    // the collector restarts a minute later; the account has not pushed yet
    const restarted = new LiveStateStore();
    const waiting = withStoppedAccounts(db, restarted.snapshot(T0 + MIN), [I], T0 + MIN).accounts;
    expect(waiting.map((a) => [a.broker, a.stale, a.stopped ?? false])).toEqual([["PAPER_F", true, false]]);
    // no report for longer than STOPPED_AFTER_MS: its daemon stopped
    const quiet = withStoppedAccounts(db, restarted.snapshot(T0 + 6 * MIN), [I], T0 + 6 * MIN).accounts;
    expect(quiet.map((a) => [a.broker, a.stale, a.stopped ?? false])).toEqual([["PAPER_F", true, true]]);
  });
});

describe("049_account_venue_facts", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "insights-venue-facts-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fills the venue of accounts recorded before it from their broker.connected events", () => {
    const file = join(dir, "insights.db");
    let db = openDb(file);
    ingestEvents(db, I, [{ v: 1, instanceId: I, id: "c1", seq: seq++, ts: T0, type: "broker.connected",
      payload: { broker: "PAPER_F", state: "connected", reason: "session-start", ts: T0, venue: { connector: "vgp", adapter: "paper", label: "PAPER_F" }, accountId: PAPER_F } } as Envelope]);
    // the database as the previous release left it: the row without its venue columns, the migration not yet applied
    for (const c of ["connector", "adapter", "trade_mode", "login"]) db.exec(`ALTER TABLE account_currencies DROP COLUMN ${c}`);
    db.prepare("INSERT INTO account_currencies (instance_id, account, label, currency) VALUES (?, ?, ?, ?)").run(I, PAPER_F, "PAPER_F", "USDC");
    db.prepare("DELETE FROM _migrations WHERE name = '049_account_venue_facts.sql'").run();
    db.close();
    db = openDb(file);
    expect(accountVenueFacts(db, I)).toEqual([{ account: PAPER_F, label: "PAPER_F", currency: "USDC", connector: "vgp", adapter: "paper", tradeMode: null, login: null }]);
    db.close();
  });
});
