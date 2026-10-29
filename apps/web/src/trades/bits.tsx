import { DASH } from "../format";
import { Pill } from "../components/ui";
import type { RoundTrip } from "./data";
import { ENDED_LABEL, ENDED_TITLE } from "./format";

/** How a trade ended, as a quiet pill: a stop is a planned exit (grey); only the venue closing it reads amber. */
export function EndedBadge({ ended }: { ended: RoundTrip["ended"] }) {
  if (!ended) return <span className="text-faint" title="No venue comment or engine event says how it closed">{DASH}</span>;
  const tone = ended === "venue" ? "warn" : "neutral";
  return (
    <span title={ENDED_TITLE[ended]}>
      <Pill tone={tone}>{ENDED_LABEL[ended]}</Pill>
    </span>
  );
}

export function SideText({ side }: { side: RoundTrip["side"] }) {
  return <span className="whitespace-nowrap text-body">{side === "long" ? "▲ Long" : "▼ Short"}</span>;
}

