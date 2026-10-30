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
function accountIdentity(a: Pick<LiveAccount, "accountId">): string | null {
  return a.accountId ?? null;
}

/** A login with all but its last four characters hidden, e.g. "•••4821". */
export function maskLogin(login: string): string {
  if (login.startsWith("•")) return login;
  return login.length <= 4 ? login : `•••${login.slice(-4)}`;
}

/** How much longer one label has been quiet than another before they read as taking turns. */
const TURN_GAP_MS = 90_000;

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

/** A paper account: qkt's own paper broker, or the gateway's paper adapter. Paper has no environment to state. */
function isPaper(a: Pick<LiveAccount, "connector" | "adapter">): boolean {
  return a.connector === "paper" || (a.connector === "vgp" && a.adapter === "paper");
}

type NameFacts = Pick<LiveAccount, "broker" | "connector" | "adapter" | "login" | "tradeMode">;

/** The login's last four characters, whether or not the collector already masked it. */
function loginTail(login: string | null | undefined): string | null {
  return login ? login.slice(-4) : null;
}

/** The venue's environment as a word: a real-money account reads "live". */
function environmentWord(a: Pick<LiveAccount, "tradeMode">): string | null {
  if (!a.tradeMode) return null;
  return a.tradeMode === "real" ? "live" : a.tradeMode;
}

function baseName(a: NameFacts, isPublic: boolean): string {
  const venue = shortVenue(a);
  if (!venue) return profileName(a);
  if (isPublic) return venue;
  const paper = a.connector === "vgp" && a.adapter === "paper" ? paperLabel(a.login) : null;
  if (paper) return `${venue} ${paper}`;
  const env = isPaper(a) ? null : environmentWord(a);
  if (env) return `${venue} ${env}`;
  if (a.login) return `${venue} ·${loginTail(a.login)}`;
  // a gateway label names one account (one gateway per venue account); an MT5 label can be one of many profiles
  const label = a.connector === "vgp" ? a.broker : profileName(a);
  return label.toUpperCase() === venue.toUpperCase().replace(/\s+/gu, "") ? venue : `${venue} ${label}`;
}

/**
 * THE name of a venue account, the one every page, table, legend, tooltip and drill-down shows: short, human and on
 * one line. The venue and its environment ("Exness demo", "Exness live"), or "Paper A" for a gateway paper account,
 * whose login is a label and not a secret. Without an environment the login's last characters tell it apart
 * ("Deribit ·7781"); an account whose login was never stated keeps its broker label ("Paper PAPER_F"); one whose venue
 * was never stated is named by its label alone. Shared links show the venue alone (their labels are "Account 2").
 * `peers` are the accounts it is shown beside: when two would read the same, the login's last four tell them apart
 * ("Exness demo ·2618"). Never a broker profile such as EXNESS_O13 when the venue is known: several profiles share one account.
 */
export function accountName(a: NameFacts, isPublic = false, peers: readonly NameFacts[] = []): string {
  const name = baseName(a, isPublic);
  if (isPublic) return name;
  const tail = loginTail(a.login);
  const clash = tail != null && peers.some((p) => baseName(p, isPublic) === name && loginTail(p.login) !== tail);
  return clash ? `${name} ·${tail}` : name;
}

/** The letter or number a gateway paper login ends in ("paper-a", masked "•••er-a" -> "A"); null for any other login. */
function paperLabel(login: string | null | undefined): string | null {
  const m = login ? /[-_]([a-z0-9]{1,2})$/iu.exec(login) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/** The venue as an account's name starts: venueName, with the gateway's paper adapter as plain "Paper". */
function shortVenue(a: Pick<LiveAccount, "connector" | "adapter">): string | null {
  return a.connector === "vgp" && a.adapter === "paper" ? "Paper" : venueName(a);
}

/**
 * An account's hover title: its name, then what the venue is in full, the masked login, the environment where the name
 * leaves it out, the currency, and whether it stopped reporting, e.g. "Exness demo · login •••4821 · USD" or
 * "Paper B · Paper (Deribit prices) · USDC". Shared links never carry a login.
 */
export function accountTitle(a: NameFacts & { currency?: string; stopped?: boolean }, isPublic = false, peers: readonly NameFacts[] = []): string {
  const full = venueName(a);
  const name = accountName(a, isPublic, peers);
  const paperName = a.connector === "vgp" && a.adapter === "paper" && paperLabel(a.login) != null;
  const env = !isPaper(a) && a.tradeMode && !name.includes(environmentWord(a)!) ? a.tradeMode : undefined;
  const parts = [name, full !== shortVenue(a) ? full : undefined, !isPublic && a.login && !paperName ? `login ${maskLogin(a.login)}` : undefined, env, a.currency, a.stopped ? "stopped reporting" : undefined];
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
 * An account's broker label, steady across polls. Several qkt broker profiles can share one venue account
 * (forward runs 15 Exness profiles on one login), and the live row carries whichever profile reported last,
 * so a label of the venue's own profiles (`EXNESS_P174` on adapter `exness`) reads as the venue. Any other
 * label (ICMARKETS, PROP_S01) is kept as it is.
 */
function profileName(a: Pick<LiveAccount, "broker" | "adapter">): string {
  const venue = a.adapter?.toUpperCase();
  return venue && a.broker.toUpperCase().startsWith(`${venue}_`) ? venue : a.broker;
}

/** The key an account goes by in the URL (`?account=`) and the API: its venue id, else the label it reports under (on a shared link, "Account 2"). */
export function accountKey(a: Pick<LiveAccount, "accountId" | "broker">): string {
  return a.accountId ?? a.broker;
}

/** One account as a tab or table row shows it: its name (accountName) and the title on hover. */
export function accountTab(a: LiveAccount, isPublic = false, peers: readonly NameFacts[] = []): { name: string; title: string } {
  return { name: accountName(a, isPublic, peers), title: accountTitle(a, isPublic, peers) };
}

/** The instance's accounts in the switcher's order: by name, so a tab never moves when another account reports. */
export function switcherOrder(groups: readonly AccountGroup[], isPublic = false): AccountGroup[] {
  const peers = groups.map((g) => g.account);
  const name = (g: AccountGroup) => accountName(g.account, isPublic, peers);
  return [...groups].sort((x, y) => name(x).localeCompare(name(y), "en", { numeric: true }) || accountKey(x.account).localeCompare(accountKey(y.account)));
}

/** The account `key` names (its key, a label folded into it, or a profile that reported it); null for none, or for "all accounts". */
export function accountByKey(groups: readonly AccountGroup[], key: string): AccountGroup | null {
  if (!key) return null;
  return groups.find((g) => accountKey(g.account) === key)
    ?? groups.find((g) => g.labels.includes(key) || (g.account.profiles ?? []).includes(key))
    ?? null;
}
