import { DASH } from "../format";
import type { RoundTrip } from "./data";
import { ENDED_LABEL, ENDED_TITLE } from "./format";

/** How a trade ended, as a plain word: a stop is a planned exit; only the venue closing it reads amber. */
export function EndedWord({ ended }: { ended: RoundTrip["ended"] }) {
  if (!ended) return <span className="text-muted" title="No venue comment or engine event says how it closed">{DASH}</span>;
  return <span className={ended === "venue" ? "font-medium text-warn" : "text-muted"} title={ENDED_TITLE[ended]}>{ENDED_LABEL[ended]}</span>;
}
