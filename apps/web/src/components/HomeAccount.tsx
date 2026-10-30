import type { ReactNode } from "react";
import type { AccountRiskRow, LiveAccount } from "../api";
import { clock, count, money, pctValue, signedMoney, signedPct, toneClass } from "../format";
import { dailyMeasured, floatingNoteText, type FloatingNote, dailyReferenceLabel, dayBasisLabel, limitLine, drawdownMeasured, limitUse, todaySplit, type AttentionItem, type LimitUse, type OpenRisk, type TodayPart, type TodaySplit } from "../home";
import { accountName, accountProfiles, accountTitle } from "../accounts";
import { Card, FlashValue, Freshness, Pill, Pnl, Popover } from "./ui";

/*
 * Home's account strip: what the account has, what today did, what the stops put at risk, and how
 * far each loss limit is. One row per venue account; every figure says its basis.
 */

/**
 * A KPI card: a label, one headline figure, one quiet line under it. What the figure means and how it is measured
 * opens from the label itself (hover, or tap on touch), so every card in the row keeps the same height.
 */
function Kpi({ label, children, sub, info }: {
  label: string; children: ReactNode; sub?: ReactNode; info?: ReactNode;
}) {
  return (
    <Card className="min-w-0 p-4">
      <div className="text-sm text-muted">
        {info ? (
          <Popover hover label={`About ${label.toLowerCase()}`} trigger={<span className="cursor-help truncate underline decoration-line-strong decoration-dotted underline-offset-4">{label}</span>}>
            <div className="space-y-1.5">{info}</div>
          </Popover>
        ) : label}
      </div>
      {/* sized to the card (Card is a container) so a seven-figure balance never clips */}
      <div className="mt-2 truncate font-headline text-[clamp(1rem,10cqi,1.25rem)] leading-7">{children}</div>
      {sub && <div className="mt-1 truncate text-xs text-muted">{sub}</div>}
    </Card>
  );
}

/** A limit's use as a slim bar: the accent under 55% (a limit is not P&L), amber to 80%, red beyond. Colour never alone: the words say what is left. */
function Meter({ pct }: { pct: number | null }) {
  const k = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const tone = pct == null ? "bg-muted" : pct >= 80 ? "bg-loss-fill" : pct >= 55 ? "bg-warn" : "bg-accent";
  return (
    <span aria-hidden className="mt-1.5 block h-1 overflow-hidden rounded-full bg-well">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${k}%` }} />
    </span>
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
      sub={line ? <><Meter pct={use.pct} /><span className={`mt-1.5 block truncate ${line.over ? "font-medium text-loss" : ""}`}>{line.left}</span></> : "no limit"}
    >
      <span className={tone}>{value}</span>
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
  peers = [],
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
  /** The accounts shown beside it, which its name must stay apart from. */
  peers?: readonly LiveAccount[];
}) {
  const today = todaySplit(account, realizedToday, note);
  const split = today.other != null || today.unassigned !== 0;
  const use = risk ? limitUse(risk, account.equity) : null;
  const openCount = open ? open.priced + open.noStop + open.unpriced : 0;
  const title = accountName(account, isPublic, peers);
  const profiles = isPublic ? [] : accountProfiles(account, labels);
  return (
    <section className={account.stale ? "opacity-90" : ""} aria-label={`Account ${title}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <span className="font-medium text-bright" title={isPublic ? accountTitle(account, isPublic, peers) : [accountTitle(account), account.server, profiles.length > 1 ? `via ${profiles.length} broker profiles: ${profiles.join(", ")}` : null].filter(Boolean).join(" · ")}>{title}</span>
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
          sub={<>open <Pnl value={account.equity - account.balance} /></>}
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
              ? <>other {signedMoney((today.other ?? 0) + today.unassigned)}</>
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
            {openCount === 0 ? <span className="text-muted">{money(0)}</span> : <FlashValue value={open.toStops}><span className="text-bright">{signedMoney(open.toStops)}</span></FlashValue>}
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
 * Home's answer, the largest figure on the page: "Today −65.68 USD · −5.72 USDC", the strategies' Today per currency;
 * it opens the strategy table. Another system's activity on an account is not here: it is in that account's Today
 * tooltip. `missing` counts accounts whose Today is not known yet; `asOf` is when the newest account state arrived.
 */
export function TodayHeadline({ parts, missing, pending, onQkt, asOf }: {
  parts: TodayPart[]; missing: number; pending: boolean; onQkt: () => void; asOf?: string;
}) {
  if (pending) return <span className="inline-block h-7 w-72 max-w-full rounded bg-raised align-middle" role="status" aria-label="Loading today's figures" />;
  if (parts.length === 0) return <span>Today: not known yet, waiting for the accounts' first rollup</span>;
  const why = `Your strategies: closes since each account's day began plus what their positions float${asOf ? `, as of ${asOf} UTC` : ""}; opens the strategies`;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span className="text-sm text-muted">Today</span>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-baseline gap-2.5">
          {i > 0 && <span aria-hidden className="text-muted">·</span>}
          <button type="button" className="rounded-sm focus-visible:outline-2 focus-visible:outline-accent-hi" onClick={onQkt} title={why}>
            <span className={`text-2xl font-headline ${toneClass(p.value)}`}>{signedMoney(p.value)}</span>
            <span className="ml-1 text-sm text-muted">{p.currency}</span>
          </button>
        </span>
      ))}
      {missing > 0 && <span className="text-sm text-muted"><span aria-hidden>· </span>{missing} {missing === 1 ? "account" : "accounts"} not known yet</span>}
    </span>
  );
}

/**
 * The line under Home's headline that answers "does anything need me?": each item links to where it lives (the
 * halted strategy, Health for a quiet account, the positions without a stop). "Nothing needs you" when empty of those.
 * Other activity on an account is information, not a problem: muted, beside that answer, and it links to the account's
 * tab unless that tab is `shownKey`, where it is plain text.
 */
export function AttentionLine({ items, onItem, shownKey }: { items: AttentionItem[]; onItem: (item: AttentionItem) => void; shownKey?: string }) {
  const words = (i: AttentionItem): string => {
    switch (i.kind) {
      case "halted": return `Halted: ${i.name}`;
      case "halted-many": return `${count(i.count)} strategies halted`;
      case "account": return i.state === "stopped" ? `${i.name} stopped · ${clock(i.since)} UTC` : `${i.name} stale`;
      case "no-stop": return `${count(i.count)} ${i.count === 1 ? "position" : "positions"} without a stop`;
      case "other": return `Other activity on ${i.name} ${signedMoney(i.split.other ?? 0)}`;
    }
  };
  const splitWords = ({ total, qkt, other, unassigned }: TodaySplit): string => [
    `Account today ${signedMoney(total)}`,
    `${signedMoney(qkt)} your strategies`,
    `${signedMoney(other ?? 0)} on positions of another system on this login`,
    ...(unassigned !== 0 ? [`${signedMoney(unassigned)} on trades not listed here`] : []),
  ].join(" · ");
  const needs = items.filter((i) => i.kind !== "other");
  return (
    <span className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Needs a look">
      {needs.length === 0 && <span className="text-muted">Nothing needs you</span>}
      {items.map((i, n) => i.kind === "other" ? (
        i.key === shownKey ? (
          <span key={n} role="listitem" title={splitWords(i.split)} className="inline-flex h-6 items-center text-xs text-muted">{words(i)}</span>
        ) : (
          <button key={n} type="button" role="listitem" onClick={() => onItem(i)} title={splitWords(i.split)}
            className="inline-flex h-6 items-center rounded-sm text-xs text-muted transition hover:text-bright focus-visible:outline-2 focus-visible:outline-accent-hi">
            {words(i)}
          </button>
        )
      ) : (
        <button key={n} type="button" role="listitem" onClick={() => onItem(i)} title={i.kind === "halted" ? i.why : undefined}
          className="inline-flex h-6 items-center rounded-full border border-warn/45 px-2.5 text-xs font-medium text-warn transition hover:bg-warn/10 focus-visible:outline-2 focus-visible:outline-accent-hi">
          {words(i)}
        </button>
      ))}
    </span>
  );
}
