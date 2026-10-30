import { useState } from "react";
import type { LivePositionRow } from "../api";
import { DASH, duration, human, openPnl, price, quantity } from "../format";
import { positionRisks } from "../home";
import { instrumentType, shortInstrument, sizeInWords, TYPE_LABEL, type InstrumentType } from "../instruments";
import { Link, useRoute, useSearchParam } from "../router";
import { Card, Cell, FlashValue, Freshness, Pill, Pnl, RowChevron, Select, SideWord } from "./ui";

/*
 * Open positions with what each one risks: the money between the price now and the stop, and its floating P&L with
 * swap. One line per position; its type, full symbol, entry, price now and levels are on the symbol's tooltip and in
 * the trades drawer a row opens.
 */

const NO_MARK = "No price from the venue";
/** Each column, with what it means on hover where the header alone does not say it. */
const HEAD: ReadonlyArray<{ label: string; right?: boolean; title?: string }> = [
  { label: "Symbol", title: "Hover a symbol for its type, entry, price now, stop and target" },
  { label: "Strategy" },
  { label: "Side" },
  { label: "Size", right: true, title: "Hover a size for it in words; the unit is in the header when every position shares one" },
  { label: "Floating", right: true, title: "Open P&L as the venue marks it, swap included" },
  { label: "To stop", right: true, title: "Money from the price now to the stop, if it filled there" },
  { label: "Held", right: true },
];

export function OpenPositions({ positions, strategyName, now, freshness }: {
  positions: LivePositionRow[];
  strategyName: (id: string) => string;
  now: number;
  /** When the venue last reported the positions, and whether that is too long ago. */
  freshness: { at: number; stale: boolean } | null;
}) {
  const risks = positionRisks(positions);
  const { navigate } = useRoute();
  const openTicket = (p: LivePositionRow) => navigate(`/t?trade=${encodeURIComponent(p.ticket)}`, { from: "Home" });
  const level = (v: number | undefined) => (v != null && v > 0 ? price(v) : DASH);
  const details = (p: LivePositionRow) => {
    const type = typeOf(p);
    return [type ? TYPE_LABEL[type] : null, p.symbol, `entry ${price(p.entryPrice)}`, `now ${p.currentPrice != null ? price(p.currentPrice) : DASH}`, `stop ${level(p.stopLoss)}`, `target ${level(p.takeProfit)}`, sizeInWords(p.qty, p)].filter(Boolean).join(" · ");
  };
  const toStop = (p: LivePositionRow) => {
    const r = risks.get(p.ticket)!;
    if (r.noStop) return <Pill tone="warn">No stop</Pill>;
    return r.toStop == null ? <span className="text-muted" title="no price move yet to value one point">{DASH}</span> : <Pnl value={r.toStop} />;
  };
  const strategy = (p: LivePositionRow) =>
    p.strategyId ? (
      <Link to={`/s/${encodeURIComponent(p.strategyId)}`} from="Home" onClick={(e) => e.stopPropagation()} className="text-bright underline-offset-2 hover:underline" title={p.strategyId}>
        {strategyName(p.strategyId)}
      </Link>
    ) : (
      <span className="text-muted">unattributed</span>
    );
  const held = (p: LivePositionRow) => (p.openedAt
    ? <span title={`opened ${human(p.openedAt)}`}>{duration(now - p.openedAt)}</span>
    : <span className="text-muted" title="the venue reports no open time for this position">{DASH}</span>);
  // a venue that marks no position (the gateway's paper adapter) sends no floating: unknown, never 0.00
  const floating = (p: LivePositionRow) => (p.profit != null
    ? <FlashValue value={openPnl(p)}><Pnl value={openPnl(p)} /></FlashValue>
    : <span className="whitespace-nowrap font-normal text-muted" title={NO_MARK}>{DASH}</span>);
  const typeOf = (p: LivePositionRow) => instrumentType(p.kind, p.category);
  const [picked, setPicked] = useState<InstrumentType | "">("");
  // "?pos=nostop" (Home's attention line links it) lists only the positions without a stop
  const [only, setOnly] = useSearchParam("pos");
  const noStop = only === "nostop";
  // a unit every position shares is said once, in the header; otherwise each size says it on hover
  const unit = positions.length > 0 && positions.every((p) => p.unit && p.unit === positions[0]!.unit) ? positions[0]!.unit : null;
  const shown = positions.filter((p) => (!picked || typeOf(p) === picked) && (!noStop || risks.get(p.ticket)!.noStop));

  return (
    <Card className="scroll-mt-4 overflow-hidden">
      <div id="home-positions" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-medium text-bright">Open positions</h2>
        {noStop && (
          <button type="button" onClick={() => setOnly("")} className="inline-flex items-center gap-1 rounded-full border border-warn/45 px-2 text-xs font-medium text-warn hover:bg-hover" title="Show every position">
            without a stop ×
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {freshness && <Freshness at={freshness.at} stale={freshness.stale} quiet />}
          <TypeFilter types={positions.map(typeOf)} picked={picked} onPick={setPicked} />
        </span>
      </div>
      {positions.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">No open trades.</div>
      ) : (
        <div className="@container">
          <div className="hidden @3xl:block">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-left">
                  {HEAD.map((h) => (
                    <th key={h.label} title={h.title} className={`eyebrow whitespace-nowrap px-3 py-2 @3xl:px-4 ${h.right ? "text-right" : ""}`}>{h.label === "Size" && unit ? `Size (${unit})` : h.label}</th>
                  ))}
                  <th className="w-8" aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr
                    key={p.ticket}
                    tabIndex={0}
                    aria-label={`Open position ${p.ticket} in Trades`}
                    onClick={() => openTicket(p)}
                    onKeyDown={(e) => { if (e.key === "Enter") openTicket(p); }}
                    className="group cursor-pointer border-b border-line text-bright transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-hi"
                  >
                    <Cell><span className="whitespace-nowrap font-medium" title={details(p)}>{shortInstrument(p.symbol, typeOf(p))}</span></Cell>
                    <Cell className="max-w-[14rem] truncate">{strategy(p)}</Cell>
                    <Cell><SideWord side={p.side} /></Cell>
                    <Cell className="text-right font-mono"><span title={sizeInWords(p.qty, p)}>{quantity(p.qty)}</span></Cell>
                    <Cell className="text-right font-mono">{floating(p)}</Cell>
                    <Cell className="text-right font-mono">{toStop(p)}</Cell>
                    <Cell className="whitespace-nowrap text-right font-mono text-muted">{held(p)}</Cell>
                    <td className="pr-2"><RowChevron /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line @3xl:hidden">
            {shown.map((p) => (
              <li
                key={p.ticket}
                tabIndex={0}
                onClick={() => openTicket(p)}
                onKeyDown={(e) => { if (e.key === "Enter") openTicket(p); }}
                className="group cursor-pointer px-4 py-3 text-sm tabular-nums transition-colors hover:bg-hover active:bg-press"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate font-medium text-bright" title={details(p)}>{shortInstrument(p.symbol, typeOf(p))}</span>
                  <span className="ml-auto shrink-0 font-mono">{floating(p)}</span>
                  <RowChevron className="self-center" />
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                  <span className="min-w-0 truncate">{p.strategyId ? strategyName(p.strategyId) : "unattributed"}</span>
                  <SideWord side={p.side} />
                  <span className="ml-auto shrink-0 font-mono">{toStop(p)}</span>
                  <span className="shrink-0 font-mono">{held(p)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Shared links show how many positions are open and their P&L, never what or where they are. */
export function PublicOpenPositions({ summary }: { summary: { count: number; unrealized: number | null } | null }) {
  const count = summary?.count ?? 0;
  return (
    <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-4 py-3">
      <h2 className="text-sm font-medium text-bright">Open positions</h2>
      <span className="text-xl font-headline text-bright">{count}</span>
      <Pnl value={summary?.unrealized ?? null} className="text-xl font-headline" />
      <span className="text-xs text-muted">floating incl. swap · details stay private until each position closes</span>
    </Card>
  );
}

/** The open positions' types as one quiet select, with counts; shown once there are two kinds to tell apart. */
function TypeFilter({ types, picked, onPick }: {
  types: Array<InstrumentType | null>; picked: InstrumentType | ""; onPick: (t: InstrumentType | "") => void;
}) {
  const counts = new Map<InstrumentType, number>();
  for (const t of types) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (counts.size < 2) return null;
  return (
    <Select aria-label="Show positions of one type" value={picked} onChange={(e) => onPick(e.target.value as InstrumentType | "")}>
      <option value="">All types · {types.length}</option>
      {[...counts].map(([t, n]) => <option key={t} value={t}>{TYPE_LABEL[t]} · {n}</option>)}
    </Select>
  );
}
