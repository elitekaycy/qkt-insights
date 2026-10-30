import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import { groupLogs } from "./logs";

const T = Date.UTC(2026, 9, 29, 23, 20, 0);
const late = (venue: string) => `late tick for ${venue}:BTC_USDC_PERPETUAL stamped 1793315999843 arrived after its candle closed at 1793316000000`;
const line = (id: string, strategyId: string | null, message: string, ts = T, level: LogRow["level"] = "WARN"): LogRow =>
  ({ id, strategyId, level, logger: "CandleAggregator", message, ts });

describe("groupLogs", () => {
  it("folds the same line written by several strategies in one second, in first-seen order", () => {
    const rows = [
      line("1", "o14_expiry", late("PAPER_DERIBIT_B")), line("2", "o08_paper", late("PAPER_F")), line("3", "o08_cross", late("PAPER_F")),
      line("4", "o10_paper", late("PAPER_DERIBIT_B")), line("5", "o14_expiry", late("PAPER_DERIBIT_B"), T + 400), line("6", "o08_paper", late("PAPER_F"), T + 900),
    ];
    const groups = groupLogs(rows);
    expect(groups.map((g) => [g.log.id, g.count, g.strategies])).toEqual([
      ["1", 3, ["o14_expiry", "o10_paper"]],
      ["2", 3, ["o08_paper", "o08_cross"]],
    ]);
    expect(groups[0]!.log.message).toBe(late("PAPER_DERIBIT_B"));
  });

  it("keeps lines of another second, level or text apart", () => {
    const groups = groupLogs([
      line("1", "a", "stale"), line("2", "a", "stale", T + 1000), line("3", "b", "stale", T + 1000, "ERROR"), line("4", null, "healthy", T + 1000),
    ]);
    expect(groups.map((g) => [g.log.id, g.count])).toEqual([["1", 1], ["2", 1], ["3", 1], ["4", 1]]);
    expect(groupLogs([])).toEqual([]);
  });
});
