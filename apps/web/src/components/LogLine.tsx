import type { LogRow } from "../api";
import { ts, tsShort } from "../format";
import { LEVEL_TONE, Pill } from "./ui";

/** One engine log entry. On a phone the message takes its own full line under a
 *  short time + level header; wider screens lay everything out on one row. */
export function LogLine({ log, showStrategy = true, strategyName = (id) => id }: { log: LogRow; showStrategy?: boolean; strategyName?: (id: string) => string }) {
  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1 border-b border-line px-2 py-2 font-mono text-xs last:border-b-0 sm:flex-nowrap sm:py-1.5">
      <span className="whitespace-nowrap text-faint sm:hidden">{tsShort(log.ts)}</span>
      <span className="hidden whitespace-nowrap text-faint sm:inline">{ts(log.ts)}</span>
      <Pill tone={LEVEL_TONE[log.level] ?? "neutral"}>{log.level}</Pill>
      {showStrategy && log.strategyId && <span className="shrink-0 whitespace-nowrap rounded border border-line px-1.5 font-sans text-[11px] leading-5 text-body" title={log.strategyId}>{strategyName(log.strategyId)}</span>}
      <span className="w-full break-words leading-relaxed text-body sm:w-auto sm:leading-normal">{log.message}</span>
      <span className="ml-auto hidden whitespace-nowrap text-faint lg:inline">{log.logger.split(".").pop()}</span>
    </div>
  );
}
