import { DASH } from "../format";
import { Pill } from "../components/ui";
import type { RoundTrip } from "./data";
import { ENDED_LABEL, ENDED_TITLE } from "./format";

export function EndedBadge({ ended, open }: { ended: RoundTrip["ended"]; open?: boolean }) {
  if (open) return <Pill tone="info">open</Pill>;
  if (!ended) return <span className="text-faint" title="No venue comment or engine event says how it closed">{DASH}</span>;
  const tone = ended === "stop" ? "bad" : ended === "tp" ? "ok" : ended === "venue" ? "warn" : "neutral";
  return (
    <span title={ENDED_TITLE[ended]}>
      <Pill tone={tone}>{ENDED_LABEL[ended]}</Pill>
    </span>
  );
}

export function SideText({ side }: { side: RoundTrip["side"] }) {
  return <span className="whitespace-nowrap text-body">{side === "long" ? "▲ Long" : "▼ Short"}</span>;
}

