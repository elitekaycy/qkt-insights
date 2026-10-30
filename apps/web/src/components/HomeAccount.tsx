import type { ReactNode } from "react";
import type { AccountRiskRow, LiveAccount } from "../api";
import { clock, count, money, pctValue, signedMoney, signedPct, toneClass } from "../format";
import { dailyMeasured, floatingNoteText, type FloatingNote, dailyReferenceLabel, dayBasisLabel, limitLine, drawdownMeasured, limitUse, todaySplit, type AttentionItem, type LimitUse, type OpenRisk, type TodayPart } from "../home";
import { accountHint, accountName, accountProfiles, accountTitle } from "../accounts";
import { Card, FlashValue, Freshness, InfoIcon, Pill, Pnl, Popover } from "./ui";

/*
 * Home's account strip: what the account has, what today did, what the stops put at risk, and how
 * far each loss limit is. One row per venue account; every figure says its basis.
 */

/**
 * A KPI card: a label, one headline figure, one quiet line under it. What the figure
 * means and how it is measured lives behind the info icon (hover, or tap on touch), so every card in
 * the row keeps the same height.
 */
function Kpi({ label, children, sub, info, className = "" }: {
  label: string; children: ReactNode; sub?: ReactNode; info?: ReactNode; className?: string;
}) {
  return (
    <Card className={`min-w-0 p-4 ${className}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted">
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
          {isPublic ? <span className="text-xs text-muted">as of {clock(account.lastSeen)} UTC</span> : <Freshness at={account.lastSeen} stale={account.stale} quiet />}
        </span>
      </div>
      <div className={`mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 ${open ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>
        <Kpi label="Balance" info={<p>Cash after closed trades, in {account.currency}. Open trades are in Equity.</p>}>
          <FlashValue value={account.balance}><span className="text-bright">{money(account.balance)}</span></FlashValue>
        </Kpi>
        <Kpi
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
          label="Today"
          sub={
            split
              ? <>other <span className="font-mono">{signedMoney((today.other ?? 0) + today.unassigned)}</span></>
              : `${signedMoney(realizedToday)} closed`
          }
          info={
            <>
              <p>Your strategies today: {signedMoney(realizedToday)} closed, {signedMoney(today.qkt - realizedToday)} still open. The day starts {dayLabel.replace(/^day from /, "")}.</p>
              {split && <p className="text-muted">The whole account is {signedMoney(today.total)} today{today.other != null ? `; ${signedMoney(today.other)} of it is open on another system's trades on this login` : ""}{today.unassigned !== 0 ? `; ${signedMoney(today.unassigned)} is on trades not listed here` : ""}.</p>}
            </>
          }
        >
          <FlashValue value={today.qkt}><Pnl value={today.qkt} /></FlashValue>
        </Kpi>
        {open && (
          <Kpi
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
            {openCount === 0 ? <span className="text-faint">{money(0)}</span> : <FlashValue value={open.toStops}><span className="text-bright">{signedMoney(open.toStops)}</span></FlashValue>}
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
              value={<span className="text-bright">{pctValue(use.drawdown.usedPct ?? (use.drawdown.used === 0 ? 0 : null), 2)}</span>}
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
 * Home's answer in one line: "Today +18.35 USD · −0.04 USDC", the strategies' Today per currency; it opens the
 * strategy table. Another system's activity on an account is not here: it is a quiet chip in the attention row.
 * `missing` counts accounts whose Today is not known yet.
 */
export function TodayHeadline({ parts, missing, pending, onQkt }: {
  parts: TodayPart[]; missing: number; pending: boolean; onQkt: () => void;
}) {
  if (pending) return <span className="inline-block h-4 w-72 max-w-full rounded bg-raised align-middle" role="status" aria-label="Loading today's figures" />;
  if (parts.length === 0) return <span>Today: not known yet, waiting for the accounts' first rollup</span>;
  const link = "rounded-sm underline decoration-line-strong decoration-dotted underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-accent-hi";
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-medium text-body">Today</span>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-baseline gap-2">
          {i > 0 && <span aria-hidden className="text-faint">·</span>}
          <button type="button" className={link} onClick={onQkt} title="Your strategies: closes since each account's day began plus what their positions float; opens the strategies">
            <span className={`font-mono font-semibold tabular-nums ${toneClass(p.value)}`}>{signedMoney(p.value)}</span>
            <span className="ml-1 text-xs text-muted">{p.currency}</span>
          </button>
        </span>
      ))}
      {missing > 0 && <span className="text-faint"><span aria-hidden>· </span>{missing} {missing === 1 ? "account" : "accounts"} not known yet</span>}
    </span>
  );
}

/**
 * The line under Home's headline that answers "does anything need me?": each item links to where it lives (the
 * halted strategy, Health for a quiet account, the positions without a stop). "Nothing needs you" when empty. Another
 * system's activity on an account follows as a muted chip that opens the account: the same truth, not an alarm.
 */
export function AttentionLine({ items, others, onItem, onAccount }: {
  items: AttentionItem[]; others: TodayPart[]; onItem: (item: AttentionItem) => void; onAccount: (key: string) => void;
}) {
  const words = (i: AttentionItem): string => {
    switch (i.kind) {
      case "halted": return `Halted: ${i.name}`;
      case "halted-many": return `${count(i.count)} strategies halted`;
      case "account": return i.state === "stopped" ? `${i.name} stopped · ${clock(i.since)} UTC` : `${i.name} stale`;
      case "no-stop": return `${count(i.count)} ${i.count === 1 ? "position" : "positions"} without a stop`;
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Needs a look">
      {items.length === 0 && <span className="mr-1 text-muted">Nothing needs you</span>}
      {items.map((i, n) => (
        <button key={n} type="button" role="listitem" onClick={() => onItem(i)} title={i.kind === "halted" ? i.why : undefined}
          className="inline-flex h-6 items-center gap-1.5 rounded-full border border-warn/45 bg-warn/10 px-2.5 text-xs font-medium text-warn transition hover:bg-warn/15 focus-visible:outline-2 focus-visible:outline-accent-hi">
          {words(i)}
        </button>
      ))}
      {others.map((p) => (
        <button key={p.account?.key} type="button" role="listitem" onClick={() => p.account && onAccount(p.account.key)}
          title={`Floating on positions of another system on ${p.account?.name}, not your strategies; opens the account`}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-raised px-2.5 text-xs text-muted transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent-hi">
          Other activity on {p.account?.name}: <span className="font-mono tabular-nums text-body">{signedMoney(p.value)}</span>
        </button>
      ))}
    </span>
  );
}
