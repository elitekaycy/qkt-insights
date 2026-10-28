import type { MagicRange } from "@qkt-insights/store";

const RANGE = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * INSIGHTS_IGNORE_MAGICS: the MT5 magic numbers whose deals, positions and pending orders an instance
 * ignores, keyed by instanceId, as inclusive ranges or single magics, e.g.
 * {"forward":["31000-31199"]}. For another system trading the same venue account: its trades are then
 * neither Unattributed nor retired strategies on this instance (store ignoredMagics.ts).
 */
export function parseIgnoredMagics(json: string | undefined): Record<string, MagicRange[]> {
  if (!json?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`INSIGHTS_IGNORE_MAGICS is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed))
    throw new Error("INSIGHTS_IGNORE_MAGICS must be a JSON object of instanceId -> [magic ranges]");
  const out: Record<string, MagicRange[]> = {};
  for (const [instanceId, list] of Object.entries(parsed)) {
    const at = `INSIGHTS_IGNORE_MAGICS["${instanceId}"]`;
    if (!Array.isArray(list)) throw new Error(`${at} must be an array of ranges such as "31000-31199"`);
    out[instanceId] = list.map((v: unknown) => {
      const m = RANGE.exec(typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "");
      const lo = m ? Number(m[1]) : NaN;
      const hi = m ? Number(m[2] ?? m[1]) : NaN;
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo > hi)
        throw new Error(`${at}: ${JSON.stringify(v)} is not a range of whole magics such as "31000-31199"`);
      return { lo, hi };
    });
  }
  return out;
}
