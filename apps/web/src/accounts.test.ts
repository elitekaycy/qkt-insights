import { describe, expect, it } from "vitest";
import type { LiveAccount } from "./api";
import { accountByKey, accountKey, accountName, accountOfLabel, accountProfiles, accountTab, accountTitle, groupAccounts, maskLogin, switcherOrder, venueName } from "./accounts";

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

describe("accountName", () => {
  it("names an account by its venue and masked login, never by the broker profile that reported it", () => {
    expect(accountName({ broker: "EXNESS_O13", connector: "mt5", adapter: "exness", login: "•••2618" })).toBe("Exness •••2618");
    expect(accountName({ broker: "EXNESS_O12", connector: "mt5", adapter: "exness", login: "277312618" })).toBe("Exness •••2618");
    expect(accountName({ broker: "ICMARKETS", connector: "mt5", adapter: "icmarketssc", login: "•••0042" })).toBe("IC Markets •••0042");
    expect(accountName({ broker: "DERIBIT", connector: "vgp", adapter: "deribit", login: "•••7781" })).toBe("Deribit •••7781");
  });

  it("calls a gateway paper account Paper, and qkt's own paper broker qkt paper", () => {
    expect(accountName({ broker: "PAPER_DERIBIT_B", connector: "vgp", adapter: "paper", login: "•••er-b" })).toBe("Paper B");
    expect(accountName({ broker: "PAPER_H", connector: "vgp", adapter: "paper", login: "paper-h" })).toBe("Paper H");
    // a paper login without a label suffix keeps its mask; a real venue's login is always masked
    expect(accountName({ broker: "PAPER_X", connector: "vgp", adapter: "paper", login: "•••7781" })).toBe("Paper •••7781");
    expect(accountName({ broker: "DERIBIT", connector: "vgp", adapter: "deribit", login: "acct-b" })).toBe("Deribit •••ct-b");
    expect(accountName({ broker: "PAPER", connector: "paper", adapter: "paper" })).toBe("qkt paper PAPER");
  });

  it("keeps the label beside the venue when no login was ever stated", () => {
    expect(accountName({ broker: "PAPER_F", connector: "vgp", adapter: "paper" })).toBe("Paper PAPER_F");
    expect(accountName({ broker: "EXNESS_P174", connector: "mt5", adapter: "exness" })).toBe("Exness");
  });

  it("falls back to the label when qkt states no venue, and leaves the login off a shared link", () => {
    expect(accountName({ broker: "PAPER_DERIBIT" })).toBe("PAPER_DERIBIT");
    expect(accountName({ broker: "Account 2" }, true)).toBe("Account 2");
    expect(accountName({ broker: "EXNESS_O12", connector: "mt5", adapter: "exness", login: "•••4821" }, true)).toBe("Exness");
  });
});

describe("accountTitle", () => {
  it("starts with the account's name, then the venue in full when it differs, the environment and currency", () => {
    expect(accountTitle({ broker: "EXNESS_O12", connector: "mt5", adapter: "exness", tradeMode: "demo", login: "•••4821", currency: "USD" }))
      .toBe("Exness •••4821 · demo · USD");
    expect(accountTitle({ broker: "PAPER_DERIBIT_B", connector: "vgp", adapter: "paper", tradeMode: "demo", login: "•••er-b", currency: "USDC" }))
      .toBe("Paper B · Paper (Deribit prices) · USDC");
    expect(accountTitle({ broker: "PAPER_F", connector: "vgp", adapter: "paper", currency: "USDC", stopped: true }))
      .toBe("Paper PAPER_F · Paper (Deribit prices) · USDC · stopped reporting");
  });

  it("names venues it does not know from their adapter", () => {
    expect(venueName({ connector: "vgp", adapter: "kraken" })).toBe("Kraken");
    expect(venueName({ connector: "mt5", adapter: "fivepercentonline" })).toBe("The5ers");
    expect(venueName({})).toBeNull();
  });
});

describe("accountProfiles", () => {
  it("counts every broker profile one account is reached through, its folded labels included", () => {
    const a = acct("EXNESS_O12", 5_000, { profiles: ["EXNESS_O12", "EXNESS_O2", "EXNESS_P1"] });
    expect(accountProfiles(a, ["EXNESS_O12", "EXNESS_OLD"])).toEqual(["EXNESS_O2", "EXNESS_O12", "EXNESS_OLD", "EXNESS_P1"]);
    expect(accountProfiles(acct("DERIBIT", 5_000), ["DERIBIT"])).toEqual(["DERIBIT"]);
  });
});

describe("accountOfLabel", () => {
  it("finds the account any of its profiles reports, on that instance only", () => {
    const shared = acct("EXNESS_O12", 5_000, { profiles: ["EXNESS_O12", "EXNESS_P7"] });
    expect(accountOfLabel([shared], "i", "EXNESS_P7")).toBe(shared);
    expect(accountOfLabel([shared], "i", "EXNESS_O12")).toBe(shared);
    expect(accountOfLabel([shared], "other", "EXNESS_P7")).toBeNull();
    expect(accountOfLabel([shared], "i", "ICMARKETS")).toBeNull();
  });
});

describe("account switcher", () => {
  const exness = acct("EXNESS_O12", 5_000, { accountId: "mt5:748e270a7f5018e5", connector: "mt5", adapter: "exness", tradeMode: "demo", login: "277312618", profiles: ["EXNESS_O11", "EXNESS_O12"] });
  const paperB = acct("PAPER_DERIBIT_B", 6_000, { accountId: "vgp:7bf764b24864a0b1", connector: "vgp", adapter: "paper", login: "paper-b", currency: "USDC" });
  const paperA = acct("PAPER_DERIBIT", 7_000, { accountId: "vgp:932e246860ee1284", connector: "vgp", adapter: "paper", login: "paper-a", currency: "USDC" });

  it("names a tab by venue and masked login, with environment and currency as its hint", () => {
    expect(accountTab(exness)).toEqual({ name: "Exness •••2618", hint: "demo · USD", title: "Exness •••2618 · demo · USD" });
    expect(accountTab(paperA)).toEqual({ name: "Paper A", hint: "USDC", title: "Paper A · Paper (Deribit prices) · USDC" });
    // a shared link carries neither login nor venue: the account's public name
    expect(accountTab(acct("Account 2", 1, { currency: "USDC" }), true)).toEqual({ name: "Account 2", hint: "USDC", title: "Account 2 · USDC" });
  });

  it("keeps the tabs in one order whichever account reported last", () => {
    const order = (list: LiveAccount[]) => switcherOrder(groupAccounts(list)).map((g) => accountTab(g.account).name);
    expect(order([paperB, exness, paperA])).toEqual(["Exness •••2618", "Paper A", "Paper B"]);
    expect(order([paperA, paperB, exness])).toEqual(order([exness, paperA, paperB]));
  });

  it("finds an account by its key, a folded label or a profile that reported it", () => {
    const groups = groupAccounts([exness, paperA, paperB]);
    expect(accountByKey(groups, accountKey(paperB))?.account.broker).toBe("PAPER_DERIBIT_B");
    expect(accountByKey(groups, "EXNESS_O11")?.account.broker).toBe("EXNESS_O12");
    expect(accountByKey(groups, "")).toBeNull();
    expect(accountByKey(groups, "vgp:0000000000000000")).toBeNull();
    expect(accountKey(acct("Account 2", 1))).toBe("Account 2");
  });
});
