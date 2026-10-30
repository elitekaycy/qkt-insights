import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DASH, duration, money, pnl, quantity, signedMoney, toneClass, ts, tsShort } from "../format";
import { CostTerm } from "../components/InstrumentType";
import { sizeInWords, type CostKind } from "../instruments";
import { PAGE_PATHS, useSearchParam } from "../router";
import { usePositionPath, useTripDetail, type RoundTripDetail, type Slippage, type TimelineStep } from "./data";
import { latency, legCosts, preciseClock, px, rMultiple, tradeStory, tripInstrument } from "./format";
import { PositionMap } from "./PositionMap";
import { useStrategyNames } from "../hooks/useStrategies";

/*
 * One trade, opened from any list of trades (Trades, a strategy's trades, a calendar day, Home's positions) and
 * deep-linkable as ?trade=<ticket>. It tells one story: what it is and what it made, then opened, stop and target,
 * closed; then how the price moved; everything else (ids, fills, the venue's deals, costs, raw events) folded
 * under Details.
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

/** A labelled block inside Details. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-4">
      <h4 className="mb-2 text-sm font-medium text-body">{title}</h4>
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
          <span className="ml-1.5 text-xs text-muted">vs {s.basis}</span>
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
  if (steps.length === 0) return <p className="text-sm text-muted">No engine events for this trade.</p>;
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
              {s.source === "venue" && <span className="ml-1.5 text-[11px] text-muted">venue time</span>}
            </div>
            {s.detail && <div className="break-words text-xs text-muted">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Legs({ legs, digits }: { legs: RoundTripDetail["legs"]; digits: number }) {
  if (legs.length === 0) return <p className="text-sm text-muted">No venue deals stored for this trade.</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[34rem] text-xs">
        <thead>
          <tr className="text-left">
            {["Deal", "Time (UTC)", "Leg", "Qty", "Price", "Profit", "Costs", "Net"].map((h, i) => (
              <th key={h} className={`px-1 pb-1.5 text-[11px] font-normal text-muted ${i >= 3 ? "text-right" : ""}`}>{h}</th>
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
      <CostKinds legs={legs} />
    </div>
  );
}

/** The cost kinds these deals booked, each explained on hover or tap. */
function CostKinds({ legs }: { legs: RoundTripDetail["legs"] }) {
  const booked = (["commission", "swap", "funding", "fee"] as const).filter((k) => legs.some((l) => (l[k] ?? 0) !== 0));
  if (booked.length === 0) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-muted">
      Costs:
      {booked.map((k: CostKind, i) => <span key={k}><CostTerm kind={k} />{i < booked.length - 1 ? "," : ""}</span>)}
    </p>
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
        {events.length} engine event{events.length === 1 ? "" : "s"}
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

/** Opened → stop and target → closed, with the time and price of each step. */
function Story({ t }: { t: RoundTripDetail["trip"] }) {
  const steps = tradeStory(t);
  return (
    <ol className="px-5 py-4" aria-label="What happened">
      {steps.map((s, i) => (
        <li key={s.key} className="relative grid grid-cols-[1rem_1fr_auto] items-baseline gap-x-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden className="absolute bottom-0 left-[0.4375rem] top-4 w-px bg-line-strong" />}
          <span aria-hidden className={`relative h-2.5 w-2.5 translate-y-0.5 rounded-full ${s.key === "opened" ? "bg-accent-hi" : s.key === "closed" ? "bg-bright" : "border-2 border-line-strong bg-panel"}`} />
          <span className="min-w-0">
            <span className="text-sm font-medium text-bright">{s.label}</span>
            {s.price != null && <span className="ml-2 font-mono text-sm tabular-nums text-body">{px(s.price, t.priceDigits)}</span>}
            {s.detail && <span className="ml-2 text-sm text-muted">· {s.detail}</span>}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted">{s.ts != null ? `${tsShort(s.ts)}:${preciseClock(s.ts).slice(6, 8)}` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

function Body({ d, instanceId }: { d: RoundTripDetail; instanceId: string | null }) {
  const t = d.trip;
  return (
    <>
      <Story t={t} />
      <div className="border-t border-line">
        <PositionMap key={t.id} instanceId={instanceId} ticket={t.id} open={t.status === "open"} digits={t.priceDigits} realized={t.status === "closed" ? t.pnl : null} />
      </div>
      <details className="group border-t border-line px-5 py-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-body hover:text-bright">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 transition group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
          Details
        </summary>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-4 sm:grid-cols-3">
          <Stat label="Ticket"><span className="font-mono text-xs">{t.id}</span></Stat>
          <Stat label="Opened (UTC)">{t.entryTs != null ? ts(t.entryTs) : DASH}</Stat>
          <Stat label="Closed (UTC)">{t.exitTs != null ? ts(t.exitTs) : DASH}</Stat>
          <Stat label="Risk to the stop" title="What the venue would have paid out at the initial stop">{t.risk == null ? DASH : money(t.risk)}</Stat>
          <SlippageLine label="Entry fill" s={d.entrySlippage} digits={t.priceDigits} />
          <SlippageLine label="Exit fill" s={d.exitSlippage} digits={t.priceDigits} />
          <Stat label="Worst while open" title="Lowest P&L the venue marked while the trade was open">
            {d.excursion ? <span className={toneClass(d.excursion.mae)}>{signedMoney(d.excursion.mae)}</span> : DASH}
          </Stat>
          <Stat label="Best while open" title="Highest P&L the venue marked while the trade was open">
            {d.excursion ? <span className={toneClass(d.excursion.mfe)}>{signedMoney(d.excursion.mfe)}</span> : DASH}
          </Stat>
        </div>
        <Section title="Venue deals">
          <Legs legs={d.legs} digits={t.priceDigits} />
        </Section>
        <Section title="Engine timeline">
          <Timeline steps={d.timeline} />
        </Section>
        <Section title="Raw events">
          <RawEvents events={d.events} />
        </Section>
      </details>
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
  const open_ = t != null && t.status === "open" && t.pnl == null;
  const strategyName = useStrategyNames(instanceId);

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
        aria-label={t ? `Trade ${tripInstrument(t)} ${t.side}` : "Trade"}
        tabIndex={-1}
        className="sheet-in pad-safe-bottom absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-card border border-line-strong bg-panel shadow-pop outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(40rem,94vw)] sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <header className="shrink-0 border-b border-line px-5 pb-4 pt-3">
          <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-well sm:hidden" />
          <div className="flex items-center gap-1">
            {t ? (
              <h2 className="min-w-0 truncate text-lg font-headline text-bright">
                {tripInstrument(t)} <span className="font-sans text-base font-medium text-body">{t.side === "long" ? "Long" : "Short"} · {sizeInWords(t.qty, t)}</span>
              </h2>
            ) : <span className="h-6 w-40 rounded bg-raised" />}
            <span className="ml-auto flex shrink-0 items-center">
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
              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                {open_ ? (
                  <span className={`text-3xl font-headline ${toneClass(floating)}`} title={lastMark ? `Open, as the venue priced it at ${preciseClock(lastMark.ts).slice(0, 8)} UTC (swap included)` : undefined}>{floating == null ? DASH : pnl(floating)}</span>
                ) : (
                  <span className={`text-3xl font-headline ${toneClass(t.pnl)}`} title="After commission, swap and fees">{pnl(t.pnl)}</span>
                )}
                {t.r != null && <span className={`text-base font-semibold ${toneClass(t.r)}`} title="P&L over the money at risk to the initial stop">{rMultiple(t.r)}</span>}
              </div>
              <div className="mt-1 text-sm text-muted">
                {open_ ? "Open" : `Held ${duration(t.holdMs)}`}
                {t.strategyId && <> · {strategyName(t.strategyId)}</>}
              </div>
            </>
          ) : (
            <div className="mt-3 h-10 w-32 rounded bg-raised" />
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {detail.isError ? (
            <div className="px-5 text-sm text-loss">This trade could not be loaded{detail.error instanceof Error && /404/.test(detail.error.message) ? ": it is not on this instance" : ""}.</div>
          ) : detail.data ? (
            <Body d={detail.data} instanceId={instanceId} />
          ) : (
            <div className="space-y-3 px-5">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-5 rounded bg-raised" />
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
