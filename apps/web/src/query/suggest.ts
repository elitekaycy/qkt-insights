import { parseQuery, resolveKey, type QueryContext, type QueryKey } from "@qkt-insights/contract/query";

/*
 * Completions for the query bar, from the words the language knows and the values the data
 * holds (strategies, instruments, exit days, sizes). Pure: the bar owns the UI.
 */

export interface Suggestion {
  /** What lands in the box. A text ending in ":" is a key template: the viewer keeps typing its value. */
  text: string;
  label: string;
  group: string;
  hint?: string;
}

export interface SuggestData {
  strategies?: readonly string[];
  instruments?: readonly string[];
  /** UTC exit days with trades, newest first. */
  days?: readonly string[];
  sizes?: readonly number[];
  /** The page's keys: a key the page ignores is never offered. */
  keys: ReadonlySet<QueryKey>;
  /** The query already applied: its chips are not offered again. */
  active?: string;
}

interface Cand { text: string; label: string; group: string; words: string; key: QueryKey }

const STATIC: Cand[] = [
  { key: "side", text: "side:long", label: "Long trades", group: "Side", words: "buy long up" },
  { key: "side", text: "side:short", label: "Short trades", group: "Side", words: "sell short down" },
  { key: "outcome", text: "win", label: "Winners", group: "Outcome", words: "win wins winner profit green" },
  { key: "outcome", text: "loss", label: "Losers", group: "Outcome", words: "loss losses loser losing red" },
  { key: "outcome", text: "open", label: "Still open", group: "Outcome", words: "open running live" },
  { key: "outcome", text: "breakeven", label: "Breakeven", group: "Outcome", words: "even flat zero" },
  { key: "ended", text: "ended:stop", label: "Hit the stop", group: "Ended by", words: "sl stop loss stopped" },
  { key: "ended", text: "ended:tp", label: "Hit the target", group: "Ended by", words: "tp take profit target" },
  { key: "ended", text: "ended:signal", label: "Closed by the strategy", group: "Ended by", words: "signal rule close exit" },
  { key: "ended", text: "ended:venue", label: "Closed by the venue (stop-out)", group: "Ended by", words: "venue stopout margin" },
  { key: "ended", text: "ended:manual", label: "Closed by hand", group: "Ended by", words: "manual hand bot" },
  { key: "r", text: "r:>=1", label: "Made at least 1R", group: "R", words: "risk r multiple" },
  { key: "r", text: "r:>=2", label: "Made at least 2R", group: "R", words: "risk r multiple" },
  { key: "r", text: "r:<0", label: "Lost against the risk (below 0R)", group: "R", words: "risk r negative" },
  { key: "r", text: "r:<=-1", label: "Lost 1R or more", group: "R", words: "risk r stop" },
  { key: "held", text: "held:<1h", label: "Held under 1 hour", group: "Held", words: "hold duration quick scalp" },
  { key: "held", text: "held:1h..4h", label: "Held 1–4 hours", group: "Held", words: "hold duration" },
  { key: "held", text: "held:4h..24h", label: "Held 4–24 hours", group: "Held", words: "hold duration" },
  { key: "held", text: "held:>=1d", label: "Held a day or more", group: "Held", words: "hold duration swing overnight" },
  { key: "pnl", text: "pnl:>0", label: "Made money", group: "P&L", words: "profit money pnl" },
  { key: "pnl", text: "pnl:<0", label: "Lost money", group: "P&L", words: "loss money pnl" },
  { key: "pnl", text: "pnl:>=100", label: "Made 100 or more", group: "P&L", words: "profit money pnl big" },
  { key: "pnl", text: "pnl:<=-100", label: "Lost 100 or more", group: "P&L", words: "loss money pnl big" },
  { key: "exit", text: "exit:today", label: "Closed today (UTC)", group: "Exit", words: "today closed exited" },
  { key: "exit", text: "exit:7d", label: "Closed in the last 7 days", group: "Exit", words: "week recent closed" },
  { key: "entry", text: "entry:7d", label: "Opened in the last 7 days", group: "Entry", words: "week recent opened" },
  ...["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d, i) => ({
    key: "weekday" as const, text: `weekday:${d}`, label: `Entered on ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]} (UTC)`, group: "Entry weekday", words: "weekday day dow",
  })),
  { key: "level", text: "level:error", label: "Errors", group: "Level", words: "error err fail" },
  { key: "level", text: "level:warn", label: "Warnings", group: "Level", words: "warn warning" },
  { key: "level", text: "level:info", label: "Info lines", group: "Level", words: "info" },
  { key: "level", text: "level:debug", label: "Debug lines", group: "Level", words: "debug" },
  { key: "time", text: "time:1h", label: "Written in the last hour", group: "Time", words: "recent hour" },
  { key: "time", text: "time:today", label: "Written today (UTC)", group: "Time", words: "today" },
  { key: "time", text: "time:24h", label: "Written in the last 24 hours", group: "Time", words: "day recent" },
  { key: "time", text: "time:7d", label: "Written in the last 7 days", group: "Time", words: "week" },
];

/** The filters offered on an empty box, per page. */
const COMMON: Record<"trades" | "logs", string[]> = {
  trades: ["side:long", "side:short", "win", "loss", "ended:stop", "ended:tp", "r:>=1", "held:<1h", "open"],
  logs: ["level:error", "level:warn", "time:1h", "time:today", "strategy:", "logger:"],
};

const KEYS: Array<[QueryKey, string, string]> = [
  ["strategy", "strategy:", "a strategy, or unattributed"],
  ["symbol", "symbol:", "an instrument, e.g. XAUUSD"],
  ["side", "side:", "long / short"],
  ["pnl", "pnl:", "like >50, <0, -20..80"],
  ["r", "r:", "like >=1, <0"],
  ["held", "held:", "like <1h, 1h..4h, >=1d"],
  ["entry", "entry:", "a UTC date or month, today, 7d"],
  ["exit", "exit:", "a UTC date or month, today, 7d"],
  ["ended", "ended:", "stop / tp / signal / venue / manual"],
  ["size", "size:", "lots, like >=0.5"],
  ["weekday", "weekday:", "the UTC entry day, mon to sun"],
  ["hour", "hour:", "the UTC entry hour, like 14 or 8..16"],
  ["ticket", "#", "a venue ticket"],
  ["level", "level:", "error / warn / info / debug"],
  ["logger", "logger:", "part of a logger name"],
  ["time", "time:", "a UTC date, today, 1h, 7d"],
];

const score = (w: string, c: Cand): number => {
  const t = c.text.toLowerCase();
  if (t.startsWith(w)) return 100 - t.length * 0.1;
  if (t.slice(t.indexOf(":") + 1).startsWith(w)) return 90;
  if (t.includes(w)) return 70;
  if (c.words.split(" ").some((x) => x.startsWith(w))) return 60;
  if (c.label.toLowerCase().split(/[^a-z0-9<>=]+/).some((x) => x.startsWith(w))) return 40;
  return 0;
};

/**
 * Suggestions for the word being typed (the last word of `input`). Nothing typed: the page's
 * common filters. `key:` typed: that key's values. Anything else: every filter whose text, value,
 * synonyms or label starts with it, so `stop`, `sl`, `win` and `xau` all find theirs.
 */
export function suggest(input: string, data: SuggestData, limit = 9): Suggestion[] {
  const word = (/(\S*)$/.exec(input)?.[1] ?? "").toLowerCase();
  const ctx: QueryContext = { strategies: data.strategies, instruments: data.instruments };
  const taken = new Set(parseQuery(data.active ?? "", ctx).chips.map((c) => c.text));
  const months = [...new Set((data.days ?? []).map((d) => d.slice(0, 7)))];
  const dynamic: Cand[] = [
    ...(data.strategies ?? []).map((s) => ({ key: "strategy" as const, text: `strategy:${s}`, label: `Only ${s}`, group: "Strategy", words: s.toLowerCase().replace(/_/g, " ") })),
    { key: "strategy", text: "strategy:unattributed", label: "No strategy claimed it", group: "Strategy", words: "unattributed none orphan" },
    ...(data.instruments ?? []).map((s) => ({ key: "symbol" as const, text: `symbol:${s}`, label: `Only ${s}`, group: "Instrument", words: s.toLowerCase() })),
    ...(data.days ?? []).slice(0, 30).map((d) => ({ key: "exit" as const, text: `exit:${d}`, label: `Closed on ${d}`, group: "Exit day", words: d })),
    ...months.map((m) => ({ key: "exit" as const, text: `exit:${m}`, label: `Closed in ${m}`, group: "Exit month", words: m })),
    ...months.map((m) => ({ key: "entry" as const, text: `entry:${m}`, label: `Opened in ${m}`, group: "Entry month", words: m })),
    ...[...new Set(data.sizes ?? [])].map((q) => ({ key: "size" as const, text: `size:${q}`, label: `Traded ${q} lots`, group: "Size", words: "size lots qty" })),
  ];
  const all = [...STATIC, ...dynamic].filter((c) => data.keys.has(c.key) && !taken.has(c.text));
  const out: Suggestion[] = [];
  const push = (c: Cand) => { if (!out.some((o) => o.text === c.text)) out.push({ text: c.text, label: c.label, group: c.group }); };

  const colon = word.indexOf(":");
  if (colon > 0) {
    const typedKey = word.slice(0, colon);
    const value = word.slice(colon + 1);
    const key = resolveKey(typedKey);
    if (!key || !data.keys.has(key)) return [];
    const typed = `${typedKey}:${value}`;
    if (value && !all.some((c) => c.text === typed)) {
      // a comparison or name being typed: offer it as-is once it parses
      const t = parseQuery(typed, ctx).chips[0];
      if (t?.text && !taken.has(t.text)) out.push({ text: t.text, label: t.label ?? `Apply ${t.text}`, group: "Apply" });
    }
    for (const c of all) if (c.key === key && (!value || c.text.toLowerCase().slice(c.text.indexOf(":") + 1).startsWith(value) || c.words.split(" ").some((w) => w.startsWith(value)))) push(c);
    return out.slice(0, limit);
  }
  if (!word) {
    const page = data.keys.has("level") ? COMMON.logs : COMMON.trades;
    for (const t of page) {
      const k = KEYS.find(([, text]) => text === t);
      if (k) { if (data.keys.has(k[0])) out.push({ text: k[1], label: `Filter by ${k[1].replace(":", "")}`, group: "Filters", hint: k[2] }); continue; }
      const c = all.find((x) => x.text === t);
      if (c) push(c);
    }
    return out.slice(0, limit);
  }
  for (const [key, text, hint] of KEYS) {
    if (data.keys.has(key) && text.startsWith(word) && word.length < text.length) out.push({ text, label: `Filter by ${text === "#" ? "ticket" : text.replace(":", "")}`, group: "Filters", hint });
  }
  const scored = all.map((c) => ({ c, s: score(word, c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  for (const { c } of scored) { if (out.length >= limit) break; push(c); }
  return out.slice(0, limit);
}
