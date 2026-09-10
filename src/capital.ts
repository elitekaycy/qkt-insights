/**
 * STRATEGY_CAPITAL: the capital each strategy is meant to work out of, keyed by
 * strategyId, e.g. {"gold_gaparmor_calm_v31":7000}. A standalone deploy reports
 * only the daemon's venue-scale balance, so without this its return and drawdown
 * are measured against the whole account.
 */
export function parseStrategyCapital(json: string | undefined): Record<string, number> {
  if (!json?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`STRATEGY_CAPITAL is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed))
    throw new Error("STRATEGY_CAPITAL must be a JSON object of strategyId -> capital");
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(parsed)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`STRATEGY_CAPITAL.${id} must be a positive number`);
    out[id] = v;
  }
  return out;
}
