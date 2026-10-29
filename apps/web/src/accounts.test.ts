import { describe, expect, it } from "vitest";
import type { LiveAccount } from "./api";
import { accountName, accountOfLabel, accountProfiles, accountTitle, groupAccounts, maskLogin, venueName } from "./accounts";

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
  it("names a shared account by its venue, whichever of its profiles reported last", () => {
    expect(accountName({ broker: "EXNESS_P174", adapter: "exness" })).toBe("EXNESS");
    expect(accountName({ broker: "EXNESS_P511", adapter: "exness" })).toBe("EXNESS");
  });
  it("keeps a label that is not one of the venue's profiles", () => {
    expect(accountName({ broker: "ICMARKETS", adapter: "icmarketssc" })).toBe("ICMARKETS");
    expect(accountName({ broker: "PROP_S01", adapter: "fivepercentonline" })).toBe("PROP_S01");
    expect(accountName({ broker: "EXNESS", adapter: "exness" })).toBe("EXNESS");
    expect(accountName({ broker: "PAPER_DERIBIT" })).toBe("PAPER_DERIBIT");
  });
});

describe("accountTitle", () => {
  it("names the account by its venue, its environment and its masked login, never by a broker profile", () => {
    expect(accountTitle({ broker: "EXNESS_O12", connector: "mt5", adapter: "exness", tradeMode: "demo", login: "•••4821" }))
      .toBe("Exness · demo · •••4821");
    expect(accountTitle({ broker: "ICMARKETS", connector: "mt5", adapter: "icmarketssc", tradeMode: "real", login: "•••0042" }))
      .toBe("IC Markets · real · •••0042");
    expect(accountTitle({ broker: "DERIBIT", connector: "vgp", adapter: "deribit", tradeMode: "demo", login: "•••7781" }))
      .toBe("Deribit · demo · •••7781");
  });

  it("says a gateway paper account trades on Deribit's prices and leaves its environment out", () => {
    expect(accountTitle({ broker: "PAPER_DERIBIT_B", connector: "vgp", adapter: "paper", tradeMode: "demo", login: "•••er-b" }))
      .toBe("Paper (Deribit prices) · •••er-b");
    expect(accountTitle({ broker: "PAPER", connector: "paper", adapter: "paper" })).toBe("qkt paper");
  });

  it("masks a login that arrives whole, and leaves the login off a shared link", () => {
    expect(accountTitle({ broker: "EXNESS_O12", connector: "mt5", adapter: "exness", login: "52144821" })).toBe("Exness · •••4821");
    expect(accountTitle({ broker: "EXNESS_O12", connector: "mt5", adapter: "exness", tradeMode: "demo", login: "•••4821" }, true)).toBe("Exness · demo");
  });

  it("falls back to the label when qkt states no venue", () => {
    expect(accountTitle({ broker: "EXNESS", login: "•••4821" })).toBe("EXNESS · •••4821");
    expect(accountTitle({ broker: "Account 1" }, true)).toBe("Account 1");
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
