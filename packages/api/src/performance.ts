import {
  closedTrades, contributionRanking, costDecomposition, dailyNets, dowHourMatrix, drawdownPeriods, excursionStats, executionQuality,
  normalizedPerformance, performanceReport, postLossStats, rollingStats, tradeBreakdowns, type AnalyticsFilter, type Db,
} from "@qkt-insights/store";

/**
 * One round trip for the whole analytics view; profitFactor "inf" survives JSON as a string.
 * `include` (comma list) limits which aggregates run — Overview needs only dailyNets, the close
 * map only closes; the full detail page omits it and gets everything.
 */
export function performanceBundle(db: Db, f: AnalyticsFilter, include?: string, window?: string) {
  // A repeated ?include= arrives as an array; only a single string is a valid selection.
  const wanted = typeof include === "string" ? new Set(include.split(",")) : null;
  const want = (k: string) => wanted == null || wanted.has(k);
  return {
    report: want("report") ? performanceReport(db, f) : undefined,
    dailyNets: want("dailyNets") ? dailyNets(db, f) : undefined,
    drawdownPeriods: want("drawdownPeriods") ? drawdownPeriods(db, f) : undefined,
    postLoss: want("postLoss") ? postLossStats(db, f) : undefined,
    breakdowns: want("breakdowns") ? tradeBreakdowns(db, f) : undefined,
    closes: want("closes") ? closedTrades(db, f) : undefined,
    dowHour: want("dowHour") ? dowHourMatrix(db, f) : undefined,
    rolling: want("rolling") ? rollingStats(db, f, typeof window === "string" ? Number(window) : undefined) : undefined,
    costs: want("costs") ? costDecomposition(db, f) : undefined,
    contribution: want("contribution") ? contributionRanking(db, f) : undefined,
    normalized: want("normalized") ? normalizedPerformance(db, f) : undefined,
    excursions: want("excursions") ? excursionStats(db, f) : undefined,
    execution: want("execution") ? executionQuality(db, f) : undefined,
  };
}

export type PerformanceBundle = ReturnType<typeof performanceBundle>;
