import type { Db } from "./db.js";
import { statement } from "./statements.js";

/*
 * The instrument a history row belongs to. A contract that expires (a dated future, an option, an event contract)
 * is one of many its venue lists under one family over time: a strategy on qkt's `ES@front` or an hourly event slot
 * trades a new contract each roll. Its trades group under that family, from the `root` qkt states on its deals
 * (`CME:ES`, `KALSHI:KXINXU`), keyed with its kind so a root's futures and options stay apart: `ES@FUTURE`,
 * `BTC@OPTION`, `KXINXU@EVENT`. Anything else, and a contract no deal stated a root for, is its symbol without the
 * broker label, as before. Live positions keep their own contract; only history folds.
 */

const EXPIRING = new Set(["future", "option", "event"]);

/**
 * The traded instrument behind a venue symbol: qkt prefixes each symbol with the broker profile
 * that saw it ("ICM_S05:XAUUSD"), so one instrument on one account arrives under several names.
 * e.g. "ICM_S05:XAUUSD" -> "XAUUSD", "XAUUSD" -> "XAUUSD".
 */
export function instrumentOf(symbol: string | null | undefined): string {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}

/** The history key of `symbol` given the kind and root qkt stated for it; the bare symbol without both. */
export function familyKey(symbol: string | null | undefined, kind: string | null | undefined, root: string | null | undefined): string {
  const k = kind?.toLowerCase();
  if (root && k && EXPIRING.has(k)) return `${instrumentOf(root).toUpperCase()}@${k.toUpperCase()}`;
  return instrumentOf(symbol);
}

/** Every symbol of the instance whose deals stated a root, mapped to its history key; the bare symbol for the rest. */
export function instrumentKeys(db: Db, instanceId: string): (symbol: string | null | undefined) => string {
  // SQLite takes the bare columns from the row holding max(ts) in each group: the newest statement of the symbol
  const rows = statement(db,
    `SELECT symbol, instrument_kind kind, instrument_root root, max(ts) ts FROM deals
      WHERE instance_id=? AND symbol IS NOT NULL AND instrument_root IS NOT NULL GROUP BY symbol`,
  ).all(instanceId) as Array<{ symbol: string; kind: string | null; root: string }>;
  const keys = new Map(rows.map((r) => [r.symbol, familyKey(r.symbol, r.kind, r.root)]));
  return (symbol) => (symbol ? keys.get(symbol) : undefined) ?? instrumentOf(symbol);
}
