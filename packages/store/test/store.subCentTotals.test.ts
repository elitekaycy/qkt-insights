import { describe, it, expect } from "vitest";
import type { Envelope } from "@qkt-insights/contract";
import { parseQuery } from "@qkt-insights/contract/query";
import {
  accountSummary, closedTrades, contributionRanking, dailyNets, listStrategies, openDb, ingestEvents, performanceReport, rebuildProjection,
  roundTripAnalytics, roundTripTotals, strategyEquityCurve, strategyStats, type Db,
} from "../src/index.js";

/*
 * A paper venue books sub-cent amounts. Each position is money at the cent, but a total is the exact
 * sum at the cent, never the sum of the cents: rounding per position drifted this strategy 2 cents
 * from its deals. The amounts are soak_o03_usage's first 49 closed positions (#203); the venue, qkt
 * and the deals say -4.37, the sum of the per-position cents is -4.35.
 */

const I = "soak";
const S = "soak_o03_usage";
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 28, 0);

/** [closing leg profit, entry commission, closing leg commission]. */
const POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0564, -0.040608, -0.0406362],
  [-0.0581, -0.04064565, -0.0406166],
  [-0.0485, -0.040566, -0.04054175],
  [-0.2852, -0.0404131, -0.0402705],
  [-0.1251, -0.03993705, -0.0398745],
  [-0.0195, -0.0398722, -0.03986245],
  [0.1774, -0.0396259, -0.0397146],
  [0.0918, -0.03945745, -0.03950335],
  [-0.1442, -0.03929605, -0.03922395],
  [0.4143, -0.03842505, -0.0386322],
  [0.1889, -0.0383945, -0.03848895],
  [0.1861, -0.03858945, -0.0386825],
  [0.4275, -0.03874235, -0.0389561],
  [-0.0778, -0.03911195, -0.03907305],
  [0.7882, -0.0781201, -0.0785142],
  [0.0269, -0.0392685, -0.03928195],
  [0.2054, -0.0784317, -0.0785344],
  [-0.0651, -0.0392872, -0.03925465],
  [-0.286, -0.0785079, -0.0783649],
  [-0.1611, -0.03919225, -0.0391117],
  [-0.075, -0.0780304, -0.0779929],
  [0.0087, -0.03894285, -0.0389472],
  [-0.548, -0.0778875, -0.0776135],
  [-0.0202, -0.038819, -0.0388089],
  [-0.7096, -0.0775738, -0.077219],
  [0.3285, -0.03863945, -0.0388037],
  [-0.2206, -0.077694, -0.0775837],
  [-0.2421, -0.03885005, -0.038729],
  [0.4526, -0.0772528, -0.0774791],
  [-0.0134, -0.03867125, -0.03866455],
  [-0.2568, -0.0773222, -0.0771938],
  [-0.1319, -0.03858045, -0.0385145],
  [0.1359, -0.038377, -0.03844495],
  [1.626, -0.077105, -0.077918],
  [0.0182, -0.0387443, -0.0387534],
  [0.0812, -0.0774872, -0.0775278],
  [-0.0438, -0.03875075, -0.03872885],
  [-0.1684, -0.077239, -0.0771548],
  [-0.058, -0.0386224, -0.0385934],
  [-0.312, -0.0770691, -0.0769131],
  [-0.0968, -0.03840855, -0.03836015],
  [-0.5382, -0.0765699, -0.0763008],
  [0.1098, -0.0382215, -0.0382764],
  [0.1596, -0.0768109, -0.0768907],
  [0.0252, -0.0384314, -0.038444],
  [-0.3182, -0.0768159, -0.0766568],
  [-0.0559, -0.0383804, -0.03835245],
  [0.099, -0.03838645, -0.03843595],
  [0.1564, -0.03853215, -0.03861035],
];

let seq = 1;
function deal(ticket: string, position: string, entry: "IN" | "OUT", ts: number, profit: number, commission: number): Envelope {
  return {
    v: 1, instanceId: I, id: `deal-${ticket}`, seq: seq++, ts, type: "broker.deal",
    payload: {
      broker: "PAPER_H", dealTicket: ticket, positionTicket: position, orderTicket: `o-${ticket}`, symbol: "PAPER_H:BTC_USDC_PERPETUAL",
      side: entry === "IN" ? "BUY" : "SELL", entry, qty: 0.001, price: 80000, profit, commission, swap: 0, comment: "", strategyId: S, ts,
    },
  } as Envelope;
}

function seeded(): Db {
  seq = 1;
  const db = openDb(":memory:");
  db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)").run(I, S, T0, T0, 1000);
  ingestEvents(db, I, POSITIONS.flatMap(([profit, inCost, outCost], i) => {
    const open = T0 + i * H;
    return [deal(`d${i}a`, `P${i}`, "IN", open, 0, inCost), deal(`d${i}b`, `P${i}`, "OUT", open + H / 2, profit, outCost)];
  }));
  return db;
}

const exactSum = POSITIONS.reduce((a, [p, i, o]) => a + p + i + o, 0);

describe("a strategy of sub-cent positions", () => {
  it("the fixture is the reported case: exact -4.37, per-position cents -4.35", () => {
    expect(exactSum).toBeCloseTo(-4.373258, 5);
    const db = seeded();
    const rows = closedTrades(db, { instanceId: I, strategyId: S });
    expect(rows).toHaveLength(49);
    expect(Number(rows.reduce((a, r) => a + r.realized, 0).toFixed(2))).toBe(-4.35);
  });

  it("lists the total of its deals", () => {
    expect(listStrategies(seeded(), I).find((s) => s.strategyId === S)).toMatchObject({ realizedNet: -4.37, dealCount: 49 });
  });

  it("states the same total everywhere it is summed", () => {
    const db = seeded();
    const F = { instanceId: I, strategyId: S };
    expect(strategyStats(db, F).realizedPnl).toBe(-4.37);
    expect(strategyEquityCurve(db, F).at(-1)!.realized).toBe(-4.37);
    expect(performanceReport(db, F).totalNet).toBeCloseTo(-4.37, 9);
    expect(contributionRanking(db, F)!.totalNet).toBeCloseTo(-4.37, 9);
    const account = accountSummary(db, { instanceId: I });
    expect(account.totalNet).toBe(-4.37);
    expect(account.byStrategy.find((b) => b.key === S)!.net).toBe(-4.37);
    const q = { instanceId: I, filter: parseQuery("").filter };
    expect(roundTripTotals(db, q).net).toBe(-4.37);
    expect(roundTripAnalytics(db, q).pnl).toBe(-4.37);
  });

  it("gives a day its exact net, from the projection and from the closes alike", () => {
    const db = seeded();
    const F = { instanceId: I, strategyId: S };
    const days = dailyNets(db, F);
    expect(days).toEqual(dailyNets(db, { ...F, from: 0 }));
    const exactDay = (d: number) => POSITIONS.slice(d * 24, (d + 1) * 24).reduce((a, [p, i, o]) => a + p + i + o, 0);
    expect(days.map((d) => d.net)).toEqual([0, 1, 2].map((d) => Number(exactDay(d).toFixed(2))));
  });

  it("keeps each position at the cent and survives a rebuild", () => {
    const db = seeded();
    const rows = closedTrades(db, { instanceId: I, strategyId: S });
    for (const r of rows) expect(Number(r.realized.toFixed(2))).toBe(r.realized);
    expect(rows.some((r) => r.realizedExact !== r.realized)).toBe(true);
    rebuildProjection(db, "closed_trades", { force: true });
    rebuildProjection(db, "strategy_daily", { force: true });
    expect(listStrategies(db, I)[0]).toMatchObject({ realizedNet: -4.37, dealCount: 49 });
  });

  it("a later close moves only the days from its own on, from the exact running total", () => {
    const db = seeded();
    listStrategies(db, I);
    const open = T0 + 49 * H;
    ingestEvents(db, I, [deal("late-a", "PL", "IN", open, 0, -0.004), deal("late-b", "PL", "OUT", open + H, 0.002, -0.004)]);
    expect(listStrategies(db, I)[0]).toMatchObject({ realizedNet: Number((exactSum - 0.006).toFixed(2)), dealCount: 50 });
  });
});

describe("whole-cent venue amounts", () => {
  it("total as they always did", () => {
    seq = 1;
    const db = openDb(":memory:");
    db.prepare("INSERT INTO strategies (instance_id, strategy_id, first_seen, last_seen, starting_balance) VALUES (?,?,?,?,?)").run(I, S, T0, T0, 1000);
    ingestEvents(db, I, [deal("a", "P1", "IN", T0, 0, -0.07), deal("b", "P1", "OUT", T0 + H, -250.2, -0.03), deal("c", "P2", "IN", T0 + H, 0, -0.07), deal("d", "P2", "OUT", T0 + 2 * H, 100.1, -0.03)]);
    expect(listStrategies(db, I)[0]).toMatchObject({ realizedNet: -150.3 });
  });
});
