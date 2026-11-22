import type { SetMember } from "../api";
import type { Tone } from "../components/ui";

/*
 * Words for qkt's set.membership changes. Membership is status, not money: tones are info, warn and neutral, never
 * the gain or loss colours, and every change carries its word.
 */

export interface ChangeWords {
  label: string;
  tone: Tone;
  /** What the change means, for the pill's title. */
  explain: string;
}

const WORDS: Record<string, ChangeWords> = {
  join: { label: "Joined", tone: "info", explain: "Entered the ranking: the member starts trading after its warmup." },
  stay: { label: "Back in", tone: "info", explain: "A sticky member back in the ranking: a normal member again, without a new warmup." },
  restore: { label: "Restored", tone: "info", explain: "In the set when the run restarted: membership is recomputed, never read back." },
  stick: { label: "Sticky", tone: "warn", explain: "Left the ranking while it holds a position: it only reduces or closes until flat." },
  release: { label: "Released", tone: "neutral", explain: "A sticky member now flat: it leaves the set." },
  leave: { label: "Left", tone: "neutral", explain: "Left the ranking flat with nothing working." },
  unavailable: { label: "Unavailable", tone: "warn", explain: "Its market data could not be subscribed, so it cannot join until it is." },
};

/** The words for `change`; a kind this dashboard does not know yet shows as qkt sent it. */
export function changeWords(change: string): ChangeWords {
  return WORDS[change] ?? { label: change, tone: "neutral", explain: `qkt reported "${change}".` };
}

/** "BINANCE:BTCUSDT" → "BTCUSDT": the venue is named once, in the title. */
export function memberSymbol(member: string): string {
  const at = member.indexOf(":");
  return at < 0 ? member : member.slice(at + 1);
}

/** The members grouped by set, in the order the store sent them (set, then rank). */
export function membersBySet(members: SetMember[]): Array<{ set: string; members: SetMember[] }> {
  const groups = new Map<string, SetMember[]>();
  for (const m of members) groups.set(m.set, [...(groups.get(m.set) ?? []), m]);
  return [...groups].map(([set, rows]) => ({ set, members: rows }));
}
