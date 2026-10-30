import { useState } from "react";
import type { LogRow } from "../api";
import { ts, tsShort } from "../format";
import type { LogGroup } from "../logs";
import { LEVEL_TONE, Pill } from "./ui";

/**
 * One engine log entry, or a group of identical ones written in the same second ("×8", the strategies on hover), on
 * one line: time, the level when it needs a look, the strategy, the message. A click opens the whole message; the
 * logger and the full stamp are on the row's tooltip.
 */
export function LogLine({ log, group, showStrategy = true, strategyName = (id) => id }: {
  log: LogRow; group?: LogGroup; showStrategy?: boolean; strategyName?: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const many = group != null && group.count > 1;
  const who = many ? group.strategies.map((s) => (s ? strategyName(s) : "unattributed")).join(", ") : null;
  const attention = log.level === "WARN" || log.level === "ERROR";
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      title={`${ts(log.ts)} UTC · ${log.level} · ${log.logger}${many ? ` · ${group.count} identical lines this second from ${who}` : ""}`}
      className={`flex w-full min-w-0 items-baseline gap-x-2.5 border-b border-line px-2 py-1.5 text-left text-xs transition last:border-b-0 hover:bg-hover ${open ? "flex-wrap" : ""}`}
    >
      <span className="shrink-0 whitespace-nowrap font-mono text-muted">{tsShort(log.ts)}</span>
      <span className="w-11 shrink-0">{attention && <Pill tone={LEVEL_TONE[log.level] ?? "neutral"}>{log.level === "WARN" ? "Warn" : "Error"}</Pill>}</span>
      {many && <span className="shrink-0 text-muted">×{group.count}</span>}
      {showStrategy && many && group.strategies.length > 1 ? (
        <span className="w-28 shrink-0 truncate text-muted max-sm:hidden">{group.strategies.length} strategies</span>
      ) : showStrategy && (
        <span className="w-28 shrink-0 truncate text-muted max-sm:hidden">{log.strategyId ? strategyName(log.strategyId) : ""}</span>
      )}
      <span className={`min-w-0 font-mono text-bright ${open ? "w-full whitespace-pre-wrap break-words pt-1" : "flex-1 truncate"}`}>{log.message}</span>
    </button>
  );
}
