import { roundMoney } from "@qkt-insights/contract/money";
import type { AccountRiskRow } from "../api";
import { accountByKey, accountKey, accountTab, switcherOrder, type AccountGroup } from "../accounts";
import { clock, count, DASH, money, pctValue, signedMoney } from "../format";
import { floatingNoteText, limitUse, todaySplit, type FloatingNote, type OpenRisk, type TodaySplit } from "../home";
import { useSearchParam } from "../router";
import { DataList, Cell, Freshness, Pnl, Segmented } from "./ui";

/*
 * Several venue accounts on one instance: a one-line switcher (All accounts, then one tab per account) whose
 * choice lives in the URL (`?account=`), so a reload, Back and a shared link keep it and Home and Equity & risk
 * open on the same account. One account needs no switcher: the pages show it as they always have.
 */

export interface AccountChoice {
  /** The accounts in switcher order. */
  accounts: AccountGroup[];
  /** More than one account: the pages show the switcher. */
  many: boolean;
  /** The account shown; null is "All accounts". With a single account it is that account. */
  chosen: AccountGroup | null;
  /** The account the URL asks for, resolved or not ("" for none): a page waits for the accounts before reading one. */
  asked: string;
  choose: (account: AccountGroup | null) => void;
}

export function useAccountChoice(groups: readonly AccountGroup[], isPublic: boolean): AccountChoice {
  const [key, setKey] = useSearchParam("account");
  const accounts = switcherOrder(groups, isPublic);
  const many = accounts.length > 1;
  return {
    accounts,
    many,
    chosen: many ? accountByKey(accounts, key) : (accounts[0] ?? null),
    asked: key,
    choose: (a) => setKey(a ? accountKey(a.account) : "", { push: true }),
  };
}

/** The switcher: All accounts, then each account by venue and login with its environment and currency muted beside it. One line; it scrolls when the accounts outgrow it. */
export function AccountTabs({ choice, isPublic }: { choice: AccountChoice; isPublic: boolean }) {
  if (!choice.many) return null;
  const options = [
    { key: "", label: "All accounts" },
    ...choice.accounts.map((g) => {
      const tab = accountTab(g.account, isPublic);
      return {
        key: accountKey(g.account),
        title: g.account.stopped
          ? `${tab.title} · last reported ${clock(g.account.lastSeen)} UTC`
          : g.account.stale ? `${tab.title} · stale, no update since ${clock(g.account.lastSeen)} UTC` : tab.title,
        label: (
          <span className={`inline-flex items-center gap-1.5 ${g.account.stopped ? "opacity-70" : ""}`}>
            <span>{tab.name}</span>
            {tab.hint && <span className="text-xs font-normal text-muted">{tab.hint}</span>}
            {g.account.stale && <span className={`text-xs font-normal ${g.account.stopped ? "text-muted" : "text-warn"}`}>{g.account.stopped ? "stopped" : "stale"}</span>}
          </span>
        ),
      };
    }),
  ];
  return (
    <nav aria-label="Accounts" className="-mx-1 min-w-0 px-1">
      <Segmented
        label="Accounts"
        value={choice.chosen ? accountKey(choice.chosen.account) : ""}
        onChange={(k) => choice.choose(accountByKey(choice.accounts, k))}
        options={options}
      />
    </nav>
  );
}

/** One account's row in the All accounts table: its live figures, its risk row, and open risk over its own positions. */
export interface AccountLine {
  group: AccountGroup;
  risk: AccountRiskRow | null;
  /** Realized since the account's trading day began; null before its first risk rollup. */
  realizedToday: number | null;
  /** Null on shared links, which never show positions. */
  open: OpenRisk | null;
  /** Why the account's floating differs from its listed positions (Home floatingNote); null when it does not. */
  note?: FloatingNote | null;
  /** The account's risk rows are still loading: Today and drawdown are not known yet, never shown as missing. */
  pending?: boolean;
}

const HEAD = ["Account", "Balance", "Equity", "Today", "Open risk", "Drawdown"];

/**
 * All accounts at a glance: one row per account, every figure in the account's own currency (never added across
 * accounts). A row opens that account's tab.
 */
export function AccountsTable({ lines, choice, isPublic }: { lines: AccountLine[]; choice: AccountChoice; isPublic: boolean }) {
  // the status column appears only while an account is stale or stopped; healthy rows need none
  const quiet = lines.some((l) => l.group.account.stale);
  return (
    <section aria-label="All accounts" className="overflow-hidden rounded-card border border-line bg-panel">
      <DataList
        head={quiet ? [...HEAD, "Status"] : HEAD}
        rows={lines}
        keyOf={(l) => accountKey(l.group.account)}
        onRow={(l) => choice.choose(l.group)}
        empty="No account has reported yet."
        cells={(l) => <AccountCells line={l} isPublic={isPublic} status={quiet} />}
        card={(l) => <AccountCard line={l} isPublic={isPublic} />}
      />
    </section>
  );
}

function figures(l: AccountLine) {
  const a = l.group.account;
  const today = l.realizedToday == null ? null : todaySplit(a, l.realizedToday, l.note);
  const use = l.risk ? limitUse(l.risk, a.equity) : null;
  const dd = use ? (use.drawdown.usedPct ?? (use.drawdown.used === 0 ? 0 : null)) : null;
  return { a, today, dd, ddUse: use?.drawdown.pct ?? null };
}

/** The account's name, never cut, with its environment and currency on a second line. */
function Name({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const tab = accountTab(line.group.account, isPublic);
  return (
    <span className="block leading-tight" title={tab.title}>
      <span className="block font-medium text-bright">{tab.name}</span>
      {tab.hint && <span className="block text-xs text-muted">{tab.hint}</span>}
    </span>
  );
}

/**
 * Money at risk to the stops, in ink: it is not a loss, so it takes no P&L colour. Positions without a stop are
 * counted in words beside it (they feed Home's attention line).
 */
function OpenRiskCell({ open }: { open: OpenRisk | null }) {
  if (!open) return <span className="text-faint">{DASH}</span>;
  const n = open.priced + open.noStop + open.unpriced;
  if (n === 0) return <span className="font-sans text-faint">flat</span>;
  return (
    <span className="inline-flex flex-col items-start leading-tight">
      {open.priced > 0 && <span className="text-bright">{signedMoney(open.toStops)}</span>}
      {open.noStop > 0 && <span className="font-sans text-xs font-medium text-warn">{count(open.noStop)} without a stop</span>}
      {open.priced === 0 && open.noStop === 0 && <span className="font-sans text-faint">{count(open.unpriced)} not priced</span>}
    </span>
  );
}

/** A drawdown in ink, coloured only by how much of a set limit it uses: amber from 55%, red from 80%. */
function ddTone(use: number | null): string {
  if (use == null) return "";
  return use >= 80 ? "text-loss" : use >= 55 ? "text-warn" : "";
}

function Updated({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const a = line.group.account;
  if (a.stopped) return <span className="text-xs text-muted" title={`no report since ${clock(a.lastSeen)} UTC; the figures are its last stored minute`}>stopped · {clock(a.lastSeen)} UTC</span>;
  return isPublic ? <span className="text-xs text-muted">as of {clock(a.lastSeen)} UTC</span> : <Freshness at={a.lastSeen} stale={a.stale} quiet />;
}

function AccountCells({ line, isPublic, status }: { line: AccountLine; isPublic: boolean; status: boolean }) {
  const { a, today, dd, ddUse } = figures(line);
  return (
    <>
      <Cell><Name line={line} isPublic={isPublic} /></Cell>
      <Cell className="font-mono tabular-nums">{money(a.balance)}</Cell>
      <Cell className="font-mono tabular-nums">{money(a.equity)}</Cell>
      <Cell className="font-mono tabular-nums">
        {line.pending ? <Pending /> : today ? <TodayFigure split={today} note={line.note ?? null} realized={line.realizedToday!} /> : <span className="text-faint">{DASH}</span>}
      </Cell>
      <Cell className="font-mono tabular-nums"><OpenRiskCell open={line.open} /></Cell>
      <Cell className={`font-mono tabular-nums ${ddTone(ddUse)}`}>{line.pending ? <Pending /> : dd == null ? <span className="text-faint">{DASH}</span> : pctValue(dd, 2)}</Cell>
      {status && <Cell className="whitespace-nowrap"><Updated line={line} isPublic={isPublic} /></Cell>}
    </>
  );
}

function AccountCard({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const { a, today, dd, ddUse } = figures(line);
  return (
    <>
      <div className="flex items-baseline gap-2">
        <Name line={line} isPublic={isPublic} />
        <span className="ml-auto shrink-0 text-right font-mono text-sm tabular-nums">{line.pending ? <Pending /> : today ? <TodayFigure split={today} note={line.note ?? null} realized={line.realizedToday!} /> : <span className="text-faint">{DASH}</span>}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>equity <span className="font-mono text-body tabular-nums">{money(a.equity)}</span></span>
        <span>DD <span className={`font-mono tabular-nums ${ddTone(ddUse) || "text-body"}`}>{line.pending ? "…" : dd == null ? DASH : pctValue(dd, 2)}</span></span>
        <span className="ml-auto"><Updated line={line} isPublic={isPublic} /></span>
      </div>
    </>
  );
}

/** A figure still loading: a flat bar the height of the figure, never a dash that reads as "none". */
function Pending() {
  return <span className="inline-block h-3.5 w-16 rounded bg-raised align-middle" role="status" aria-label="loading" />;
}

/**
 * An account's Today on one right edge: what your strategies made (closes since the day began and their listed
 * positions' floating) on line 1, anything else on the account (another system on the same login, trades not listed
 * here) as a muted "other" line 2 when it is not zero. The account's own total and each part on hover.
 */
function TodayFigure({ split, note, realized }: { split: TodaySplit; note: FloatingNote | null; realized: number }) {
  const parts = [`Account today ${signedMoney(split.total)}`, `${signedMoney(realized)} closed`, `${signedMoney(split.qkt - realized)} open on your strategies' positions`];
  if (split.other != null) parts.push(`${signedMoney(split.other)} on positions of another system on this login`);
  if (split.unassigned !== 0 && note) parts.push(`${signedMoney(split.unassigned)} on trades not listed here (${floatingNoteText(note)})`);
  const other = roundMoney((split.other ?? 0) + split.unassigned, 2);
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={parts.join(" · ")}>
      <Pnl value={split.qkt} />
      {other !== 0 && <span className="whitespace-nowrap text-xs text-muted"><span className="font-sans">other</span> {signedMoney(other)}</span>}
    </span>
  );
}
