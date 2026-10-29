import type { ReactNode } from "react";
import { GLOSSARY, legInstrument, TYPE_LABEL, TYPE_SHORT, type CostKind, type InstrumentType, type Leg } from "../instruments";
import { Popover } from "./ui";

/*
 * What a position is, shown the same way everywhere: a quiet badge with the type's name and, on hover
 * or tap, what that type is and what holding it costs (instruments.ts GLOSSARY). In dense rows,
 * which open a drawer on click, the badge explains itself through its tooltip instead.
 */

const BADGE = "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-md border border-line bg-raised px-1.5 text-[10.5px] font-medium text-body";

/**
 * The type's name in a badge; `explain` adds the glossary on hover or tap, otherwise its tooltip carries it.
 * `short` names it in a word or two for dense tables.
 */
export function TypeBadge({ type, explain = false, short = false }: { type: InstrumentType | null | undefined; explain?: boolean; short?: boolean }) {
  if (!type) return null;
  const g = GLOSSARY[type];
  if (!explain) return <span className={BADGE} title={`${g.term}: ${g.text}`}>{short ? TYPE_SHORT[type] : TYPE_LABEL[type]}</span>;
  return (
    <Popover hover label={`What a ${g.term} is`} trigger={<span className={`${BADGE} cursor-help`}>{TYPE_LABEL[type]}</span>}>
      <p className="font-medium text-bright">{g.term}</p>
      <p className="mt-1">{g.text}</p>
    </Popover>
  );
}

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

/** A strategy's legs: "Stock CFD · AAPL · Exness" for each, the type explained on hover or tap. */
export function LegList({ legs, max = legs.length, explain = true, className = "" }: { legs: readonly Leg[]; max?: number; explain?: boolean; className?: string }) {
  if (legs.length === 0) return null;
  const shown = legs.slice(0, max);
  return (
    <ul className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs ${className}`} aria-label="What it trades">
      {shown.map((l) => (
        <li key={l.symbol} className="flex min-w-0 items-center gap-1.5">
          <TypeBadge type={l.type} explain={explain} />
          {!l.type && <span className="text-faint" title="qkt has not stated this instrument's type">type not stated ·</span>}
          <span className="truncate font-medium text-bright" title={l.symbol}>{legInstrument(l)}</span>
          {l.venue && <span className="shrink-0 text-muted">· {l.venue}</span>}
        </li>
      ))}
      {legs.length > shown.length && <li className="text-muted">+{legs.length - shown.length} more</li>}
    </ul>
  );
}
