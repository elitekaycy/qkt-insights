import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mt5AccountId, vgpAccountId } from "@qkt-insights/contract";
import { openDb, accountSeries, refreshProjections, type Db } from "../src/index.js";
import { opaqueAccountIdentity } from "../src/accountIdentityMigration.js";

/*
 * A database the previous release wrote: account ids as "mt5:<login>@<server>" / "vgp:<adapter>:<login>",
 * and the login and server inside stored payloads and logs. Reopening it with this release rewrites
 * every one of them, once, and leaves no byte of the raw values in the file.
 */
const LOGIN = "70224466";
const SERVER = "Venue-Live3";
const GW = "gw-login-8812";
const I = "qkt-live";
const T0 = 1_760_000_000_000;
const RAW = `mt5:${LOGIN}@${SERVER}`;
const ID = mt5AccountId(LOGIN, SERVER);

let dir: string;
const file = () => join(dir, "insights.db");

function leaks(): string[] {
  return readdirSync(dir).filter((f) => {
    const bytes = readFileSync(join(dir, f));
    return bytes.includes(LOGIN) || bytes.includes(SERVER) || bytes.includes(GW);
  });
}

/** Writes what the previous release stored, then forgets this release's migration ran. */
function previousRelease(): void {
  const db = openDb(file());
  const equity = db.prepare("INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit, account) VALUES (?,?,?,?,?,?,?)");
  for (let m = 0; m < 30; m++) {
    equity.run(I, "VENUE", T0 + m * 60_000, 1000, 1000 + m, null, RAW);
    equity.run(I, "VENUE_OLD", T0 - (m + 1) * 60_000, 1000, 990 - m, null, RAW);
    equity.run(I, "GW", T0 + m * 60_000, 50, 50, null, `vgp:deribit:${GW}`);
  }
  refreshProjections(db);
  db.prepare(`INSERT INTO deals (id, instance_id, broker, deal_ticket, position_ticket, symbol, side, entry, qty, price, profit, strategy_id, ts, account_id)
    VALUES ('d1', ?, 'VENUE', '1', '1', 'XAUUSD', 'BUY', 'IN', 0.01, 4000, 0, 'alpha', ?, ?)`).run(I, T0, RAW);
  const event = db.prepare("INSERT INTO events (id, instance_id, type, strategy_id, seq, ts, payload) VALUES (?,?,?,?,?,?,?)");
  event.run("e1", I, "order.filled", "alpha", 1, T0, JSON.stringify({ orderId: "o1", symbol: "XAUUSD", price: 4000, qty: 0.01, accountId: RAW }));
  event.run("e2", I, "broker.connected", null, 2, T0, JSON.stringify({ broker: "VENUE", venue: { label: "VENUE" }, accountId: RAW, nested: { login: LOGIN, server: SERVER } }));
  event.run("e3", I, "signal", "alpha", 3, T0, JSON.stringify({ symbol: "XAUUSD", side: "BUY" }));
  db.prepare("INSERT INTO quarantined_events (instance_id, id, type, v, ts, received_at, reason, envelope) VALUES (?,?,?,?,?,?,?,?)")
    .run(I, "q1", "state.account", 1, T0, T0, "bad", JSON.stringify({ id: "q1", type: "state.account", payload: { login: LOGIN, server: SERVER, accountId: RAW } }));
  db.prepare("INSERT INTO instance_health (instance_id, ts, seq, payload) VALUES (?,?,?,?)").run(I, T0, 4, JSON.stringify({ sent: 1, failed: 0, dropped: 0, queued: 0 }));
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, metadata) VALUES (?,?,?,?,?)")
    .run(I, "alpha", T0, T0, JSON.stringify({ strategyId: "alpha", broker: { login: LOGIN, server: SERVER } }));
  const log = db.prepare("INSERT INTO logs (id, instance_id, strategy_id, level, logger, message, ts, seq) VALUES (?,?,?,?,?,?,?,?)");
  const fts = db.prepare("INSERT INTO logs_fts (text, instance_id, log_rowid) VALUES (?,?,?)");
  for (const [id, message] of [["l1", `VENUE: login=${LOGIN} server=${SERVER} mode=demo`], ["l2", "a quiet line"]] as const) {
    const info = log.run(id, I, null, "INFO", "com.qkt", message, T0, 5);
    fts.run(`com.qkt ${message}`, I, info.lastInsertRowid);
  }
  db.prepare("DELETE FROM _migrations WHERE name='039_opaque_account_identity'").run();
  db.close();
}

function dump(db: Db): string {
  return JSON.stringify({
    equity: db.prepare("SELECT * FROM account_equity ORDER BY rowid").all(),
    labels: db.prepare("SELECT * FROM account_labels ORDER BY broker").all(),
    deals: db.prepare("SELECT account_id FROM deals").all(),
    events: db.prepare("SELECT payload FROM events ORDER BY rowid").all(),
    quarantined: db.prepare("SELECT envelope FROM quarantined_events").all(),
    strategies: db.prepare("SELECT metadata FROM strategies").all(),
    logs: db.prepare("SELECT message FROM logs ORDER BY rowid").all(),
    fts: db.prepare("SELECT text FROM logs_fts ORDER BY rowid").all(),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "insights-identity-migration-"));
  previousRelease();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("migration 039: opaque account identity", () => {
  it("the previous release's database holds the raw identity (the fixture is real)", () => {
    expect(leaks()).toContain("insights.db");
  });

  it("rewrites every stored identity to the opaque id and scrubs payloads and logs", () => {
    const db = openDb(file());
    expect(db.prepare("SELECT DISTINCT account FROM account_equity ORDER BY account").all())
      .toEqual([{ account: ID }, { account: vgpAccountId("deribit", GW) }].sort((a, b) => a.account.localeCompare(b.account)));
    expect(db.prepare("SELECT broker, identity FROM account_labels ORDER BY broker").all()).toEqual([
      { broker: "GW", identity: vgpAccountId("deribit", GW) }, { broker: "VENUE", identity: ID }, { broker: "VENUE_OLD", identity: ID },
    ]);
    expect(db.prepare("SELECT account_id a FROM deals").all()).toEqual([{ a: ID }]);
    const payloads = (db.prepare("SELECT id, payload FROM events ORDER BY rowid").all() as Array<{ id: string; payload: string }>)
      .map((r) => JSON.parse(r.payload));
    expect(payloads[0]).toEqual({ orderId: "o1", symbol: "XAUUSD", price: 4000, qty: 0.01, accountId: ID });
    expect(payloads[1]).toEqual({ broker: "VENUE", venue: { label: "VENUE" }, accountId: ID, nested: { login: "•••4466", accountId: ID } });
    expect(payloads[2]).toEqual({ symbol: "XAUUSD", side: "BUY" });
    expect(db.prepare("SELECT message FROM logs ORDER BY rowid").all())
      .toEqual([{ message: "VENUE: login=[redacted] server=[redacted] mode=demo" }, { message: "a quiet line" }]);
    // the log search still finds the rewritten line by its other words
    expect(db.prepare("SELECT COUNT(*) n FROM logs_fts WHERE logs_fts MATCH 'mode'").get()).toEqual({ n: 1 });
    // an identity rewrite moves no equity: nothing is queued for the account projection
    expect(db.prepare("SELECT COUNT(*) n FROM projection_dirty WHERE kind='account'").get()).toEqual({ n: 0 });
    // the relabelled account still stitches into one series under its id
    expect(accountSeries(db, { instanceId: I }).map((s) => s.key).sort()).toEqual([ID, vgpAccountId("deribit", GW)].sort());
    expect(dump(db)).not.toMatch(new RegExp(`${LOGIN}|${SERVER}|${GW}`));
    // Bytes the previous release freed before this one (a page split's leftovers) stay in unused
    // page space until a VACUUM rewrites the file; after it none is left.
    db.exec("VACUUM");
    db.close();
    expect(leaks()).toEqual([]);
  });

  it("is idempotent and runs once", () => {
    const db = openDb(file());
    const once = dump(db);
    opaqueAccountIdentity(db);
    expect(dump(db)).toEqual(once);
    db.close();
    const again = openDb(file());
    expect(dump(again)).toEqual(once);
    expect(again.prepare("SELECT COUNT(*) n FROM _migrations WHERE name='039_opaque_account_identity'").get()).toEqual({ n: 1 });
    again.close();
  });

  it("keeps the account_equity change trigger", () => {
    const db = openDb(file());
    const trigger = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='account_equity_projection_update'").get();
    expect(trigger).toEqual({ n: 1 });
    db.prepare("UPDATE account_equity SET equity=equity+1 WHERE broker='VENUE' AND minute_ts=?").run(T0);
    expect((db.prepare("SELECT COUNT(*) n FROM projection_dirty WHERE kind='account'").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
