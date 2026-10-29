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

const LIMIT_WORDS: Record<string, string> = { "daily loss": "Daily loss", "daily drawdown": "Daily drawdown", drawdown: "Drawdown" };

/**
 * The engine's halt reason in words, its figures formatted: "strategy daily loss 3.49900000 exceeds max 3" reads
 * "Daily loss 3.50 hit the 3.00 cap", and a drawdown (a fraction in the reason) "Drawdown 8.96% hit the 5.00% cap".
 * A "global" limit is the account's. Any other reason is returned as qkt sent it.
 */
export function haltReasonText(reason: string | null | undefined): string {
  if (!reason) return "no reason given";
  const m = /^(strategy |global )?(daily loss|daily drawdown|drawdown) (-?\d+(?:\.\d+)?) exceeds max (\d+(?:\.\d+)?)$/u.exec(reason.trim());
  if (!m) return reason;
  const [, scope, limit, used, cap] = m;
  const fraction = limit !== "daily loss";
  const figure = (v: string) => (fraction ? pctValue(Number(v) * 100, 2) : money(Number(v)));
  const name = scope === "global " ? `Account ${limit}` : LIMIT_WORDS[limit!]!;
  return `${name} ${figure(used!)} hit the ${figure(cap!)} cap`;
}

/**
 * One line for a badge tooltip: reason, when (UTC), how it ends, and the resume command.
 * e.g. "Daily loss 3.50 hit the 3.00 cap at 02:10 UTC · resumes 00:00 UTC", or "Halted: loss streak 3 at
 * 2026-09-21 14:02 UTC · stays halted until an operator resumes it · qkt resume gold_paper". Null when the strategy
 * is not halted.
 */
export function haltSummary(row: StrategyRow, now = Date.now()): string | null {
  if (!row.halted) return null;
  const reason = haltReasonText(row.haltReason);
  const head = reason === row.haltReason || !row.haltReason ? `Halted: ${reason}` : reason;
  const since = haltSince(row, now);
  const parts = [since ? `${head} ${since}${row.haltedBefore ? " (re-asserted at a restart; its start is not stored)" : ""}` : head];
  parts.push(haltClearing(row));
  const command = resumeCommand(row);
  if (command) parts.push(command);
  return parts.join(" · ");
}
