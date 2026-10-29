import type { ReactNode } from "react";
import type { AccountRiskRow, LiveAccount } from "../api";
import { clock, count, money, pctValue, signedMoney, signedPct, toneClass } from "../format";
import { dailyMeasured, floatingNoteText, type FloatingNote, dailyReferenceLabel, dayBasisLabel, limitLine, drawdownMeasured, limitUse, todaySplit, type LimitUse, type OpenRisk, type TodayPart } from "../home";
import { accountHint, accountName, accountProfiles, accountTitle } from "../accounts";
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

/**
 * A journal KPI card: icon and label, one headline figure, one quiet line under it. What the figure
 * means and how it is measured lives behind the info icon (hover, or tap on touch), so every card in
 * the row keeps the same height.
 */
export function Kpi({ icon, label, children, sub, info, className = "" }: {
  icon: string; label: string; children: ReactNode; sub?: ReactNode; info?: ReactNode; className?: string;
}) {
  return (
    <Card className={`min-w-0 p-4 ${className}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted">
        <Glyph d={icon} />
        <span className="truncate">{label}</span>
        {info && (
          <span className="ml-auto">
            <Popover hover label={`About ${label.toLowerCase()}`} align="right" trigger={<InfoIcon className="h-3.5 w-3.5 text-faint hover:text-bright" />}>
              <div className="space-y-1.5">{info}</div>
            </Popover>
          </span>
        )}
      </div>
      {/* sized to the card (Card is a container) so a seven-figure balance never clips */}
      {/* a fixed-height figure row, so a card with a gauge is exactly as tall as one with plain text */}
      <div className="mt-2 flex h-7 items-end truncate font-headline text-[clamp(1rem,12.5cqi,1.5rem)] tabular-nums sm:h-9">{children}</div>
      {sub && <div className="mt-1.5 truncate text-xs text-muted">{sub}</div>}
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
    <svg viewBox="0 0 84 48" className="h-6 w-10 shrink-0 sm:h-9 sm:w-16" aria-hidden>
      <path d="M8 44a34 34 0 0 1 68 0" fill="none" stroke="var(--color-raised)" strokeWidth="8" strokeLinecap="round" />
      {k > 0 && <path d="M8 44a34 34 0 0 1 68 0" fill="none" stroke={tone} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${k * half} ${half}`} />}
    </svg>
  );
}

/**
 * One loss limit: the account's own figure as the headline and, with a cap, a gauge of its use and
 * what is left. How it is measured, the share of the cap used and where the cap comes from are in the
 * info panel. Without a cap the card shows the figure and "no limit set", never an empty gauge.
 */
function LimitGauge({ label, use, value, measured, basis, help }: {
  label: string; use: LimitUse; value: ReactNode; measured: string;
  /** How the figure is measured; null where `measured` already says it. */
  basis: string | null;
  help: string;
}) {
  const line = limitLine(use);
  const tone = use.pct != null && use.pct >= 80 ? "text-loss" : use.pct != null && use.pct >= 55 ? "text-warn" : "";
  return (
    <Kpi
      icon={ICON.gauge}
      label={label}
      info={
        <>
          <p className="text-bright">{measured}</p>
          {line && <p>{line.used}</p>}
          {basis && <p className="text-muted">{basis}</p>}
          <p className="text-muted">{help}</p>
        </>
      }
      sub={line ? <span className={line.over ? "font-medium text-loss" : ""}>{line.left}</span> : <span className="text-muted">no limit</span>}
    >
      <div className="flex items-end gap-2 sm:gap-2.5">
        {line && <Arc pct={use.pct} />}
        <span className={tone}>{value}</span>
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
  note = null,
  riskPending = false,
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
  /** Why the account's floating differs from its listed positions; null when it does not. */
  note?: FloatingNote | null;
  /** The risk rows are still loading: the loss limits are not known yet, so nothing claims there are none. */
  riskPending?: boolean;
  isPublic: boolean;
}) {
  const today = todaySplit(account, realizedToday, note);
  const split = today.other != null || today.unassigned !== 0;
  const use = risk ? limitUse(risk, account.equity) : null;
  const openCount = open ? open.priced + open.noStop + open.unpriced : 0;
  const title = accountName(account, isPublic);
  const hint = accountHint(account);
  const profiles = isPublic ? [] : accountProfiles(account, labels);
  return (
    <section className={account.stale ? "opacity-90" : ""} aria-label={`Account ${title}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <span className="font-semibold text-bright" title={isPublic ? accountTitle(account, isPublic) : [accountTitle(account), account.server, profiles.length > 1 ? `via ${profiles.length} broker profiles: ${profiles.join(", ")}` : null].filter(Boolean).join(" · ")}>{title}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
        {account.stopped && <Pill tone="warn">stopped reporting</Pill>}
        <span className="ml-auto">
          {isPublic ? <span className="text-xs text-muted">as of {clock(account.lastSeen)} UTC</span> : <Freshness at={account.lastSeen} stale={account.stale} />}
        </span>
      </div>
      <div className={`mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 ${open ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>
        <Kpi icon={ICON.wallet} label="Balance" info={<p>Cash after closed trades, in {account.currency}. Open trades are in Equity.</p>}>
          <FlashValue value={account.balance}><span className="text-bright">{money(account.balance)}</span></FlashValue>
        </Kpi>
        <Kpi
          icon={ICON.pulse}
          label="Equity"
          sub={<>open <Pnl value={account.equity - account.balance} glyphs={false} /></>}
          info={
            <>
              <p>Balance plus what open trades are worth now.</p>
              {note && <p className="text-muted">Of the {signedMoney(note.account)} open: {floatingNoteText(note)}.</p>}
            </>
          }
        >
          <FlashValue value={account.equity}><span className="text-bright">{money(account.equity)}</span></FlashValue>
        </Kpi>
        <Kpi
          icon={ICON.sun}
          label="Today"
          sub={
            split
              ? <>{today.other != null && <><span className="font-mono">{signedMoney(today.other)}</span> other system</>}{today.other != null && today.unassigned !== 0 && " · "}{today.unassigned !== 0 && <><span className="font-mono">{signedMoney(today.unassigned)}</span> unlisted</>}</>
              : `${signedMoney(realizedToday)} closed`
          }
          info={
            <>
              <p>qkt today: {signedMoney(realizedToday)} closed, {signedMoney(today.qkt - realizedToday)} still open. The day starts {dayLabel.replace(/^day from /, "")}.</p>
              {split && <p className="text-muted">The whole account is {signedMoney(today.total)} today{today.other != null ? `; ${signedMoney(today.other)} of it is open on another system's trades on this login` : ""}{today.unassigned !== 0 ? `; ${signedMoney(today.unassigned)} is on trades not listed here` : ""}.</p>}
            </>
          }
        >
          <FlashValue value={today.qkt}><Pnl value={today.qkt} />{split && <span className="ml-1.5 font-sans text-sm text-muted">qkt</span>}</FlashValue>
        </Kpi>
        {open && (
          <Kpi
            icon={ICON.shield}
            label="Risk to stops"
            sub={
              open.noStop > 0 ? <span className="font-medium text-warn">{count(open.noStop)} without a stop</span>
                : openCount === 0 ? "no open trades" : `${count(openCount)} open ${openCount === 1 ? "trade" : "trades"}`
            }
            info={
              <>
                <p>What open trades would lose if every stop were hit now.</p>
                {open.noStop > 0 && <p>{count(open.noStop)} without a stop: no limit on their loss.</p>}
                {open.unpriced > 0 && <p className="text-muted">{count(open.unpriced)} not priced yet.</p>}
              </>
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
              measured={`${dailyMeasured(risk, use.daily)}${use.daily.usedPct != null ? ` (${signedPct(-use.daily.usedPct, 2)})` : ""}`}
              basis={`${risk.dailyLoss.includesFloating ? "incl. floating" : "realized only"} · ${dayBasisLabel(risk)}`}
              help={
                risk.dailyLoss.includesFloating
                  ? `Measured from ${dailyReferenceLabel(risk)} to equity now, floating P&L included.${risk.dailyLoss.base === "higher" ? " The day is measured from the higher of the day-start balance and equity." : ""} The day begins at ${String(risk.dailyLoss.resetHour).padStart(2, "0")}:00 ${risk.dailyLoss.timezone}. ${limitSource(risk)}`
                  : `The day's realized loss: closes since ${String(risk.dailyLoss.resetHour).padStart(2, "0")}:00 ${risk.dailyLoss.timezone}; floating P&L is not counted. ${limitSource(risk)}`
              }
            />
            <LimitGauge
              label="Drawdown"
              use={use.drawdown}
              value={<span className={use.drawdown.used != null && use.drawdown.used > 0 ? "text-loss" : "text-bright"}>{pctValue(use.drawdown.usedPct ?? (use.drawdown.used === 0 ? 0 : null), 2)}</span>}
              measured={drawdownMeasured(risk, use.drawdown)}
              basis={risk.basis === "static" ? null : `from peak equity ${money(risk.peakEquity == null ? null : Math.max(risk.peakEquity, account.equity))}`}
              help={
                risk.basis === "static"
                  ? `How far equity is below the start balance (${risk.startBalanceSource ?? "unknown source"}). ${limitSource(risk)}`
                  : `How far equity is below the highest equity recorded; it does not adjust for deposits or withdrawals. ${limitSource(risk)}`
              }
            />
          </>
        ) : riskPending ? (
          <Card className="col-span-2 p-4">
            <div className="h-4 w-24 rounded bg-raised" />
            <div className="mt-3 h-7 w-32 rounded bg-raised" />
          </Card>
        ) : (
          <Card className="col-span-2 flex items-center p-4 text-sm text-muted">No loss limits yet.</Card>
        )}
      </div>
    </section>
  );
}

function limitSource(risk: AccountRiskRow): string {
  return risk.source == null ? `No limits configured. ${NO_LIMIT_HINT}` : `Limits from ${risk.source}.`;
}

/**
 * Home's answer in one line: "Today +18.35 USD qkt · −767.77 USD other system on Exness •••2618". qkt's part opens the
 * strategy table, another system's part that account's tab. `missing` counts accounts whose Today is not known yet.
 */
export function TodayHeadline({ parts, missing, pending, onQkt, onAccount }: {
  parts: TodayPart[]; missing: number; pending: boolean;
  onQkt: () => void; onAccount: (key: string) => void;
}) {
  if (pending) return <span className="inline-block h-4 w-72 max-w-full rounded bg-raised align-middle" role="status" aria-label="Loading today's figures" />;
  if (parts.length === 0) return <span>Today: not known yet, waiting for the accounts' first rollup</span>;
  const link = "rounded-sm underline decoration-line-strong decoration-dotted underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-accent-hi";
  return (
    <span className="flex flex-col items-start gap-x-2 gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-baseline">
      <span className="font-medium text-body">Today</span>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-baseline gap-2">
          {i > 0 && <span aria-hidden className="hidden text-faint sm:inline">·</span>}
          <button type="button" className={link} onClick={() => (p.kind === "qkt" || !p.account ? onQkt() : onAccount(p.account.key))}
            title={p.kind === "qkt" ? "qkt's closes since each account's day began plus what its positions float; opens the strategies" : `Floating on positions of another system trading ${p.account?.name}; opens the account`}>
            <span className={`font-mono font-semibold tabular-nums ${toneClass(p.value)}`}>{signedMoney(p.value)}</span>
            <span className="ml-1 text-xs text-muted">{p.currency}</span>
            <span className="ml-1.5">{p.kind === "qkt" ? "qkt" : `other system on ${p.account?.name}`}</span>
          </button>
        </span>
      ))}
      {missing > 0 && <span className="text-faint"><span aria-hidden className="hidden sm:inline">· </span>{missing} {missing === 1 ? "account" : "accounts"} not known yet</span>}
    </span>
  );
}
