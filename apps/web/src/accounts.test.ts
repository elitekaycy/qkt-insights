import { describe, expect, it } from "vitest";
import type { LiveAccount } from "./api";
import { groupAccounts, maskLogin } from "./accounts";

const acct = (broker: string, lastSeen: number, extra: Partial<LiveAccount> = {}): LiveAccount => ({
  instanceId: "i", broker, currency: "USD", balance: 100, equity: 100, lastSeen, stale: false, ...extra,
});

describe("groupAccounts", () => {
  it("folds a relabelled account's quiet label into the label reporting now", () => {
    const g = groupAccounts([acct("ICM", 1_000, { stale: true }), acct("ICMARKETS", 900_000, { accountId: "mt5:1234567@S" })]);
    expect(g).toHaveLength(1);
    expect(g[0]!.account.broker).toBe("ICMARKETS");
    expect(g[0]!.labels).toEqual(["ICMARKETS", "ICM"]);
  });

  it("groups labels of one account id even when both report", () => {
    const g = groupAccounts([acct("A", 5_000, { accountId: "mt5:1@S" }), acct("B", 6_000, { accountId: "mt5:1@S" })]);
    expect(g.map((x) => x.account.broker)).toEqual(["B"]);
  });

  it("keeps two genuinely different accounts apart, quiet or not", () => {
    expect(groupAccounts([acct("A", 5_000, { accountId: "mt5:1@S" }), acct("B", 6_000, { accountId: "mt5:2@S" })])).toHaveLength(2);
    expect(groupAccounts([acct("A", 5_000, { accountId: "mt5:1@S", stale: true }), acct("B", 600_000, { accountId: "mt5:2@S" })])).toHaveLength(2);
  });

  it("folds a long-quiet label even when the account itself has just gone quiet too", () => {
    const g = groupAccounts([acct("ICM", 1_000, { stale: true }), acct("ICMARKETS", 900_000, { stale: true, accountId: "mt5:1@S" })]);
    expect(g.map((x) => x.labels)).toEqual([["ICMARKETS", "ICM"]]);
  });

  it("keeps a quiet label it cannot place when several accounts are live", () => {
    const g = groupAccounts([acct("OLD", 1_000, { stale: true }), acct("A", 500_000), acct("B", 600_000)]);
    expect(g).toHaveLength(3);
  });

  it("shows the newest of several quiet labels when nothing is live", () => {
    const g = groupAccounts([acct("OLD", 1_000, { stale: true }), acct("NEW", 2_000, { stale: true })]);
    expect(g).toHaveLength(2);
  });
});

describe("maskLogin", () => {
  it("keeps the last four characters", () => {
    expect(maskLogin("52144821")).toBe("•••4821");
    expect(maskLogin("123")).toBe("123");
  });
});
