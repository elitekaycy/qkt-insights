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

/**
 * A strategy's legs on one line for a card: the first leg's instrument and venue ("XAUUSD · Exness"), then "+1 more";
 * every leg in full (type included, or that qkt did not state it) on hover.
 */
export function LegLine({ legs, className = "" }: { legs: readonly Leg[]; className?: string }) {
  if (legs.length === 0) return null;
  const first = legs[0]!;
  const title = legs.map((l) => `${l.type ? TYPE_LABEL[l.type] : "type not stated"} ${legInstrument(l)}${l.venue ? ` · ${l.venue}` : ""}`).join("\n");
  return (
    <div className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs ${className}`} title={title} aria-label={`What it trades: ${title.replace(/\n/g, "; ")}`}>
      <span className="shrink-0 font-medium text-bright">{legInstrument(first)}</span>
      {first.venue && <span className="min-w-0 truncate text-muted">· {first.venue}</span>}
      {legs.length > 1 && <span className="shrink-0 text-muted">+{legs.length - 1} more</span>}
    </div>
  );
}

/**
 * A strategy's legs as one line for its page: each instrument with its short type ("Perp BTC_USDC_PERPETUAL ·
 * Option BTC 80500 call, 29 Oct"), then the venues once ("· Paper (Deribit prices)"). Each leg in full on hover.
 */
export function LegSummary({ legs, className = "" }: { legs: readonly Leg[]; className?: string }) {
  if (legs.length === 0) return null;
  const venues = [...new Set(legs.map((l) => l.venue).filter((v): v is string => !!v))];
  return (
    <p className={`text-sm ${className}`} aria-label="What it trades">
      {legs.map((l, i) => (
        <span key={l.symbol} title={`${l.type ? TYPE_LABEL[l.type] : "type not stated"} · ${l.symbol}`}>
          {i > 0 && <span className="text-muted"> · </span>}
          {l.type && <span className="text-muted">{TYPE_SHORT[l.type]} </span>}
          <span className="font-medium text-bright">{legInstrument(l)}</span>
        </span>
      ))}
      {venues.length > 0 && <span className="text-muted"> · {venues.join(", ")}</span>}
    </p>
  );
}
