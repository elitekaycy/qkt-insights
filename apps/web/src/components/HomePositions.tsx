import { useState, type ReactNode } from "react";
import type { LivePositionRow } from "../api";
import { DASH, duration, human, instrumentOf, openPnl, price, quantity } from "../format";
import { positionRisks } from "../home";
import { instrumentType, sizeInWords, TYPE_LABEL, type InstrumentType } from "../instruments";
import { TypeBadge } from "./InstrumentType";
import { Link, useRoute } from "../router";
import { Card, Cell, FlashValue, Freshness, Pill, Pnl, RowChevron, SideTag } from "./ui";

/*
 * Open positions with what each one risks: the stop and take-profit levels, the money between the
 * price now and the stop, and its floating P&L with swap. Strategy names open the strategy page;
 * the ticket opens the position in the trades drawer.
 */

const NO_MARK = "the venue sends no mark for this position: no price now and no floating P&L; its floating is only in the account's equity";
const HEAD = ["Instrument", "Side", "Size", "Entry", "Current", "SL", "TP", "To stop", "Floating", "Held", "Strategy"];

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
  const toStop = (p: LivePositionRow) => {
    const r = risks.get(p.ticket)!;
    if (r.noStop) return <Pill tone="warn">no stop</Pill>;
    return r.toStop == null ? <span className="text-faint" title="no price move yet to value one point">{DASH}</span> : <Pnl value={r.toStop} glyphs={false} />;
  };
  const strategy = (p: LivePositionRow) =>
    p.strategyId ? (
      <Link to={`/s/${encodeURIComponent(p.strategyId)}`} from="Home" onClick={(e) => e.stopPropagation()} className="text-bright underline-offset-2 hover:underline" title={p.strategyId}>
        {strategyName(p.strategyId)}
      </Link>
    ) : (
      <Pill>unattributed</Pill>
    );
  const ticket = (p: LivePositionRow) => (
    <span className="font-mono text-[11px] text-faint">#{p.ticket}</span>
  );
  const held = (p: LivePositionRow) => (p.openedAt
    ? <span title={`opened ${human(p.openedAt)}`}>{duration(now - p.openedAt)}</span>
    : <span className="text-faint" title="the venue reports no open time for this position">{DASH}</span>);
  // a venue that marks no position (the gateway's paper adapter) sends no price or floating: unknown, never 0.00
  const current = (p: LivePositionRow) => (p.currentPrice != null ? price(p.currentPrice) : <span className="text-faint" title={NO_MARK}>{DASH}</span>);
  const floating = (p: LivePositionRow) => (p.profit != null
    ? <FlashValue value={openPnl(p)}><Pnl value={openPnl(p)} glyphs={false} /></FlashValue>
    : <span className="text-xs font-normal text-faint" title={NO_MARK}>no mark</span>);
  const typeOf = (p: LivePositionRow) => instrumentType(p.kind, p.category);
  const [picked, setPicked] = useState<InstrumentType | null>(null);
  const shown = picked ? positions.filter((p) => typeOf(p) === picked) : positions;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-body">Open positions</h2>
        <span className="text-xs text-muted">venue-marked · to stop = money from the price now to the stop · floating incl. swap</span>
        {freshness && <Freshness at={freshness.at} stale={freshness.stale} className="ml-auto" />}
      </div>
      <TypeFilter types={positions.map(typeOf)} picked={picked} onPick={setPicked} />
      {positions.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">Flat: no open positions.</div>
      ) : (
        <div className="@container">
          <div className="hidden @3xl:block">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-left">
                  {HEAD.map((h) => (
                    <th key={h} className={`eyebrow whitespace-nowrap px-3 py-2 ${h === "Instrument" || h === "Side" || h === "Strategy" ? "" : "text-right"}`}>{h}</th>
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
                    <Cell>
                      <div className="flex items-center gap-1.5 font-semibold">{instrumentOf(p.symbol)}<TypeBadge type={typeOf(p)} short /></div>
                      {ticket(p)}
                    </Cell>
                    <Cell><SideTag side={p.side} /></Cell>
                    <Cell className="text-right">
                      <span title={sizeInWords(p.qty, p)}>{quantity(p.qty)}</span>
                      {p.unit && <div className="text-[10px] text-muted">{p.unit}</div>}
                    </Cell>
                    <Cell className="text-right text-muted">{price(p.entryPrice)}</Cell>
                    <Cell className="text-right">{current(p)}</Cell>
                    <Cell className="text-right text-muted">{level(p.stopLoss)}</Cell>
                    <Cell className="text-right text-muted">{level(p.takeProfit)}</Cell>
                    <Cell className="text-right">{toStop(p)}</Cell>
                    <Cell className="text-right font-semibold">{floating(p)}</Cell>
                    <Cell className="whitespace-nowrap text-right text-muted">{held(p)}</Cell>
                    <Cell>{strategy(p)}</Cell>
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
                  <span className="font-semibold text-bright">{instrumentOf(p.symbol)}</span>
                  <TypeBadge type={typeOf(p)} short />
                  <SideTag side={p.side} />
                  <span className="min-w-0 truncate text-muted">{sizeInWords(p.qty, p)}</span>
                  <span className="ml-auto font-semibold">{floating(p)}</span>
                  <RowChevron className="self-center" />
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                  <Pair k="Entry" v={price(p.entryPrice)} />
                  <Pair k="Now" v={current(p)} />
                  <Pair k="Held" v={held(p)} />
                  <Pair k="SL" v={level(p.stopLoss)} />
                  <Pair k="TP" v={level(p.takeProfit)} />
                  <Pair k="To stop" v={toStop(p)} />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">{strategy(p)}</span>
                  {ticket(p)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Pair({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-faint">{k}</div>
      <div className="truncate text-body">{v}</div>
    </div>
  );
}

/** Shared links show how many positions are open and their P&L, never what or where they are. */
export function PublicOpenPositions({ summary }: { summary: { count: number; unrealized: number | null } | null }) {
  const count = summary?.count ?? 0;
  return (
    <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-4 py-3">
      <h2 className="text-sm font-medium text-body">Open positions</h2>
      <span className="text-xl font-headline text-bright">{count}</span>
      <Pnl value={summary?.unrealized ?? null} className="text-xl font-headline" />
      <span className="text-xs text-muted">floating incl. swap · details stay private until each position closes</span>
    </Card>
  );
}

/** One chip per type among the open positions, with its count; shown once there are two kinds to tell apart. */
function TypeFilter({ types, picked, onPick }: {
  types: Array<InstrumentType | null>; picked: InstrumentType | null; onPick: (t: InstrumentType | null) => void;
}) {
  const counts = new Map<InstrumentType, number>();
  for (const t of types) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  const unknown = types.filter((t) => t == null).length;
  if (counts.size + (unknown > 0 ? 1 : 0) < 2) return null;
  const chip = (label: string, on: boolean, click: () => void, key: string) => (
    <button key={key} type="button" aria-pressed={on} onClick={click}
      className={`h-7 shrink-0 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition ${on ? "border-accent-hi/50 bg-accent-soft text-bright" : "border-line bg-raised text-body hover:bg-hover"}`}>
      {label}
    </button>
  );
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2" role="group" aria-label="Show positions of one type">
      {chip(`All ${types.length}`, picked == null, () => onPick(null), "all")}
      {[...counts].map(([t, n]) => chip(`${TYPE_LABEL[t]} ${n}`, picked === t, () => onPick(picked === t ? null : t), t))}
    </div>
  );
}

