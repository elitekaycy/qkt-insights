import type { StrategyRow } from "./api";
import { ts } from "./format";

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

/** How the halt ends, e.g. "clears at the next UTC day". */
export function haltClearing(row: StrategyRow): string {
  if (row.haltPersistent === true || row.haltScope === "PERSISTENT") return "stays halted until an operator resumes it";
  if (row.haltScope === "DAILY") return "clears at the next UTC day";
  if (row.haltScope === "TRANSIENT") return "clears when the session restarts";
  return "scope unknown: sent by a qkt engine before v0.52";
}

/**
 * When the halt began, e.g. "since 2026-08-24 14:20:09 UTC", or "before 2026-10-21 10:44:01 UTC"
 * when a restart re-asserted it and no earlier record survives (the halt is at least that old).
 * Null without a time.
 */
export function haltSince(row: StrategyRow): string | null {
  if (row.haltedAt == null) return null;
  return `${row.haltedBefore ? "before" : "since"} ${ts(row.haltedAt)} UTC`;
}

/**
 * One line for a badge tooltip: reason, when (UTC), how it ends, and the resume command.
 * e.g. "Halted: loss streak 3 · since 2026-09-21 14:02:11 UTC · stays halted until an operator
 * resumes it · qkt resume gold_paper". Null when the strategy is not halted.
 */
export function haltSummary(row: StrategyRow): string | null {
  if (!row.halted) return null;
  const parts = [`Halted: ${row.haltReason ?? "no reason given"}`];
  const since = haltSince(row);
  if (since) parts.push(row.haltedBefore ? `${since} (re-asserted at a restart; its start is not stored)` : since);
  parts.push(haltClearing(row));
  const command = resumeCommand(row);
  if (command) parts.push(command);
  return parts.join(" · ");
}
