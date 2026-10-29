import type { LiveAccount } from "./api";

/*
 * One strip per real venue account. qkt reports an account under a broker label, and a relabel
 * (ICM became ICMARKETS) or a per-profile copy leaves the old label in collector memory with its
 * last balance. Labels of one account are grouped the way the server stitches its equity series:
 * by account id when one is known, else by taking turns, which live state shows as
 * one label still reporting while the other has gone quiet.
 */

export interface AccountGroup {
  /** The label reporting now (the most recent one); its figures are the account's. */
  account: LiveAccount;
  /** Every label folded into this account, the shown one first. */
  labels: string[];
}

/** The venue account the collector resolved for the label, else null. */
export function accountIdentity(a: Pick<LiveAccount, "accountId">): string | null {
  return a.accountId ?? null;
}

/** A login with all but its last four characters hidden, e.g. "•••4821". */
export function maskLogin(login: string): string {
  return login.length <= 4 ? login : `•••${login.slice(-4)}`;
}

/** How much longer one label has been quiet than another before they read as taking turns. */
export const TURN_GAP_MS = 90_000;

/**
 * Groups one instance's live accounts into real accounts. Same identity: one account. A label
 * that went quiet well before exactly one other (no conflicting identity) took turns with it and
 * folds in; with several fresher accounts it cannot be placed, so it keeps its own strip.
 */
export function groupAccounts(accounts: readonly LiveAccount[]): AccountGroup[] {
  const groups: Array<{ members: LiveAccount[]; identity: string | null }> = [];
  for (const a of [...accounts].sort((x, y) => y.lastSeen - x.lastSeen)) {
    const id = accountIdentity(a);
    const same = id != null ? groups.find((g) => g.identity === id) : undefined;
    if (same) same.members.push(a);
    else groups.push({ members: [a], identity: id });
  }
  const kept: typeof groups = [];
  for (const g of groups) {
    const seen = g.members[0]!.lastSeen;
    const fresher = kept.filter((k) => k.members[0]!.lastSeen - seen > TURN_GAP_MS);
    const target = fresher.length === 1 ? fresher[0]! : undefined;
    const conflict = target != null && target.identity != null && g.identity != null && target.identity !== g.identity;
    if (g.members[0]!.stale && target && !conflict) target.members.push(...g.members);
    else kept.push(g);
  }
  return kept.map((g) => ({ account: g.members[0]!, labels: [...new Set(g.members.map((m) => m.broker))] }));
}

/** The shown account of every real account, instance by instance. */
export function realAccounts(accounts: readonly LiveAccount[]): LiveAccount[] {
  const byInstance = new Map<string, LiveAccount[]>();
  for (const a of accounts) byInstance.set(a.instanceId, [...(byInstance.get(a.instanceId) ?? []), a]);
  return [...byInstance.values()].flatMap((list) => groupAccounts(list).map((g) => g.account));
}

/** Venues by the adapter qkt states (MT5: the trade server's first word), in their own spelling. */
const VENUE_NAMES: Record<string, string> = {
  exness: "Exness", icmarkets: "IC Markets", icmarketssc: "IC Markets", icmarketseu: "IC Markets", fivepercentonline: "The5ers",
  deribit: "Deribit", bybit: "Bybit", alpaca: "Alpaca", binance: "Binance",
};

/**
 * The venue an account is at, in words: the venue for an MT5 or gateway account, "Paper (Deribit prices)" for
 * the gateway's paper adapter (it fills on Deribit's public prices), "qkt paper" for qkt's own paper broker. Null
 * when qkt states no venue (a release before venue facts).
 */
export function venueName(a: Pick<LiveAccount, "connector" | "adapter">): string | null {
  if (a.connector === "paper") return "qkt paper";
  if (!a.adapter) return null;
  if (a.connector === "vgp" && a.adapter === "paper") return "Paper (Deribit prices)";
  return VENUE_NAMES[a.adapter.toLowerCase()] ?? `${a.adapter.charAt(0).toUpperCase()}${a.adapter.slice(1)}`;
}

/**
 * An account's title: the venue, its environment and the login masked to its last four characters, e.g.
 * "Exness · demo · •••4821" or "Paper (Deribit prices) · •••er-b", never the broker profile that happened to
 * report it. A paper account has no environment to state. Shared links leave the login out.
 */
export function accountTitle(a: Pick<LiveAccount, "broker" | "connector" | "adapter" | "tradeMode" | "login">, isPublic = false): string {
  const venue = venueName(a);
  const paper = a.connector === "paper" || (a.connector === "vgp" && a.adapter === "paper");
  const parts = [venue ?? accountName(a), venue && !paper ? a.tradeMode : undefined, !isPublic && a.login ? maskLogin(a.login) : undefined];
  return parts.filter((p): p is string => !!p).join(" · ");
}

/** Every broker profile behind one account: those that reported it, and the labels folded into it, sorted. */
export function accountProfiles(a: Pick<LiveAccount, "broker" | "profiles">, labels: readonly string[] = [a.broker]): string[] {
  return [...new Set([...(a.profiles ?? []), ...labels])].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
}

/** The live account broker profile `label` reports on `instanceId`, or null when none does. */
export function accountOfLabel<T extends Pick<LiveAccount, "instanceId" | "broker" | "profiles">>(accounts: readonly T[], instanceId: string, label: string): T | null {
  return accounts.find((a) => a.instanceId === instanceId && (a.broker === label || (a.profiles ?? []).includes(label))) ?? null;
}

/**
 * The name an account strip shows. Several qkt broker profiles can share one venue account (forward
 * runs 15 Exness profiles on one login), and the live row carries whichever profile reported last,
 * so a label of the venue's own profiles (`EXNESS_P174` on adapter `exness`) reads as the venue,
 * steady across polls. Any other label (ICMARKETS, PROP_S01) is shown as it is.
 */
export function accountName(a: Pick<LiveAccount, "broker" | "adapter">): string {
  const venue = a.adapter?.toUpperCase();
  return venue && a.broker.toUpperCase().startsWith(`${venue}_`) ? venue : a.broker;
}

/** The key an account goes by in the URL (`?account=`) and the API: its venue id, else the label it reports under (on a shared link, "Account 2"). */
export function accountKey(a: Pick<LiveAccount, "accountId" | "broker">): string {
  return a.accountId ?? a.broker;
}

/**
 * One account in the account switcher: the venue in short and the masked login ("Exness •••2618", "Paper •••er-a"),
 * a muted hint of its environment and currency ("demo · USD"), and the full account title on hover.
 */
export function accountTab(a: LiveAccount, isPublic = false): { name: string; hint: string; title: string } {
  const paper = a.connector === "paper" || (a.connector === "vgp" && a.adapter === "paper");
  const venue = a.connector === "vgp" && a.adapter === "paper" ? "Paper" : venueName(a) ?? accountName(a);
  const name = [venue, !isPublic && a.login ? maskLogin(a.login) : undefined].filter(Boolean).join(" ");
  const hint = [!paper ? a.tradeMode : undefined, a.currency].filter(Boolean).join(" · ");
  return { name, hint, title: accountTitle(a, isPublic) };
}

/** The instance's accounts in the switcher's order: by name, so a tab never moves when another account reports. */
export function switcherOrder(groups: readonly AccountGroup[], isPublic = false): AccountGroup[] {
  const name = (g: AccountGroup) => accountTab(g.account, isPublic).name;
  return [...groups].sort((x, y) => name(x).localeCompare(name(y), "en", { numeric: true }) || accountKey(x.account).localeCompare(accountKey(y.account)));
}

/** The account `key` names (its key, a label folded into it, or a profile that reported it); null for none, or for "all accounts". */
export function accountByKey(groups: readonly AccountGroup[], key: string): AccountGroup | null {
  if (!key) return null;
  return groups.find((g) => accountKey(g.account) === key)
    ?? groups.find((g) => g.labels.includes(key) || (g.account.profiles ?? []).includes(key))
    ?? null;
}
