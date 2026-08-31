import { describe, it, expect } from "vitest";
import { openDb, accountDrawdown } from "../src/index.js";

const M = 60_000;
const T0 = Date.UTC(2026, 7, 1);

function seed(db: ReturnType<typeof openDb>, broker: string, equities: number[]): void {
  const ins = db.prepare(
    "INSERT INTO account_equity (instance_id, broker, minute_ts, balance, equity, open_profit) VALUES ('i1', ?, ?, ?, ?, 0)",
  );
  equities.forEach((e, i) => ins.run(broker, T0 + i * M, e, e));
}

describe("accountDrawdown", () => {
  it("reports current and max drawdown as percent of the running peak", () => {
    const db = openDb(":memory:");
    // peak 110 -> trough 88 (20% dd) -> recover to 99 (10% below peak)
    seed(db, "ICM", [100, 110, 95, 88, 99]);
    const [row] = accountDrawdown(db, { instanceId: "i1" });
    expect(row).toBeDefined();
    expect(row!.broker).toBe("ICM");
    expect(row!.peakEquity).toBe(110);
    expect(row!.currentEquity).toBe(99);
    expect(row!.maxDdPct).toBeCloseTo(20, 5);
    expect(row!.currentDdPct).toBeCloseTo(10, 5);
    expect(row!.points).toBe(5);
  });

  it("keeps brokers separate and handles a fresh account at its peak", () => {
    const db = openDb(":memory:");
    seed(db, "A", [50, 60]);
    seed(db, "B", [200, 180, 190]);
    const rows = accountDrawdown(db, { instanceId: "i1" });
    const a = rows.find((r) => r.broker === "A")!;
    const b = rows.find((r) => r.broker === "B")!;
    expect(a.currentDdPct).toBeCloseTo(0, 5);
    expect(a.maxDdPct).toBeCloseTo(0, 5);
    expect(b.maxDdPct).toBeCloseTo(10, 5);
    expect(b.currentDdPct).toBeCloseTo(5, 5);
    expect(accountDrawdown(db, { instanceId: "nope" })).toEqual([]);
  });
});
