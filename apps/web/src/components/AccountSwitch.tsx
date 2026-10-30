import { roundMoney } from "@qkt-insights/contract/money";
import type { AccountRiskRow } from "../api";
import { accountByKey, accountKey, accountName, accountTab, switcherOrder, type AccountGroup } from "../accounts";
import { clock, count, DASH, money, pctValue, signedMoney } from "../format";
import { floatingNoteText, limitUse, splitOtherWords, splitTotalWords, todaySplit, type DayStart, type FloatingNote, type OpenRisk, type TodaySplit } from "../home";
import { useSearchParam } from "../router";
import { Cell, Freshness, Pill, Pnl, Row, Segmented } from "./ui";

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

/** The switcher: All accounts, then each account by name; currency and login are in its tooltip. One line; it scrolls when the accounts outgrow it. */
export function AccountTabs({ choice, isPublic }: { choice: AccountChoice; isPublic: boolean }) {
  if (!choice.many) return null;
  const options = [
    { key: "", label: "All accounts" },
    ...choice.accounts.map((g) => {
      const tab = accountTab(g.account, isPublic, choice.accounts.map((c) => c.account));
      return {
        key: accountKey(g.account),
        title: g.account.stopped
          ? `${tab.title} · last reported ${clock(g.account.lastSeen)} UTC`
          : g.account.stale ? `${tab.title} · stale, no update since ${clock(g.account.lastSeen)} UTC` : tab.title,
        label: (
          <span className={`inline-flex items-center gap-1.5 ${g.account.stopped ? "opacity-70" : ""}`}>
            <span>{tab.name}</span>
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
  /** The start of the account's trading day; null on shared links, which never measure the account's day. */
  day?: DayStart | null;
  /** The account's risk rows are still loading: Today and drawdown are not known yet, never shown as missing. */
  pending?: boolean;
}

const HEAD: ReadonlyArray<{ label: string; right?: boolean; title?: string }> = [
  { label: "Account" },
  { label: "Currency", title: "Every figure on a row is in that account's own currency; figures are never added across accounts" },
  { label: "Equity", right: true, title: "Balance plus what open trades are worth now; hover a figure for its balance" },
  { label: "Today", right: true, title: "What your strategies made since the account's day began, open trades included; hover for the split" },
  { label: "To stops", right: true, title: "What open trades would lose if every stop were hit now" },
  { label: "Drawdown", right: true },
];

/**
 * All accounts at a glance: one line per account, every figure in the account's own currency (never added across
 * accounts). A row opens that account's tab.
 */
export function AccountsTable({ lines, choice, isPublic }: { lines: AccountLine[]; choice: AccountChoice; isPublic: boolean }) {
  const peers = lines.map((l) => l.group.account);
  // the status column appears only while an account is stale or stopped; healthy rows need none
  const quiet = lines.some((l) => l.group.account.stale);
  return (
    <section aria-label="All accounts" className="overflow-hidden rounded-card border border-line bg-panel">
      {lines.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No account has reported yet.</div>
      ) : (
        <div className="@container">
          <table className="hidden w-full text-sm @xl:table">
            <thead>
              <tr className="border-b border-line text-left">
                {[...HEAD, ...(quiet ? [{ label: "Status" }] : [])].map((h) => (
                  <th key={h.label} title={"title" in h ? h.title : undefined} className={`eyebrow whitespace-nowrap px-4 py-2 ${"right" in h && h.right ? "text-right" : ""}`}>{h.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <Row key={accountKey(l.group.account)} onClick={() => choice.choose(l.group)} label={`Open ${accountName(l.group.account, isPublic, peers)}`}>
                  <AccountCells line={l} isPublic={isPublic} status={quiet} peers={peers} />
                </Row>
              ))}
            </tbody>
          </table>
          <ul className="divide-y divide-line @xl:hidden">
            {lines.map((l) => (
              <li key={accountKey(l.group.account)}>
                <button type="button" onClick={() => choice.choose(l.group)} className="block w-full px-4 py-3 text-left transition hover:bg-hover active:bg-press">
                  <AccountCard line={l} isPublic={isPublic} peers={peers} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function figures(l: AccountLine) {
  const a = l.group.account;
  const today = l.realizedToday == null ? null : todaySplit(a, l.realizedToday, l.note, l.day);
  const use = l.risk ? limitUse(l.risk, a.equity) : null;
  const dd = use ? (use.drawdown.usedPct ?? (use.drawdown.used === 0 ? 0 : null)) : null;
  return { a, today, dd, ddUse: use?.drawdown.pct ?? null };
}

/** The account's name on one line; currency and login on hover. */
function Name({ line, isPublic, peers }: { line: AccountLine; isPublic: boolean; peers: readonly AccountGroup["account"][] }) {
  const tab = accountTab(line.group.account, isPublic, peers);
  return <span className="font-medium text-bright" title={tab.title}>{tab.name}</span>;
}

/**
 * Money at risk to the stops, in ink: it is not a loss, so it takes no P&L colour. Positions without a stop are a
 * pill, because they need a look; the money of the ones that do have a stop stays in its tooltip.
 */
function OpenRiskCell({ open }: { open: OpenRisk | null }) {
  if (!open) return <span className="text-muted">{DASH}</span>;
  const n = open.priced + open.noStop + open.unpriced;
  if (n === 0) return <span className="font-sans text-muted">flat</span>;
  if (open.noStop > 0) {
    return (
      <span title={open.priced > 0 ? `${signedMoney(open.toStops)} to the stops on ${count(open.priced)} more` : undefined}>
        <Pill tone="warn">{count(open.noStop)} no stop</Pill>
      </span>
    );
  }
  if (open.priced === 0) return <span className="font-sans text-muted">{count(open.unpriced)} not priced</span>;
  return <span className="text-bright">{signedMoney(open.toStops)}</span>;
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

function AccountCells({ line, isPublic, status, peers }: { line: AccountLine; isPublic: boolean; status: boolean; peers: readonly AccountGroup["account"][] }) {
  const { a, today, dd, ddUse } = figures(line);
  const num = "whitespace-nowrap text-right font-mono tabular-nums";
  return (
    <>
      <Cell><Name line={line} isPublic={isPublic} peers={peers} /></Cell>
      <Cell className="text-muted">{a.currency}</Cell>
      <Cell className={num}><span title={`Balance ${money(a.balance)} · open ${signedMoney(a.equity - a.balance)}`}>{money(a.equity)}</span></Cell>
      <Cell className={num}>
        {line.pending ? <Pending /> : today ? <TodayFigure split={today} note={line.note ?? null} realized={line.realizedToday!} /> : <span className="text-muted">{DASH}</span>}
      </Cell>
      <Cell className={num}><OpenRiskCell open={line.open} /></Cell>
      <Cell className={`${num} ${ddTone(ddUse)}`}>{line.pending ? <Pending /> : dd == null ? <span className="text-muted">{DASH}</span> : pctValue(dd, 2)}</Cell>
      {status && <Cell className="whitespace-nowrap"><Updated line={line} isPublic={isPublic} /></Cell>}
    </>
  );
}

/** A phone's account: name and Today on the first line; equity and drawdown on the second. */
function AccountCard({ line, isPublic, peers }: { line: AccountLine; isPublic: boolean; peers: readonly AccountGroup["account"][] }) {
  const { a, today, dd, ddUse } = figures(line);
  return (
    <>
      <div className="flex items-baseline gap-2">
        <Name line={line} isPublic={isPublic} peers={peers} />
        <span className="ml-auto shrink-0 text-right font-mono text-sm tabular-nums">{line.pending ? <Pending /> : today ? <TodayFigure split={today} note={line.note ?? null} realized={line.realizedToday!} /> : <span className="text-muted">{DASH}</span>}</span>
      </div>
      <div className="mt-1 flex items-center gap-x-3 text-xs text-muted">
        <span title={`Balance ${money(a.balance)}`}>equity <span className="font-mono tabular-nums">{money(a.equity)}</span> {a.currency}</span>
        <span>drawdown <span className={`font-mono tabular-nums ${ddTone(ddUse)}`}>{line.pending ? "…" : dd == null ? DASH : pctValue(dd, 2)}</span></span>
        {a.stale && <span className="ml-auto"><Updated line={line} isPublic={isPublic} /></span>}
      </div>
    </>
  );
}

/** A figure still loading: a flat bar the height of the figure, never a dash that reads as "none". */
function Pending() {
  return <span className="inline-block h-3.5 w-16 rounded bg-raised align-middle" role="status" aria-label="loading" />;
}

/**
 * An account's Today: what your strategies made (closes since the day began and their listed positions' floating).
 * Anything else on the account (another system on the same login, trades not listed here) and the account's own
 * total are in the tooltip, and a dotted underline says there is more than the figure.
 */
function TodayFigure({ split, note, realized }: { split: TodaySplit; note: FloatingNote | null; realized: number }) {
  const parts = [`${splitTotalWords(split)} ${signedMoney(split.total)}`, `${signedMoney(realized)} closed`, `${signedMoney(split.qkt - realized)} open on your strategies' positions`];
  if (split.other != null) parts.push(`${signedMoney(split.other)} ${splitOtherWords(split)}`);
  if (split.unassigned !== 0 && note) parts.push(`${signedMoney(split.unassigned)} on trades not listed here (${floatingNoteText(note)})`);
  const other = roundMoney((split.other ?? 0) + split.unassigned, 2);
  return (
    <span className={other !== 0 ? "cursor-help underline decoration-line-strong decoration-dotted underline-offset-4" : ""} title={parts.join(" · ")}>
      <Pnl value={split.qkt} />
    </span>
  );
}
