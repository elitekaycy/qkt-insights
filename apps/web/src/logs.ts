import type { LogRow } from "./api";

/** A log line standing for `count` identical lines written in the same second, by the strategies in `strategies`. */
export interface LogGroup {
  log: LogRow;
  count: number;
  /** Every strategy that wrote it, in first-seen order; null for an unattributed line. */
  strategies: Array<string | null>;
}

/**
 * Lines that repeat within one second (a tick every strategy on a feed logs at the same moment) as one group each,
 * in the order the first of each appears. Only lines of the same second, level, logger and message text fold; the
 * text itself is kept verbatim.
 */
export function groupLogs(rows: readonly LogRow[]): LogGroup[] {
  const out: LogGroup[] = [];
  let second: number | null = null;
  let inSecond = new Map<string, LogGroup>();
  for (const log of rows) {
    const s = Math.floor(log.ts / 1000);
    if (s !== second) {
      second = s;
      inSecond = new Map();
    }
    const key = `${log.level}\u0000${log.logger}\u0000${log.message}`;
    const g = inSecond.get(key);
    if (g) {
      g.count++;
      if (!g.strategies.includes(log.strategyId)) g.strategies.push(log.strategyId);
    } else {
      const group = { log, count: 1, strategies: [log.strategyId] };
      inSecond.set(key, group);
      out.push(group);
    }
  }
  return out;
}
