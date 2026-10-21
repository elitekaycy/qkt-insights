import type { ReactNode } from "react";
import type { LivePositionRow } from "../api";
import { DASH, duration, human, instrumentOf, openPnl, price, quantity } from "../format";
import { positionRisks } from "../home";
import { Link, useRoute } from "../router";
import { Card, Cell, FlashValue, Freshness, Pill, Pnl, RowChevron, SideTag } from "./ui";

/*
 * Open positions with what each one risks: the stop and take-profit levels, the money between the
 * price now and the stop, and its floating P&L with swap. Strategy names open the strategy page;
 * the ticket opens the position in the trades drawer.
 */

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
  const held = (p: LivePositionRow) => (p.openedAt ? <span title={`opened ${human(p.openedAt)}`}>{duration(now - p.openedAt)}</span> : DASH);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-body">Open positions</h2>
        <span className="text-xs text-muted">venue-marked · to stop = money from the price now to the stop · floating incl. swap</span>
        {freshness && <Freshness at={freshness.at} stale={freshness.stale} className="ml-auto" />}
      </div>
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
                {positions.map((p) => (
                  <tr
                    key={p.ticket}
                    tabIndex={0}
                    aria-label={`Open position ${p.ticket} in Trades`}
                    onClick={() => openTicket(p)}
                    onKeyDown={(e) => { if (e.key === "Enter") openTicket(p); }}
                    className="group cursor-pointer border-b border-line text-bright transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-hi"
                  >
                    <Cell>
                      <div className="font-semibold">{instrumentOf(p.symbol)}</div>
                      {ticket(p)}
                    </Cell>
                    <Cell><SideTag side={p.side} /></Cell>
                    <Cell className="text-right">{quantity(p.qty)}</Cell>
                    <Cell className="text-right text-muted">{price(p.entryPrice)}</Cell>
                    <Cell className="text-right">{price(p.currentPrice)}</Cell>
                    <Cell className="text-right text-muted">{level(p.stopLoss)}</Cell>
                    <Cell className="text-right text-muted">{level(p.takeProfit)}</Cell>
                    <Cell className="text-right">{toStop(p)}</Cell>
                    <Cell className="text-right font-semibold">
                      <FlashValue value={openPnl(p)}><Pnl value={openPnl(p)} glyphs={false} /></FlashValue>
                    </Cell>
                    <Cell className="whitespace-nowrap text-right text-muted">{held(p)}</Cell>
                    <Cell>{strategy(p)}</Cell>
                    <td className="pr-2"><RowChevron /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line @3xl:hidden">
            {positions.map((p) => (
              <li
                key={p.ticket}
                tabIndex={0}
                onClick={() => openTicket(p)}
                onKeyDown={(e) => { if (e.key === "Enter") openTicket(p); }}
                className="group cursor-pointer px-4 py-3 text-sm tabular-nums transition-colors hover:bg-hover active:bg-press"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-bright">{instrumentOf(p.symbol)}</span>
                  <SideTag side={p.side} />
                  <span className="text-muted">{quantity(p.qty)}</span>
                  <span className="ml-auto font-semibold"><Pnl value={openPnl(p)} glyphs={false} /></span>
                  <RowChevron className="self-center" />
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                  <Pair k="Entry" v={price(p.entryPrice)} />
                  <Pair k="Now" v={price(p.currentPrice)} />
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
