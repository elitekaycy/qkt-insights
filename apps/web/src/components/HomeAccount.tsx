import type { ReactNode } from "react";
import type { AccountRiskRow, LiveAccount } from "../api";
import { clock, count, DASH, money, pctValue, signedMoney } from "../format";
import { accountToday, dailyMeasured, dailyReferenceLabel, dayBasisLabel, drawdownMeasured, limitUse, type LimitUse, type OpenRisk } from "../home";
import { accountName, maskLogin } from "../accounts";
import { Card, FlashValue, Freshness, InfoIcon, Pill, Pnl, Popover } from "./ui";

/*
 * Home's account strip: what the account has, what today did, what the stops put at risk, and how
 * far each loss limit is. One row per venue account; every figure says its basis.
 */

const ICON = {
  wallet: "M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  gauge: "M12 14l4-4M4 18a9 9 0 1 1 16 0",
};

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** A journal KPI card: icon and label, one headline figure, quiet lines under it. */
export function Kpi({ icon, label, children, sub, className = "" }: { icon: string; label: string; children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <Card className={`min-w-0 p-4 ${className}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted">
        <Glyph d={icon} />
        <span className="truncate">{label}</span>
      </div>
      {/* sized to the card (Card is a container) so a seven-figure balance never clips */}
      <div className="mt-2 truncate font-headline text-[clamp(1rem,12.5cqi,1.5rem)] tabular-nums">{children}</div>
      {sub && <div className="mt-1.5 space-y-0.5 text-xs leading-relaxed text-muted">{sub}</div>}
    </Card>
  );
}

/** Semicircle gauge of a limit's use: blue under 55% (a limit is not P&L), amber to 80%, red beyond; the percent is printed too. */
function Arc({ pct }: { pct: number | null }) {
  const r = 34;
  const half = Math.PI * r;
  const k = pct == null ? 0 : Math.min(1, Math.max(0, pct / 100));
  const tone = pct == null ? "var(--color-faint)" : pct >= 80 ? "var(--color-loss-fill)" : pct >= 55 ? "var(--color-warn)" : "var(--color-accent-hi)";
  return (
    <svg viewBox="0 0 84 48" className="h-7 w-12 shrink-0 sm:h-9 sm:w-16" aria-hidden>
      <path d="M8 44a34 34 0 0 1 68 0" fill="none" stroke="var(--color-raised)" strokeWidth="8" strokeLinecap="round" />
      {k > 0 && <path d="M8 44a34 34 0 0 1 68 0" fill="none" stroke={tone} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${k * half} ${half}`} />}
    </svg>
  );
}

/**
 * One loss limit. With a cap: a gauge of the cap's use. Without one: the measured figure itself
 * (`value`, `measured`) and a quiet note that no limit is set, never an empty gauge.
 */
function LimitGauge({ label, use, value, measured, basis, help }: {
  label: string; use: LimitUse; value: ReactNode; measured: string;
  /** How the figure is measured; null where `measured` already says it. */
  basis: string | null;
  help: string;
}) {
  const info = (
    <Popover label={`How ${label.toLowerCase()} is measured`} align="right" trigger={<InfoIcon className="h-3.5 w-3.5 text-faint hover:text-bright" />}>
      {help}
    </Popover>
  );
  if (use.cap == null) {
    return (
      <Kpi
        icon={ICON.gauge}
        label={label}
        sub={
          <>
            <div>{measured}</div>
            {basis && <div className="text-faint">{basis}</div>}
            <div className="flex items-start gap-1 text-faint">
              <span title={NO_LIMIT_HINT}>no limit set</span>
              {info}
            </div>
          </>
        }
      >
        <span className="text-lg sm:text-xl">{value}</span>
      </Kpi>
    );
  }
  return (
    <Kpi
      icon={ICON.gauge}
      label={label}
      sub={
        <>
          <div className={use.pct != null && use.pct >= 100 ? "font-medium text-loss" : ""}>
            {`${money(use.used)} of ${money(use.cap)}${use.pct != null && use.pct >= 100 ? " · over the limit" : ""}`}
          </div>
          <div className="flex items-start gap-1 text-faint">
            <span>{basis}</span>
            {info}
          </div>
        </>
      }
    >
      <div className="flex items-end gap-2 sm:gap-2.5">
        <Arc pct={use.pct} />
        <span className={`text-lg sm:text-xl ${use.pct == null ? "text-faint" : use.pct >= 80 ? "text-loss" : use.pct >= 55 ? "text-warn" : "text-bright"}`}>
          {use.pct == null ? DASH : pctValue(use.pct, 1)}
        </span>
      </div>
    </Kpi>
  );
}

const NO_LIMIT_HINT = "Set INSIGHTS_ACCOUNT_LIMITS on the collector, or the account caps in the strategies' qkt risk config.";

export function AccountStrip({
  account,
  labels = [account.broker],
  risk,
  realizedToday,
  dayLabel,
  open,
  isPublic,
}: {
  account: LiveAccount;
  /** Every broker label this account reported under, the shown one first. */
  labels?: string[];
  /** The account's risk row (limits, day basis); null before its first rollup. */
  risk: AccountRiskRow | null;
  realizedToday: number;
  /** When the day began, e.g. "day from 22:00 UTC". */
  dayLabel: string;
  /** Open risk over this account's positions; null on shared links, which never show positions. */
  open: OpenRisk | null;
  isPublic: boolean;
}) {
  const today = accountToday(account, realizedToday);
  const use = risk ? limitUse(risk, account.equity) : null;
  const openCount = open ? open.priced + open.noStop + open.unpriced : 0;
  return (
    <section className={account.stale ? "opacity-90" : ""} aria-label={`Account ${accountName(account)}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <span className="font-semibold text-bright" title={accountName(account) === account.broker ? undefined : `last reported by profile ${account.broker}`}>{accountName(account)}</span>
        <Pill>{account.currency}</Pill>
        {!isPublic && account.login && <span className="font-mono text-xs text-faint" title="login, last four digits">#{maskLogin(account.login)}</span>}
        {!isPublic && account.server && <span className="text-xs text-faint">{account.server}</span>}
        {labels.length > 1 && <span className="text-xs text-faint" title="earlier broker labels of this account">also reported as {labels.slice(1).join(", ")}</span>}
        <span className="ml-auto">
          {isPublic ? <span className="text-xs text-muted">as of {clock(account.lastSeen)} UTC</span> : <Freshness at={account.lastSeen} stale={account.stale} />}
        </span>
      </div>
      <div className={`mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 ${open ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>
        <Kpi icon={ICON.wallet} label="Balance" sub={`${account.currency} · closed trades only`}>
          <FlashValue value={account.balance}><span className="text-bright">{money(account.balance)}</span></FlashValue>
        </Kpi>
        <Kpi icon={ICON.pulse} label="Equity" sub={<>floating <Pnl value={account.equity - account.balance} glyphs={false} /></>}>
          <FlashValue value={account.equity}><span className="text-bright">{money(account.equity)}</span></FlashValue>
        </Kpi>
        <Kpi
          icon={ICON.sun}
          label="Today"
          sub={
            <>
              <div>realized {signedMoney(today.realized)} · floating {signedMoney(today.floating)}</div>
              <div className="text-faint">{dayLabel}</div>
            </>
          }
        >
          <FlashValue value={today.total}><Pnl value={today.total} /></FlashValue>
        </Kpi>
        {open && (
          <Kpi
            icon={ICON.shield}
            label="Open risk to stops"
            sub={
              openCount === 0 ? "flat: no open positions" : (
                <>
                  <div>if every stop fills now · {count(openCount)} {openCount === 1 ? "position" : "positions"}</div>
                  {open.noStop > 0 && <div className="font-medium text-warn">{count(open.noStop)} without a stop: loss not bounded</div>}
                  {open.unpriced > 0 && <div className="text-faint">{count(open.unpriced)} not priced yet</div>}
                </>
              )
            }
          >
            {openCount === 0 ? <span className="text-faint">{money(0)}</span> : <FlashValue value={open.toStops}><Pnl value={open.toStops} /></FlashValue>}
          </Kpi>
        )}
        {risk && use ? (
          <>
            <LimitGauge
              label="Daily loss"
              use={use.daily}
              value={<span className={use.daily.used != null && use.daily.used > 0 ? "text-loss" : "text-bright"}>{signedMoney(use.daily.used == null ? null : -use.daily.used)}</span>}
              measured={dailyMeasured(risk, use.daily)}
              basis={`${risk.dailyLoss.includesFloating ? "incl. floating" : "realized only"} · ${dayBasisLabel(risk)}`}
              help={
                risk.dailyLoss.includesFloating
                  ? `Measured from ${dailyReferenceLabel(risk)} to equity now, floating P&L included.${risk.dailyLoss.base === "higher" ? " The day is measured from the higher of the day-start balance and equity." : ""} The day begins at ${String(risk.dailyLoss.resetHour).padStart(2, "0")}:00 ${risk.dailyLoss.timezone}. ${limitSource(risk)}`
                  : `The day's realized loss: closes since ${String(risk.dailyLoss.resetHour).padStart(2, "0")}:00 ${risk.dailyLoss.timezone}; floating P&L is not counted. ${limitSource(risk)}`
              }
            />
            <LimitGauge
              label="Max drawdown"
              use={use.drawdown}
              value={<span className={use.drawdown.used != null && use.drawdown.used > 0 ? "text-loss" : "text-bright"}>{pctValue(use.drawdown.usedPct ?? (use.drawdown.used === 0 ? 0 : null), 2)}</span>}
              measured={drawdownMeasured(risk, use.drawdown)}
              basis={use.drawdown.cap == null ? null : risk.basis === "static" ? `static below start ${money(risk.startBalance)}` : `from peak equity ${money(risk.peakEquity == null ? null : Math.max(risk.peakEquity, account.equity))}`}
              help={
                risk.basis === "static"
                  ? `How far equity is below the start balance (${risk.startBalanceSource ?? "unknown source"}). ${limitSource(risk)}`
                  : `How far equity is below the highest equity recorded; it does not adjust for deposits or withdrawals. ${limitSource(risk)}`
              }
            />
          </>
        ) : (
          <Card className="col-span-2 flex items-center p-4 text-sm text-muted">Loss limits appear with the account's first equity rollup.</Card>
        )}
      </div>
    </section>
  );
}

function limitSource(risk: AccountRiskRow): string {
  return risk.source == null ? `No limits configured. ${NO_LIMIT_HINT}` : `Limits from ${risk.source}.`;
}
