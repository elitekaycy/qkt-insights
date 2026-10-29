import type { AccountRiskRow } from "../api";
import { accountByKey, accountKey, accountTab, switcherOrder, type AccountGroup } from "../accounts";
import { clock, count, DASH, money, pctValue, signedMoney } from "../format";
import { accountToday, floatingNoteText, limitUse, type FloatingNote, type OpenRisk } from "../home";
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
            {g.account.stale && <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${g.account.stopped ? "bg-faint" : "bg-warn"}`} aria-label={g.account.stopped ? "stopped reporting" : "stale"} />}
            <span>{tab.name}</span>
            {tab.hint && <span className="text-xs font-normal text-faint">{tab.hint}</span>}
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
}

const HEAD = ["Account", "Balance", "Equity", "Today", "Open risk", "Drawdown", "Updated"];

/**
 * All accounts at a glance: one row per account, every figure in the account's own currency (never added across
 * accounts). A row opens that account's tab.
 */
export function AccountsTable({ lines, choice, isPublic }: { lines: AccountLine[]; choice: AccountChoice; isPublic: boolean }) {
  return (
    <section aria-label="All accounts" className="overflow-hidden rounded-card border border-line bg-panel">
      <DataList
        head={HEAD}
        rows={lines}
        keyOf={(l) => accountKey(l.group.account)}
        onRow={(l) => choice.choose(l.group)}
        empty="No account has reported yet."
        cells={(l) => <AccountCells line={l} isPublic={isPublic} />}
        card={(l) => <AccountCard line={l} isPublic={isPublic} />}
      />
    </section>
  );
}

function figures(l: AccountLine) {
  const a = l.group.account;
  const today = l.realizedToday == null ? null : accountToday(a, l.realizedToday);
  const use = l.risk ? limitUse(l.risk, a.equity) : null;
  const dd = use ? (use.drawdown.usedPct ?? (use.drawdown.used === 0 ? 0 : null)) : null;
  return { a, today, dd };
}

function Name({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const tab = accountTab(line.group.account, isPublic);
  return (
    <span className="flex min-w-0 items-baseline gap-2" title={tab.title}>
      <span className="truncate font-medium text-bright">{tab.name}</span>
      <span className="shrink-0 text-xs text-faint">{tab.hint}</span>
    </span>
  );
}

function OpenRiskCell({ open }: { open: OpenRisk | null }) {
  if (!open) return <span className="text-faint">{DASH}</span>;
  const n = open.priced + open.noStop + open.unpriced;
  if (n === 0) return <span className="text-faint">flat</span>;
  return (
    <span className="whitespace-nowrap">
      {open.priced > 0 && <Pnl value={open.toStops} glyphs={false} />}
      {open.noStop > 0 && <span className={`${open.priced > 0 ? "ml-1.5 " : ""}text-xs font-medium text-warn`}>{count(open.noStop)} without a stop</span>}
      {open.priced === 0 && open.noStop === 0 && <span className="text-faint">{count(open.unpriced)} not priced</span>}
    </span>
  );
}

function Updated({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const a = line.group.account;
  if (a.stopped) return <span className="text-xs text-muted" title={`no report since ${clock(a.lastSeen)} UTC; the figures are its last stored minute`}>stopped · {clock(a.lastSeen)} UTC</span>;
  return isPublic ? <span className="text-xs text-muted">as of {clock(a.lastSeen)} UTC</span> : <Freshness at={a.lastSeen} stale={a.stale} />;
}

function AccountCells({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const { a, today, dd } = figures(line);
  return (
    <>
      <Cell className="max-w-[18rem]"><Name line={line} isPublic={isPublic} /></Cell>
      <Cell className="font-mono tabular-nums">{money(a.balance)}</Cell>
      <Cell className="font-mono tabular-nums">{money(a.equity)}</Cell>
      <Cell className="font-mono tabular-nums">
        {today ? <span title={`${money(today.realized)} closed, ${money(today.floating)} open${line.note ? `, of which ${floatingNoteText(line.note)}` : ""}`}><Pnl value={today.total} />{line.note?.outside?.floating != null && <span className="block text-[11px] text-muted">{signedMoney(line.note.outside.floating)} outside this instance</span>}{line.note?.elsewhere != null && <span className="block text-[11px] text-muted">{signedMoney(line.note.elsewhere)} not on listed positions</span>}</span> : <span className="text-faint">{DASH}</span>}
      </Cell>
      <Cell className="font-mono tabular-nums"><OpenRiskCell open={line.open} /></Cell>
      <Cell className={`font-mono tabular-nums ${dd != null && dd > 0 ? "text-loss" : ""}`}>{dd == null ? <span className="text-faint">{DASH}</span> : pctValue(dd, 2)}</Cell>
      <Cell className="whitespace-nowrap"><Updated line={line} isPublic={isPublic} /></Cell>
    </>
  );
}

function AccountCard({ line, isPublic }: { line: AccountLine; isPublic: boolean }) {
  const { a, today, dd } = figures(line);
  return (
    <>
      <div className="flex items-baseline gap-2">
        <Name line={line} isPublic={isPublic} />
        <span className="ml-auto shrink-0 font-mono text-sm tabular-nums">{today ? <Pnl value={today.total} /> : <span className="text-faint">{DASH}</span>}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>equity <span className="font-mono text-body tabular-nums">{money(a.equity)}</span></span>
        <span>DD <span className={`font-mono tabular-nums ${dd != null && dd > 0 ? "text-loss" : "text-body"}`}>{dd == null ? DASH : pctValue(dd, 2)}</span></span>
        <span className="ml-auto"><Updated line={line} isPublic={isPublic} /></span>
      </div>
    </>
  );
}
