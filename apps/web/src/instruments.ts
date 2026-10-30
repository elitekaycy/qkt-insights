import { instrumentType, type InstrumentType } from "@qkt-insights/contract/query";
import { accountOfLabel, venueName } from "./accounts";
import type { LiveAccount, StrategyRow } from "./api";
import { MONTHS, quantity } from "./format";

/*
 * What a position is, said the same way everywhere a user looks: a type (stock CFD, share, perpetual
 * future...) named from the kind and venue folder qkt states, its size in words, and a plain
 * explanation of each type and each cost kind. GLOSSARY is the one source of those explanations.
 */

export { instrumentType, type InstrumentType };

export const TYPE_LABEL: Record<InstrumentType, string> = {
  "stock-cfd": "Stock CFD",
  cfd: "CFD",
  share: "Share",
  coin: "Coin (spot)",
  perpetual: "Perpetual future",
  future: "Dated future",
  option: "Option",
};

export type CostKind = "commission" | "swap" | "funding" | "fee" | "dividend" | "adjustment" | "settlement" | "premium";

/** One sentence or two per type and cost kind: what it is and what holding it costs. Neutral, no advice. */
export const GLOSSARY: Record<InstrumentType | CostKind, { term: string; text: string }> = {
  cfd: {
    term: "CFD",
    text: "A contract for difference on a price. You do not own the asset: the venue pays or charges the change in price while the position is open. Holding past the venue's daily rollover pays or earns swap.",
  },
  "stock-cfd": {
    term: "Stock CFD",
    text: "A CFD on a company's share price. You do not own the share and have no shareholder rights. A dividend is passed on as a cash adjustment, and holding past the daily rollover pays or earns swap.",
  },
  share: {
    term: "Share",
    text: "The share itself, held for you at the broker. There is no daily swap or funding; dividends are paid to you as the owner.",
  },
  coin: {
    term: "Coin (spot)",
    text: "The coin itself, bought outright. Nothing is charged for holding it; the venue charges a fee per trade.",
  },
  perpetual: {
    term: "Perpetual future",
    text: "A future that never expires. Funding payments between longs and shorts, every few hours, keep its price near the coin's; you pay or earn funding while you hold it.",
  },
  future: {
    term: "Dated future",
    text: "A contract to buy or sell at a set date. It expires on that date and settles in cash at the settlement price if it is still open.",
  },
  option: {
    term: "Option",
    text: "The right, not the obligation, to buy (call) or sell (put) at the strike price until expiry. The buyer pays a premium; at expiry it settles for what it is worth, or expires worthless.",
  },
  commission: { term: "Commission", text: "What the venue charges per trade, usually on both the entry and the exit." },
  swap: {
    term: "Swap",
    text: "The charge or credit for holding a leveraged position past the venue's daily rollover. It can be paid or earned; one day of the week usually counts three days.",
  },
  funding: {
    term: "Funding",
    text: "The periodic payment between longs and shorts on a perpetual future: while funding is positive longs pay shorts, while negative shorts pay longs.",
  },
  fee: { term: "Fee", text: "Any other charge the venue booked on a trade, such as an exchange or clearing fee." },
  dividend: { term: "Dividend", text: "Cash for a dividend on the underlying share: on a CFD, credited to longs and charged to shorts." },
  adjustment: {
    term: "Adjustment",
    text: "A balance change the venue booked outside a trade, such as a dividend, a corporate action or a correction.",
  },
  settlement: { term: "Settlement", text: "The final cash payment when a dated future or an option expires, at its settlement price." },
  premium: { term: "Premium", text: "The price of an option: paid by its buyer, received by its seller." },
};

/** The facts a size is read from: qkt's kind, the venue folder, the unit of qty and the contract size. */
export interface SizeFacts {
  kind?: string | null;
  category?: string | null;
  unit?: string | null;
  contractSize?: number | null;
}

const plural = (n: number, one: string, many: string) => (Math.abs(n) <= 1 ? one : many);

/**
 * A size in words: "2 shares", "0.01 lot = 1 share" (a stock CFD of known contract size), "0.5 lots",
 * "10 contracts × 0.001", "0.3 BTC". Without a known kind or unit, the bare number.
 */
export function sizeInWords(qty: number | null | undefined, f: SizeFacts): string {
  if (qty == null || !Number.isFinite(qty)) return "—";
  const n = quantity(qty);
  const type = instrumentType(f.kind, f.category);
  const cs = f.contractSize ?? null;
  switch (type) {
    case "share":
      return `${n} ${plural(qty, "share", "shares")}`;
    case "stock-cfd": {
      const lots = `${n} ${plural(qty, "lot", "lots")}`;
      if (cs == null) return lots;
      const shares = qty * cs;
      return `${lots} = ${quantity(shares)} ${plural(shares, "share", "shares")}`;
    }
    case "cfd":
      return `${n} ${plural(qty, "lot", "lots")}`;
    case "coin":
      return f.unit && f.unit !== "coins" ? `${n} ${f.unit}` : `${n} ${plural(qty, "coin", "coins")}`;
    case "perpetual": case "future": case "option": {
      const c = `${n} ${plural(qty, "contract", "contracts")}`;
      return cs != null && cs !== 1 ? `${c} × ${quantity(cs)}` : c;
    }
    default:
      return f.unit ? `${n} ${f.unit}` : n;
  }
}


/** "29 Nov" for a UTC expiry; the year too when it is not this year's. */
function expiryLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`;
}

/** "BTC" from an underlying index or root such as `btc_usdc` or `DERIBIT:BTC_USDC`. */
function baseOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = /([A-Za-z0-9]+)/u.exec(name.slice(name.lastIndexOf(":") + 1));
  return m ? m[1]!.toUpperCase() : null;
}

/** One instrument a strategy trades, with what qkt states about it and the venue it is at. */
export interface Leg {
  /** qkt's symbol, with its broker label: `EXNESS:AAPL`. */
  symbol: string;
  /** The instrument without the label: `AAPL`. */
  name: string;
  type: InstrumentType | null;
  /** The venue in words (`Exness`), or null when nothing names it. */
  venue: string | null;
  expiry?: number | null;
  strike?: number | null;
  optionRight?: string | null;
  underlying?: string | null;
  root?: string | null;
}

/** What the leg is, in words: "BTC 70000 call, 29 Nov" for an option, "BTC, expires 26 Dec" for a dated future, else its name. */
function legInstrument(leg: Leg, now = Date.now()): string {
  // an option qkt states without its terms still names them in its symbol
  const fromSymbol = leg.type === "option" && (leg.strike == null || !leg.optionRight) ? optionFromSymbol(leg.name) : null;
  if (fromSymbol) return `${fromSymbol.base} ${quantity(fromSymbol.strike)} ${fromSymbol.right}, ${expiryLabel(fromSymbol.expiry, now)}`;
  if (leg.type === "option" && leg.strike != null && leg.optionRight) {
    const base = baseOf(leg.underlying) ?? baseOf(leg.root) ?? leg.name;
    return `${base} ${quantity(leg.strike)} ${leg.optionRight.toLowerCase()}${leg.expiry != null ? `, ${expiryLabel(leg.expiry, now)}` : ""}`;
  }
  if (leg.type === "future" && leg.expiry != null) return `${leg.name}, expires ${expiryLabel(leg.expiry, now)}`;
  return leg.name;
}

/** "Stock CFD · AAPL · Exness": type, instrument and venue, each part only when known. */
export function legLabel(leg: Leg, now = Date.now()): string {
  return [leg.type ? TYPE_LABEL[leg.type] : null, legInstrument(leg, now), leg.venue].filter((p): p is string => !!p).join(" · ");
}

const KIND_WORD: Partial<Record<InstrumentType, [string, string]>> = { perpetual: ["perp", "perps"], future: ["future", "futures"], option: ["option", "options"] };

const KIND_ORDER = Object.keys(KIND_WORD);

/**
 * An instrument as a person names it, for a dense row: a derivative by its coin and kind ("BTC perp", "BTC future",
 * "BTC option" from BTC_USDC_PERPETUAL, BTC_USDC@front, BTC_USDC_29OCT26_80500_C), anything else by its name
 * ("XAUUSD"). The broker label is dropped; the full symbol belongs in a tooltip.
 */
export function shortInstrument(symbol: string, type: InstrumentType | null | undefined): string {
  const name = symbol.slice(symbol.lastIndexOf(":") + 1);
  const word = type ? KIND_WORD[type] : undefined;
  if (!word) return name;
  // a dated future keeps its expiry from the symbol: BTC_USDC_30OCT26 reads "BTC future 30 Oct"
  const exp = type === "future" ? /(\d{1,2})([A-Z]{3})\d{2}(?:$|_)/u.exec(name.toUpperCase()) : null;
  const month = exp ? MONTH_CODES.indexOf(exp[2]!) : -1;
  return `${baseOf(name) ?? name} ${word[0]}${month >= 0 ? ` ${Number(exp![1])} ${MONTHS[month]}` : ""}`;
}

/** A venue without its aside: "Paper (Deribit prices)" reads "Paper". */
function shortVenueName(venue: string): string {
  return venue.replace(/\s*\(.*\)$/u, "");
}

/**
 * What a strategy trades as one short line, "XAUUSD · Exness", "BTC perp · Paper", "BTC perp + options · Paper":
 * a coin's derivatives fold into one name, then each venue once in short. `title` lists every leg in full (type,
 * instrument, venue) for the tooltip.
 */
export function legsLine(legs: readonly Leg[], now = Date.now()): { text: string; title: string } {
  const names: string[] = [];
  const kinds = new Map<string, Map<InstrumentType, number>>();
  // an untyped feed named like an id (PAPER_DERIBIT_B.BTC_USDC, an index the strategy reads) is its coin, said once
  const feeds: string[] = [];
  for (const l of legs) {
    const word = l.type ? KIND_WORD[l.type] : undefined;
    if (!word) {
      const feed = /[_.]/u.test(l.name) ? baseOf(l.name.slice(l.name.lastIndexOf(".") + 1)) : null;
      if (feed) feeds.push(feed);
      else if (!names.includes(l.name)) names.push(l.name);
      continue;
    }
    const base = baseOf(l.underlying) ?? baseOf(l.root) ?? baseOf(l.name) ?? l.name;
    if (!kinds.has(base)) names.push(base);
    const k = kinds.get(base) ?? new Map<InstrumentType, number>();
    k.set(l.type!, (k.get(l.type!) ?? 0) + 1);
    kinds.set(base, k);
  }
  for (const f of feeds) if (!names.includes(f)) names.push(f);
  const text = names.map((n) => {
    const k = kinds.get(n);
    if (!k) return n;
    const words = [...k.entries()].sort(([a], [b]) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)).map(([t, c], i) => KIND_WORD[t]![c > 1 || i > 0 ? 1 : 0]);
    return `${n} ${words.join(" + ")}`;
  }).join(", ");
  const venues = [...new Set(legs.flatMap((l) => (l.venue ? [shortVenueName(l.venue)] : [])))];
  return {
    text: venues.length ? `${text} · ${venues.join(", ")}` : text,
    title: legs.map((l) => `${l.type ? TYPE_LABEL[l.type] : "type not stated"} ${legInstrument(l, now)}${l.venue ? ` · ${l.venue}` : ""}`).join("\n"),
  };
}

type Facts = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Every instrument a strategy trades: its deploy's streams as qkt states them (with each stream's
 * instrument and venue from qkt releases that send them), then any symbol its deals show beyond those.
 * The venue comes from the stream, else from the live account its broker label reports.
 */
export function strategyLegs(row: Pick<StrategyRow, "metadata" | "instruments"> | null, accounts: readonly LiveAccount[] = [], instanceId?: string): Leg[] {
  if (!row) return [];
  const traded = new Map((row.instruments ?? []).map((i) => [i.symbol, i]));
  // A label's account, else (a profile of the venue no live account lists, EXNESS_H01) the one venue whose adapter prefixes it.
  const venueOfLabel = (label: string | null): string | null => {
    if (!label || !instanceId) return null;
    const upper = label.toUpperCase();
    const account = accountOfLabel(accounts, instanceId, upper);
    if (account) return venueName(account);
    const venues = new Set(accounts
      .filter((a) => a.instanceId === instanceId && a.adapter && upper.startsWith(`${a.adapter.toUpperCase()}_`))
      .map((a) => venueName(a)));
    return venues.size === 1 ? [...venues][0]! : null;
  };
  const legs: Leg[] = [];
  const seen = new Set<string>();
  const streams = Array.isArray(row.metadata?.streams) ? (row.metadata!.streams as Facts[]) : [];
  for (const s of streams) {
    const symbol = str(s.qktSymbol) ?? (str(s.broker) && str(s.symbol) ? `${s.broker}:${s.symbol}` : null);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const inst = (s.instrument && typeof s.instrument === "object" ? s.instrument : {}) as Facts;
    const dealt = traded.get(symbol);
    const venue = (s.venue && typeof s.venue === "object" ? s.venue : null) as Facts | null;
    legs.push({
      symbol,
      name: str(s.symbol) ?? symbol.slice(symbol.indexOf(":") + 1),
      type: instrumentType(str(inst.kind) ?? dealt?.kind, str(inst.category) ?? dealt?.category ?? null),
      venue: (venue ? venueName({ connector: str(venue.connector) ?? undefined, adapter: str(venue.adapter) ?? undefined }) : null)
        ?? venueOfLabel(str(s.broker) ?? dealt?.broker ?? null),
      expiry: num(inst.expiry), strike: num(inst.strike), optionRight: str(inst.optionRight), underlying: str(inst.underlying), root: str(inst.root),
    });
  }
  for (const i of row.instruments ?? []) {
    if (seen.has(i.symbol)) continue;
    seen.add(i.symbol);
    legs.push({ symbol: i.symbol, name: i.symbol.slice(i.symbol.indexOf(":") + 1), type: instrumentType(i.kind, i.category), venue: venueOfLabel(i.broker) });
  }
  return distinctLegs(legs);
}

/**
 * One leg per instrument: the same instrument traded under several broker profiles of one account (EXNESS_O12:XAUUSD,
 * EXNESS_O13:XAUUSD) is one leg, identified by its type, what it is and its venue. A leg whose venue nothing names
 * folds into the one leg of the same instrument whose venue is known; with two known venues it stays apart.
 */
export function distinctLegs(legs: readonly Leg[]): Leg[] {
  // the same instrument: what it is in words, and a type that does not contradict (an unstated type matches any)
  const same = (a: Leg, b: Leg) => legInstrument(a, 0) === legInstrument(b, 0) && (a.type == null || b.type == null || a.type === b.type);
  const out: Leg[] = [];
  for (const leg of legs) {
    const twin = out.find((l) => same(l, leg) && l.venue === leg.venue);
    if (twin) twin.type ??= leg.type;
    else out.push({ ...leg });
  }
  // unknown venues fold into the instrument's single known venue
  return out.filter((l) => l.venue != null || out.filter((o) => o.venue != null && same(o, l)).length !== 1);
}

/**
 * The currencies of the accounts a strategy trades on, from the broker label of each of its streams: two or more
 * means its figures add currencies 1:1 (they carry "USD+USDC"). Labels no live account reports are skipped.
 */
export function strategyCurrencies(row: Pick<StrategyRow, "metadata"> | null, accounts: readonly LiveAccount[], instanceId: string | undefined): string[] {
  if (!row || !instanceId) return [];
  const streams = Array.isArray(row.metadata?.streams) ? (row.metadata!.streams as Facts[]) : [];
  const out = new Set<string>();
  for (const s of streams) {
    const label = str(s.broker);
    const account = label ? accountOfLabel(accounts, instanceId, label.toUpperCase()) : null;
    if (account?.currency) out.add(account.currency);
  }
  return [...out].sort();
}

const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * An option read from its venue symbol, Deribit's form with or without a settlement currency:
 * `BTC_USDC_29OCT26_80500_C` or `BTC-29NOV26-70000-P`. The premium is quoted in the settlement currency when the
 * symbol names one (USDC), else in the underlying coin (BTC). Null for anything that is not an option symbol.
 */
export function optionFromSymbol(symbol: string): { base: string; premium: string; expiry: number; strike: number; right: "call" | "put" } | null {
  const name = symbol.slice(symbol.lastIndexOf(":") + 1);
  const m = /^([A-Z0-9]+)(?:[_-]([A-Z]{3,5}))?[_-](\d{1,2})([A-Z]{3})(\d{2})[_-](\d+(?:[.d]\d+)?)[_-]([CP])$/u.exec(name.toUpperCase());
  if (!m) return null;
  const [, base, quote, dd, mon, yy, strike, cp] = m;
  const month = MONTH_CODES.indexOf(mon!);
  if (month < 0) return null;
  return {
    base: base!,
    premium: quote ?? base!,
    expiry: Date.UTC(2000 + Number(yy), month, Number(dd)),
    strike: Number(strike!.replace("d", ".")),
    right: cp === "C" ? "call" : "put",
  };
}

/** "Call 80,500 · exp 29 Oct" for an option symbol; null for any other. */
export function optionLine(symbol: string, now = Date.now()): string | null {
  const o = optionFromSymbol(symbol);
  if (!o) return null;
  return `${o.right === "call" ? "Call" : "Put"} ${o.strike.toLocaleString("en-US")} · exp ${expiryLabel(o.expiry, now)}`;
}
