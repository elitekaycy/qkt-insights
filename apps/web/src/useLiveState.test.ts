import { describe, expect, it } from "vitest";
import { accountName, accountTab } from "./accounts";
import type { LiveStateSnapshot } from "./api";
import { applyEnvelope } from "./useLiveState";

/*
 * Home folds each pushed state.account into the snapshot. The push states the venue nested and under the profile
 * that polled (EXNESS_O13); the snapshot has it flat. The account's name must read the same before and after.
 */
const snapshot: LiveStateSnapshot = {
  accounts: [{
    instanceId: "soak", broker: "EXNESS_O13", currency: "USD", balance: 4_983_985.86, equity: 4_983_401.47, login: "•••2618",
    accountId: "mt5:748e270a7f5018e5", connector: "mt5", adapter: "exness", tradeMode: "demo", profiles: ["EXNESS_O10", "EXNESS_O13"],
    lastSeen: 1, stale: false,
  }],
  positions: [],
  orders: [],
};

const push = (broker: string, equity: number) => ({
  instanceId: "soak", ts: 2,
  payload: { broker, currency: "USD", balance: 4_983_985.86, equity, login: "•••2618", accountId: "mt5:748e270a7f5018e5",
    venue: { connector: "mt5", adapter: "exness", label: broker, tradeMode: "demo" } },
});

describe("applyEnvelope", () => {
  it("keeps the account's venue facts, label and profiles, so its name never turns into a broker profile", () => {
    const next = applyEnvelope(snapshot, push("EXNESS_O11", 4_983_390.12));
    expect(next.accounts).toHaveLength(1);
    const a = next.accounts[0]!;
    expect(a).toMatchObject({ equity: 4_983_390.12, connector: "mt5", adapter: "exness", tradeMode: "demo", broker: "EXNESS_O13", lastSeen: 2 });
    expect(a.profiles).toEqual(["EXNESS_O10", "EXNESS_O11", "EXNESS_O13"]);
    expect(accountName(a)).toBe("Exness •••2618");
    expect(accountTab(a)).toEqual(accountTab(snapshot.accounts[0]!));
  });

  it("reads the venue from a push for an account the snapshot does not hold yet", () => {
    const a = applyEnvelope(undefined, push("EXNESS_O13", 4_983_401.47)).accounts[0]!;
    expect(accountName(a)).toBe("Exness •••2618");
    expect(a).not.toHaveProperty("venue");
  });
});
