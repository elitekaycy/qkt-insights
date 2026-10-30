import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DASH, duration, signedMoney, toneClass } from "../format";
import { instrumentType, shortInstrument, sizeInWords } from "../instruments";
import { IconButton } from "../components/ui";
import { EndedWord } from "./bits";
import type { RoundTrip } from "./data";
import { minuteStamp, px, rMultiple } from "./format";

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-sm last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-bright">{children}</dd>
    </div>
  );
}

/**
 * One trade on a shared link, from its table row: what the row's tooltip says, for a viewer on a touch screen.
 * A shared link has no trade route, so there is no chart or story here.
 */
export function TradeSheet({ trip: t, strategy, onClose }: { trip: RoundTrip; strategy: string | null; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const open = t.status === "open";
  const name = shortInstrument(t.instrument, instrumentType(t.kind, t.category));
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Trade ${name}`}
        tabIndex={-1}
        className="sheet-in pad-safe-bottom absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-auto rounded-t-card border border-line-strong bg-panel px-5 pb-4 pt-3 shadow-pop outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(24rem,94vw)] sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium text-bright">{name} <span className="font-normal text-muted">{t.side === "long" ? "Long" : "Short"}</span></h2>
          <span className="ml-auto"><IconButton label="Close" d="M18 6L6 18M6 6l12 12" onClick={onClose} /></span>
        </div>
        <dl className="mt-2">
          {strategy && <Line label="Strategy">{strategy}</Line>}
          <Line label="Size">{sizeInWords(t.qty, t)}</Line>
          <Line label="P&L">{open ? <span className="text-muted">open</span> : <span className={`font-medium ${toneClass(t.pnl)}`}>{signedMoney(t.pnl)}</span>}</Line>
          <Line label="Entry">{px(t.entryPrice, t.priceDigits)}</Line>
          <Line label="Opened (UTC)">{minuteStamp(t.entryTs)}</Line>
          <Line label="Exit">{open ? DASH : px(t.exitPrice, t.priceDigits)}</Line>
          <Line label="Closed (UTC)">{open || t.exitTs == null ? DASH : minuteStamp(t.exitTs)}</Line>
          <Line label="R">{t.r != null ? rMultiple(t.r) : DASH}</Line>
          <Line label="Held">{open ? DASH : duration(t.holdMs)}</Line>
          <Line label="Ended">{open ? "Still open" : <EndedWord ended={t.ended} />}</Line>
        </dl>
      </div>
    </div>,
    document.body,
  );
}
