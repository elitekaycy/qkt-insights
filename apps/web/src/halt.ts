import type { StrategyRow } from "./api";
import { clock, day, money, pctValue, ts } from "./format";

/**
 * The command that clears a persistent halt, or null when the halt clears on its own or its
 * scope is unknown. The daemon addresses a strategy by its deploy name (`book/alias` for a
 * portfolio child), which strategy.started reports as deployName.
 */
export function resumeCommand(row: StrategyRow): string | null {
  if (!row.halted || row.haltPersistent !== true) return null;
  const deployName = row.metadata?.deployName;
  return `qkt resume ${typeof deployName === "string" && deployName.length > 0 ? deployName : row.strategyId}`;
}

/** How the halt ends, e.g. "resumes 00:00 UTC" (a daily halt clears at the next UTC day). */
export function haltClearing(row: StrategyRow): string {
  if (row.haltPersistent === true || row.haltScope === "PERSISTENT") return "stays halted until an operator resumes it";
  if (row.haltScope === "DAILY") return "resumes 00:00 UTC";
  if (row.haltScope === "TRANSIENT") return "clears when the session restarts";
  return "scope unknown: sent by a qkt engine before v0.52";
}

/**
 * When the halt began, e.g. "at 02:10 UTC" (today, by `now`) or "at 2026-08-24 14:20 UTC", or "before …" when a
 * restart re-asserted it and no earlier record survives (the halt is at least that old). Null without a time.
 */
export function haltSince(row: StrategyRow, now = Date.now()): string | null {
  if (row.haltedAt == null) return null;
  const when = day(row.haltedAt) === day(now) ? clock(row.haltedAt) : ts(row.haltedAt).slice(0, 16);
  return `${row.haltedBefore ? "before" : "at"} ${when} UTC`;
}

const LIMIT_REASON = /^(strategy |global )?(daily loss|daily drawdown|drawdown) (-?\d+(?:\.\d+)?) exceeds max (\d+(?:\.\d+)?)$/u;
const LIMIT_WORDS: Record<string, string> = { "daily loss": "Daily loss", "daily drawdown": "Daily drawdown", drawdown: "Drawdown" };

/**
 * The engine's halt reason in words, its figures formatted: "strategy daily loss 3.49900000 exceeds max 3" reads
 * "Daily loss 3.50 hit the 3.00 cap", and a drawdown (a fraction in the reason) "Drawdown 8.96% hit the 5.00% cap".
 * A "global" limit is the account's. Any other reason is returned as qkt sent it.
 */
export function haltReasonText(reason: string | null | undefined): string {
  if (!reason) return "no reason given";
  const m = LIMIT_REASON.exec(reason.trim());
  if (!m) return reason;
  const [, scope, limit, used, cap] = m;
  const fraction = limit !== "daily loss";
  const figure = (v: string) => (fraction ? pctValue(Number(v) * 100, 2) : money(Number(v)));
  const name = scope === "global " ? `Account ${limit}` : LIMIT_WORDS[limit!]!;
  return `${name} ${figure(used!)} hit the ${figure(cap!)} cap`;
}

const LIMIT_LABEL: Record<string, string> = { "daily loss": "Daily loss cap hit", "daily drawdown": "Daily drawdown cap hit", drawdown: "Drawdown cap hit" };

/** How a halt ends in a few words: "resumes 00:00 UTC", "needs a resume"; null when the engine did not say. */
function clearsShort(row: StrategyRow): string | null {
  if (row.haltPersistent === true || row.haltScope === "PERSISTENT") return "needs a resume";
  if (row.haltScope === "DAILY") return "resumes 00:00 UTC";
  if (row.haltScope === "TRANSIENT") return "clears on restart";
  return null;
}

/** What stopped a strategy, from the engine's reason: a pill-sized `what` and a sentence-sized `why`. */
function haltCause(reason: string): { what: string; why: string } {
  const limit = LIMIT_REASON.exec(reason);
  if (limit) return { what: limit[1] === "global " ? `Account ${limit[2]} cap hit` : LIMIT_LABEL[limit[2]!]!, why: haltReasonText(reason) };
  if (/\broll/iu.test(reason)) return { what: "Roll failed", why: "Rolling to the next contract failed" };
  if (/^engine fault\b/iu.test(reason)) return { what: "Stopped by an error", why: "An engine error stopped it" };
  if (/\b(operator|manual(ly)?)\b/iu.test(reason)) return { what: "Halted by an operator", why: "An operator halted it" };
  return { what: "Halted by the engine", why: "The engine halted it" };
}

/**
 * A halt in plain words, never the engine's raw text (ids, epoch stamps, stack fragments): a short `label` for a pill's
 * tooltip ("Daily loss cap hit · resumes 00:00 UTC", "Roll failed · needs a resume") and a `sentence` for a banner
 * ("Daily loss 3.50 hit the 3.00 cap. Resumes 00:00 UTC."). Null when the strategy is not halted.
 */
export function haltWords(row: StrategyRow): { label: string; sentence: string } | null {
  if (!row.halted) return null;
  const { what, why } = haltCause((row.haltReason ?? "").trim());
  const clears = clearsShort(row);
  return {
    label: clears ? `${what} · ${clears}` : what,
    sentence: `${why}. ${haltClearing(row).replace(/^./u, (c) => c.toUpperCase())}.`,
  };
}

/**
 * One line for a badge tooltip: the halt in plain words, when (UTC), how it ends, and the resume command.
 * e.g. "Daily loss 3.50 hit the 3.00 cap at 02:10 UTC · resumes 00:00 UTC", or "The engine halted it at
 * 2026-09-21 14:02 UTC · stays halted until an operator resumes it · qkt resume gold_paper". Null when the strategy
 * is not halted.
 */
export function haltSummary(row: StrategyRow, now = Date.now()): string | null {
  if (!row.halted) return null;
  const head = haltCause((row.haltReason ?? "").trim()).why;
  const since = haltSince(row, now);
  const parts = [since ? `${head} ${since}${row.haltedBefore ? " (re-asserted at a restart; its start is not stored)" : ""}` : head];
  parts.push(haltClearing(row));
  const command = resumeCommand(row);
  if (command) parts.push(command);
  return parts.join(" · ");
}
