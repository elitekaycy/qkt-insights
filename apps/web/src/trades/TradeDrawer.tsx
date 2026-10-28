import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DASH, duration, kindLabel, money, pnl, quantity, signedMoney, sized, toneClass, ts } from "../format";
import { PAGE_PATHS, useSearchParam } from "../router";
import { usePositionPath, useTripDetail, type RoundTripDetail, type Slippage, type TimelineStep } from "./data";
import { latency, legCosts, preciseClock, px, rMultiple, tripInstrument } from "./format";
import { EndedBadge, SideText } from "./bits";
import { PositionMap } from "./PositionMap";

/*
 * One round trip in full, opened from any list of trades (Trades, a strategy's trades, a
 * calendar day) and deep-linkable as ?trade=<ticket>: what it made, how it was placed and
 * closed step by step with the time between steps, what execution cost against the price the
 * engine expected, the venue's own deals, and the raw events behind it all.
 */

const X = "M18 6L6 18M6 6l12 12";
const UP = "M18 15l-6-6-6 6";
const DOWN = "M6 9l6 6 6-6";
const LINK = "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71";

function IconButton({ label, d, onClick, disabled }: { label: string; d: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-hover hover:text-bright disabled:opacity-35 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
    </button>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{title}</h3>
        {hint && <span className="ml-auto text-[11px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm text-bright">{children}</div>
    </div>
  );
}

function SlippageLine({ label, s, digits }: { label: string; s: Slippage | null; digits: number }) {
  if (!s) return <Stat label={label}><span className="text-faint">{DASH}</span></Stat>;
  // points are against the trade: positive filled worse than expected
  const pts = Number(Math.abs(s.points).toFixed(digits));
  return (
    <Stat label={label} title={`Filled ${px(s.fill, digits)} against the ${s.basis} ${px(s.reference, digits)}`}>
      {pts === 0 ? (
        <span className="text-body">at the {s.basis}</span>
      ) : (
        <>
          <span className={toneClass(-s.points, 6)}>
            {px(pts, digits)} pts {s.points > 0 ? "worse" : "better"}
          </span>
          {s.money != null && <span className={`ml-1.5 ${toneClass(-s.money)}`}>{signedMoney(-s.money)}</span>}
          <span className="ml-1.5 text-xs text-faint">vs {s.basis}</span>
        </>
      )}
    </Stat>
  );
}

const KIND_DOT: Record<string, string> = {
  signal: "bg-accent-hi", decision: "bg-faint", submit: "bg-accent-hi", accepted: "bg-ok", rejected: "bg-danger", cancelled: "bg-warn",
  modified: "bg-warn", fill: "bg-ok", deal: "bg-bright", closed: "bg-ok", bot: "bg-warn",
};

function Timeline({ steps }: { steps: TimelineStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-muted">No engine events or venue deals for this round trip.</p>;
  return (
    <ol className="relative">
      {steps.map((s, i) => (
        <li key={`${s.ts}-${i}`} className="relative grid grid-cols-[6.5rem_1rem_1fr] gap-2 pb-3 last:pb-0">
          <div className="text-right font-mono text-[11px] leading-5 text-muted">
            {preciseClock(s.ts)}
            {s.sinceMs != null && <div className="text-faint">{latency(s.sinceMs)}</div>}
          </div>
          <div className="relative flex justify-center">
            {i < steps.length - 1 && <span aria-hidden className="absolute bottom-[-0.75rem] top-3 w-px bg-line-strong" />}
            <span aria-hidden className={`relative mt-1.5 h-2 w-2 rounded-full ${s.source === "venue" ? "ring-2 ring-line-strong" : ""} ${KIND_DOT[s.kind] ?? "bg-faint"}`} />
          </div>
          <div className="min-w-0 leading-5">
            <div className="text-sm text-bright">
              {s.title}
              {s.source === "venue" && <span className="ml-1.5 text-[11px] text-faint">venue time</span>}
            </div>
            {s.detail && <div className="break-words text-xs text-muted">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Legs({ legs, digits }: { legs: RoundTripDetail["legs"]; digits: number }) {
  if (legs.length === 0) return <p className="text-sm text-muted">No venue deals are stored for this position.</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[34rem] text-xs">
        <thead>
          <tr className="text-left">
            {["Deal", "Time (UTC)", "Leg", "Qty", "Price", "Profit", "Costs", "Net"].map((h, i) => (
              <th key={h} className={`eyebrow !text-[10px] px-1 pb-1.5 ${i >= 3 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => {
            const costs = legCosts(l);
            return (
              <tr key={l.dealTicket} className="border-t border-line" title={l.comment ?? undefined}>
                <td className="px-1 py-1.5 font-mono text-faint">{l.dealTicket}</td>
                <td className="whitespace-nowrap px-1 py-1.5 font-mono text-body">{new Date(l.ts).toISOString().slice(0, 19).replace("T", " ")}</td>
                <td className="whitespace-nowrap px-1 py-1.5 text-body">{l.entry} {l.side}</td>
                <td className="px-1 py-1.5 text-right text-body">{quantity(l.qty)}</td>
                <td className="px-1 py-1.5 text-right text-body">{px(l.price, digits)}</td>
                <td className="px-1 py-1.5 text-right text-body">{signedMoney(l.profit)}</td>
                <td className="px-1 py-1.5 text-right text-body" title={costs.parts || undefined}>{signedMoney(costs.total)}</td>
                <td className={`px-1 py-1.5 text-right font-semibold ${toneClass(l.net)}`}>{signedMoney(l.net)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RawEvents({ events }: { events: RoundTripDetail["events"] }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(events, null, 2);
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-body hover:text-bright">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 transition group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M9 18l6-6-6-6" />
        </svg>
        {events.length} raw event{events.length === 1 ? "" : "s"}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard?.writeText(json).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="ml-auto h-7 rounded-md border border-ctl bg-raised px-2.5 text-xs font-medium text-bright hover:bg-well"
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </summary>
      <pre className="mt-3 max-h-80 overflow-auto rounded-lg border border-line bg-ink p-3 font-mono text-[11px] leading-relaxed text-body">{json}</pre>
    </details>
  );
}

function Body({ d, instanceId }: { d: RoundTripDetail; instanceId: string | null }) {
  const t = d.trip;
  return (
    <>
      <PositionMap key={t.id} instanceId={instanceId} ticket={t.id} open={t.status === "open"} digits={t.priceDigits} realized={t.status === "closed" ? t.pnl : null} />
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line px-5 py-4 sm:grid-cols-3">
        <Stat label="Entry (UTC)">{t.entryTs != null ? ts(t.entryTs) : DASH}</Stat>
        <Stat label="Entry price">{px(t.entryPrice, t.priceDigits)}</Stat>
        <Stat label={kindLabel(t.kind) ? `Size · ${kindLabel(t.kind)}` : "Size"}>{sized(t.qty, t.unit, t.contractSize)}</Stat>
        <Stat label="Exit (UTC)">{t.exitTs != null ? ts(t.exitTs) : t.status === "open" ? "still open" : DASH}</Stat>
        <Stat label="Exit price">{px(t.exitPrice, t.priceDigits)}</Stat>
        <Stat label="Held">{t.status === "open" ? DASH : duration(t.holdMs)}</Stat>
        <Stat label="Initial stop">{px(t.stopPrice, t.priceDigits)}</Stat>
        <Stat label="Target">{px(t.targetPrice, t.priceDigits)}</Stat>
        <Stat label="Risk to the stop" title="What the venue would have paid out at the initial stop">{t.risk == null ? DASH : money(t.risk)}</Stat>
      </div>

      <Section title="Execution" hint="slippage against the price the engine expected">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SlippageLine label="Entry fill" s={d.entrySlippage} digits={t.priceDigits} />
          <SlippageLine label="Exit fill" s={d.exitSlippage} digits={t.priceDigits} />
          <Stat label="Worst open P&L (MAE)" title="Lowest marked P&L while the position was open">
            {d.excursion ? <span className={toneClass(d.excursion.mae)}>{signedMoney(d.excursion.mae)}</span> : <span className="text-faint">not sampled</span>}
          </Stat>
          <Stat label="Best open P&L (MFE)" title="Highest marked P&L while the position was open">
            {d.excursion ? (
              <>
                <span className={toneClass(d.excursion.mfe)}>{signedMoney(d.excursion.mfe)}</span>
                <span className="ml-1.5 text-xs text-faint">{d.excursion.marks} marks</span>
              </>
            ) : (
              <span className="text-faint">not sampled</span>
            )}
          </Stat>
        </div>
      </Section>

      <Section title="Timeline" hint="engine clock, venue deals at venue time · gap since the step before">
        <Timeline steps={d.timeline} />
      </Section>

      <Section title="Venue deals" hint={`${d.legs.length} leg${d.legs.length === 1 ? "" : "s"}`}>
        <Legs legs={d.legs} digits={t.priceDigits} />
      </Section>

      <Section title="Raw events">
        <RawEvents events={d.events} />
      </Section>
    </>
  );
}

/**
 * The drawer for `?trade=<id>`. `order` is the list it was opened from, so the arrows (and j/k
 * on the list) step through neighbouring trades without closing it.
 */
export function TradeDrawer({ instanceId, order = [] }: { instanceId: string | null; order?: string[] }) {
  const [id, setId] = useSearchParam("trade");
  const detail = useTripDetail(instanceId, id || null);
  const panel = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const open = !!id;

  useEffect(() => {
    if (!open) return;
    // capture: Escape closes the drawer before a dialog under it sees the key
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setId("");
      }
    };
    window.addEventListener("keydown", onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setId]);

  const t = detail.data?.trip;
  // an open position has nothing realized yet: the header shows its floating P&L at the latest mark
  const live = usePositionPath(instanceId, t?.status === "open" && t.pnl == null ? id : null, null, true);
  const lastMark = live.data?.ticket === id ? live.data.last : null;
  const floating = lastMark ? lastMark.pnl + (lastMark.swap ?? 0) : null;

  if (!open) return null;
  const at = order.indexOf(id);
  const step = (n: number) => {
    const next = order[at + n];
    if (next) setId(next, { push: false });
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-scrim" onClick={() => setId("")} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t ? `Round trip ${tripInstrument(t)} ${t.side}` : "Round trip"}
        tabIndex={-1}
        className="sheet-in pad-safe-bottom absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-card border border-line-strong bg-panel shadow-pop outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(40rem,94vw)] sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <header className="shrink-0 border-b border-line px-5 pb-4 pt-3">
          <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-well sm:hidden" />
          <div className="flex items-center gap-1">
            <span className="eyebrow">Round trip</span>
            <span className="ml-2 truncate font-mono text-xs text-faint">{t ? `#${t.id}` : ""}</span>
            <span className="ml-auto flex items-center">
              {order.length > 1 && (
                <>
                  <IconButton label="Previous trade (k)" d={UP} onClick={() => step(-1)} disabled={at <= 0} />
                  <IconButton label="Next trade (j)" d={DOWN} onClick={() => step(1)} disabled={at < 0 || at >= order.length - 1} />
                </>
              )}
              <IconButton
                label={copied ? "Link copied" : "Copy a link to this trade"}
                d={LINK}
                onClick={() => {
                  // the Trades page opens any trade, wherever it was found
                  const link = new URL(PAGE_PATHS.trades, window.location.origin);
                  if (instanceId) link.searchParams.set("i", instanceId);
                  link.searchParams.set("trade", id);
                  void navigator.clipboard?.writeText(link.toString()).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              />
              <IconButton label="Close (Esc)" d={X} onClick={() => setId("")} />
            </span>
          </div>
          {t ? (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-xl font-headline text-bright">{tripInstrument(t)}</h2>
                <SideText side={t.side} />
                <EndedBadge ended={t.ended} open={t.status === "open"} />
                <span className="text-sm text-muted">{t.strategyId ?? "unattributed"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                {t.pnl == null && floating != null ? (
                  <span className={`text-3xl font-headline ${toneClass(floating)}`}>{pnl(floating)}</span>
                ) : (
                  <span className={`text-3xl font-headline ${toneClass(t.pnl)}`}>{t.pnl == null ? (t.status === "open" ? "open" : DASH) : pnl(t.pnl)}</span>
                )}
                <span className={`text-base font-semibold ${t.r == null ? "text-faint" : toneClass(t.r)}`} title="P&L over the money at risk to the initial stop">
                  {t.r == null ? (t.status === "open" ? "" : "no stop, so no R") : rMultiple(t.r)}
                </span>
                {t.status === "closed" && <span className="text-sm text-muted">held {duration(t.holdMs)}</span>}
              </div>
              <div className="mt-1 text-xs text-faint">
                {t.pnl == null && floating != null && lastMark
                  ? `Floating at the latest venue mark, ${preciseClock(lastMark.ts).slice(0, 8)} UTC, including swap; nothing realized yet.`
                  : `Realized after commission, swap and fees${t.legs > 0 ? `, from ${t.legs} venue deal${t.legs === 1 ? "" : "s"}` : ""}.`}
              </div>
            </>
          ) : (
            <div className="mt-3 h-14 animate-pulse rounded bg-raised" />
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4">
          {detail.isError ? (
            <div className="px-5 text-sm text-loss">This round trip could not be loaded{detail.error instanceof Error && /404/.test(detail.error.message) ? ": it is not on this instance" : ""}.</div>
          ) : detail.data ? (
            <Body d={detail.data} instanceId={instanceId} />
          ) : (
            <div className="space-y-3 px-5">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-5 animate-pulse rounded bg-raised" />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function useOpenTrade(): [string, (id: string) => void] {
  const [id, setId] = useSearchParam("trade");
  return [id, (next: string) => setId(next, { push: !id })];
}
