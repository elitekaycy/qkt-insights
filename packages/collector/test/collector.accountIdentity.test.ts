import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, LiveBus, LiveStateStore, type Db } from "@qkt-insights/store";
import { mt5AccountId, vgpAccountId, type Envelope } from "@qkt-insights/contract";
import { registerCollector } from "../src/index.js";

/*
 * The release attestation's privacy gate greps every retained file for the account's login and
 * server; the collector database must pass it however qkt names the account.
 */
const LOGIN = "90813377";
const SERVER = "Venue-MT5Trial42";
const GATEWAY_LOGIN = "gw-acct-5521";
const T0 = 1_760_000_000_000;

let dir: string;
let db: Db;
let app: FastifyInstance;
let liveState: LiveStateStore;
let published: Envelope[];
let n = 0;

function ev(type: string, payload: Record<string, unknown>, strategyId?: string): Record<string, unknown> {
  n++;
  return { v: 1, instanceId: "qkt-live", id: `e${n}`, seq: n, ts: T0 + n * 1000, type, strategyId, payload };
}

async function post(events: Array<Record<string, unknown>>) {
  const res = await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer t" }, payload: { instanceId: "qkt-live", events } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Every file of the database directory, as the gate reads them: raw bytes. */
function leaks(): string[] {
  return readdirSync(dir).filter((f) => {
    const bytes = readFileSync(join(dir, f));
    return bytes.includes(LOGIN) || bytes.includes(SERVER) || bytes.includes(GATEWAY_LOGIN);
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insights-identity-"));
  db = openDb(join(dir, "insights.db"));
  liveState = new LiveStateStore();
  const bus = new LiveBus();
  published = [];
  bus.subscribe((e) => published.push(e));
  app = Fastify();
  registerCollector(app, { db, bus, liveState, ingestToken: "t" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const venue = { connector: "mt5", adapter: "venue", label: "VENUE" };
const rawId = `mt5:${LOGIN}@${SERVER}`;

function session(accountId: string | undefined): Array<Record<string, unknown>> {
  const facts = accountId ? { venue, accountId } : {};
  return [
    ev("state.account", { broker: "VENUE", currency: "USD", balance: 1000, equity: 1001, login: LOGIN, server: SERVER, name: "demo", ...facts }),
    ev("state.positions", { broker: "VENUE", positions: [{ ticket: "11", symbol: "VENUE:XAUUSD", side: "BUY", qty: 0.01, entryPrice: 4000, strategyId: "alpha" }], ...facts }),
    ev("state.orders", { broker: "VENUE", orders: [], ...facts }),
    ev("order.submit", { orderId: "o1", orderType: "MARKET", symbol: "VENUE:XAUUSD", side: "BUY", qty: 0.01, ...facts }, "alpha"),
    ev("order.filled", { orderId: "o1", brokerOrderId: "11", symbol: "VENUE:XAUUSD", price: 4000, qty: 0.01, positionId: "11", legEntry: "IN", ...facts }, "alpha"),
    ev("broker.deal", { broker: "VENUE", dealTicket: "d1", positionTicket: "11", orderTicket: "11", symbol: "XAUUSD", side: "BUY", entry: "IN",
      qty: 0.01, price: 4000, profit: 0, strategyId: "alpha", ts: T0, ...facts }),
    ev("broker.connected", { broker: "VENUE", state: "connected", ...facts }),
    ev("log", { level: "INFO", logger: "com.qkt.connector", message: `VENUE: login=${LOGIN} server=${SERVER} mode=demo` }),
    ev("log", { level: "ERROR", logger: "com.qkt.connector", message: `MT5 profile 'venue' account login mismatch: expected 1, got ${LOGIN}` }),
    // an envelope the contract cannot read is kept raw, so it must lose the identity too
    ev("state.account", { broker: "VENUE", currency: 7, login: LOGIN, server: SERVER, accountId: rawId }),
  ];
}

describe("account identity at ingest", () => {
  it("keeps no raw login or server anywhere in the database, for a qkt that states the raw id and one that states none", async () => {
    await post(session(rawId));
    await post(session(undefined));
    await post([
      ev("state.account", { broker: "GW", currency: "USD", balance: 5, equity: 5, login: GATEWAY_LOGIN,
        venue: { connector: "vgp", adapter: "deribit", label: "GW" }, accountId: `vgp:deribit:${GATEWAY_LOGIN}` }),
      ev("broker.deal", { broker: "GW", dealTicket: "g1", qty: 1, price: 1, profit: 0, ts: T0, accountId: `vgp:deribit:${GATEWAY_LOGIN}`, strategyId: "alpha" }),
    ]);
    liveState.flushRollup(db, T0 + 60_000);
    expect(db.prepare("SELECT COUNT(*) n FROM quarantined_events").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM logs").get()).toEqual({ n: 4 });

    const id = mt5AccountId(LOGIN, SERVER);
    expect(db.prepare("SELECT DISTINCT account FROM account_equity ORDER BY account").all()).toEqual(
      [{ account: id }, { account: vgpAccountId("deribit", GATEWAY_LOGIN) }].sort((a, b) => a.account.localeCompare(b.account)));
    expect(db.prepare("SELECT DISTINCT account_id a FROM deals WHERE account_id IS NOT NULL ORDER BY a").all()).toEqual(
      [{ a: id }, { a: vgpAccountId("deribit", GATEWAY_LOGIN) }].sort((a, b) => a.a.localeCompare(b.a)));

    // what the dashboard reads and is pushed carries the opaque id and the masked login only
    const snap = liveState.snapshot(T0 + 60_000);
    expect(snap.accounts.find((a) => a.broker === "VENUE")).toMatchObject({ accountId: id, login: "•••3377" });
    expect(JSON.stringify(snap)).not.toContain(LOGIN);
    expect(JSON.stringify(snap)).not.toContain(SERVER);
    expect(JSON.stringify(published)).not.toContain(LOGIN);
    expect(JSON.stringify(published)).not.toContain(SERVER);
    expect(JSON.stringify(published)).not.toContain(GATEWAY_LOGIN);

    db.pragma("wal_checkpoint(TRUNCATE)");
    expect(leaks()).toEqual([]);
    // the scan finds a stored login: the empty result above is not a blind reader
    db.prepare("UPDATE logs SET message=? WHERE rowid=(SELECT MIN(rowid) FROM logs)").run(`login=${LOGIN}`);
    db.pragma("wal_checkpoint(TRUNCATE)");
    expect(leaks()).toEqual(["insights.db"]);
  });

  it("names an account the same whether qkt states the opaque id, the raw id, or only the login and server", async () => {
    const id = mt5AccountId(LOGIN, SERVER);
    await post([ev("state.account", { broker: "A", currency: "USD", balance: 1, equity: 1, login: LOGIN, server: SERVER, accountId: id })]);
    await post([ev("state.account", { broker: "B", currency: "USD", balance: 1, equity: 1, login: LOGIN, server: SERVER, accountId: rawId })]);
    await post([ev("state.account", { broker: "C", currency: "USD", balance: 1, equity: 1, login: LOGIN, server: SERVER })]);
    await post([ev("state.account", { broker: "D", currency: "USD", balance: 1, equity: 1, login: "•••3377", accountId: id })]);
    const ids = liveState.snapshot(T0 + 60_000).accounts.map((a) => a.accountId);
    // one venue account however it was named: the snapshot folds them into one entry
    expect(new Set(ids)).toEqual(new Set([id]));
  });
});
