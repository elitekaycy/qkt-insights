import type { ReactNode } from "react";
import { GLOSSARY, legsLine, type CostKind, type Leg } from "../instruments";
import { Popover } from "./ui";

/*
 * What a cost means, on hover or tap (instruments.ts GLOSSARY), and what a strategy trades as one short line.
 */

/** A cost's name with its explanation on hover or tap: "Swap", "Funding", ... */
export function CostTerm({ kind, children }: { kind: CostKind; children?: ReactNode }) {
  const g = GLOSSARY[kind];
  return (
    <Popover hover label={`What ${g.term.toLowerCase()} is`} trigger={<span className="cursor-help underline decoration-dotted decoration-from-font underline-offset-2">{children ?? g.term}</span>}>
      <p className="font-medium text-bright">{g.term}</p>
      <p className="mt-1">{g.text}</p>
    </Popover>
  );
}

/**
 * What a strategy trades as one short line, "XAUUSD · Exness" or "BTC perp + options · Paper", cut with an ellipsis
 * when it does not fit; every leg in full (type, instrument, venue) on hover.
 */
export function LegLine({ legs, className = "" }: { legs: readonly Leg[]; className?: string }) {
  if (legs.length === 0) return null;
  const { text, title } = legsLine(legs);
  return (
    <div className={`truncate text-muted ${className}`} title={title} aria-label={`What it trades: ${title.replace(/\n/g, "; ")}`}>
      {text}
    </div>
  );
}
