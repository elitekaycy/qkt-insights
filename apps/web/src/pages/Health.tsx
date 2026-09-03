import { Fragment, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type HealthRow, type LiveAccount, type LiveStateSnapshot, type MonitorSummary, type MonitorsView, type StripBucket } from "../api";
import { Cell, DataList, Empty, LiveDot, PageHeader, Panel, Pill, Row, Skeleton, Stat, Table, type Tone } from "../components/ui";
import { age, duration, money, pct, tsDay, tsShort } from "../format";

function sinkTone(row: HealthRow): "neutral" | "up" | "down" {
  if (row.insightsSent == null) return "neutral";
  return (row.insightsFailed ?? 0) > 0 || (row.insightsDropped ?? 0) > 0 ? "down" : "up";
}

function journalLabel(row: HealthRow): string {
  if (row.insightsSent == null) return "unknown";
  if (!row.insightsJournalEnabled) return "off";
  return `${row.insightsJournalPending ?? 0} pending`;
}

const STATUS_TONE: Record<MonitorSummary["status"], Tone> = { up: "up", down: "down", pending: "neutral" };

const BEAT_CLASS: Record<"up" | "down" | "none", string> = { up: "bg-up", down: "bg-down", none: "bg-line" };

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function beatLabel(b: StripBucket, spanMs: number): string {
  const when = `${tsShort(b.ts)}–${clock(b.ts + spanMs)}`;
  if (b.status == null) return `${when} · no checks`;
  if (b.status === "up") return `${when} · up · ${b.checks} checks`;
  return `${when} · down · ${b.downs} of ${b.checks} checks failed`;
}

/**
 * Last 24h, oldest first; a beat is 30 minutes, red if any check in it failed, grey with
 * no checks. One focus stop per strip: hover or drag to scrub, arrow keys to step; the
 * picked beat's detail is read out in the caption instead of a hover-only tooltip so
 * touch and keyboard get the same information.
 */
function UptimeStrip({ strip, name }: { strip: StripBucket[]; name: string }) {
  const [pick, setPick] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const last = strip.length - 1;
  const spanMs = strip.length > 1 ? strip[1]!.ts - strip[0]!.ts : 0;
  const downs = strip.filter((b) => b.status === "down").length;
  const gaps = strip.filter((b) => b.status == null).length;
  const clamp = (i: number) => Math.min(last, Math.max(0, i));

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setPick(clamp(Math.floor(((e.clientX - box.left) / box.width) * strip.length)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: (pick ?? last) - 1, ArrowRight: (pick ?? -1) + 1, Home: 0, End: last };
    const next = step[e.key];
    if (next == null) {
      if (e.key === "Escape") setPick(null);
      return;
    }
    e.preventDefault();
    setPick(clamp(next));
  };
  const picked = pick == null ? null : strip[pick]!;

  return (
    <div>
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={`${name}, last 24 hours: ${downs} of ${strip.length} half-hours with downtime, ${gaps} unchecked. Arrow keys step through beats.`}
        onPointerMove={fromPointer}
        onPointerDown={fromPointer}
        onPointerLeave={() => setPick(null)}
        onBlur={() => setPick(null)}
        onKeyDown={onKey}
        className="flex h-6 cursor-crosshair touch-pan-y items-stretch gap-[3px] rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        {strip.map((b, i) => (
          <span
            key={b.ts}
            aria-hidden
            className={`min-w-[3px] flex-1 rounded-[3px] transition-[transform,opacity] duration-100 motion-reduce:transition-none ${BEAT_CLASS[b.status ?? "none"]} ${
              pick == null ? "" : i === pick ? "scale-y-125 ring-2 ring-bright/80 motion-reduce:scale-y-100" : "opacity-50"
            }`}
          />
        ))}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-faint">
        <span className="shrink-0">24h ago</span>
        <span aria-live="polite" className={`min-w-0 truncate font-mono ${picked?.status === "down" ? "text-down" : "text-muted"}`}>
          {picked ? beatLabel(picked, spanMs) : ""}
        </span>
        <span className="shrink-0">now</span>
      </div>
    </div>
  );
}

function uptimeTone(v: number | null): string {
  if (v == null) return "text-faint";
  return v >= 0.999 ? "text-up" : v >= 0.99 ? "text-bright" : v >= 0.95 ? "text-warn" : "text-down";
}

function sinceLabel(m: MonitorSummary): string {
  if (m.since == null) return "waiting for the first check";
  return `${m.status} for ${duration(Date.now() - m.since)}`;
}

function MonitorRow({ m }: { m: MonitorSummary }) {
  const target = m.kind === "http" ? m.target : "qkt heartbeat · 30s pulse";
  return (
    <li className="px-4 py-3.5 transition-colors hover:bg-raised/40 focus-within:bg-raised/40">
      <div className="flex items-center gap-3">
        <LiveDot on={m.status === "up"} down={m.status === "down"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-bright">{m.name}</span>
            <Pill tone={STATUS_TONE[m.status]}>{m.status}</Pill>
          </div>
          <div className="truncate font-mono text-[11px] text-faint" title={target}>
            {target}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-mono text-lg font-semibold leading-tight ${uptimeTone(m.uptime24h)}`}>{pct(m.uptime24h)}</div>
          <div className="text-[11px] uppercase tracking-[0.1em] text-faint">24h</div>
        </div>
      </div>
      <div className="mt-2.5 sm:pl-5">
        <UptimeStrip strip={m.strip} name={m.name} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted sm:pl-5">
        <span>
          30d <span className={`font-mono ${uptimeTone(m.uptime30d)}`}>{pct(m.uptime30d)}</span>
        </span>
        {m.status === "down" ? (
          <span className="text-down">{m.detail ?? "check failed"}</span>
        ) : (
          m.latencyMs != null && (
            <span>
              <span className="font-mono text-bright">{m.latencyMs}</span> ms
            </span>
          )
        )}
        <span>{sinceLabel(m)}</span>
        {m.lastCheck != null && <span className="ml-auto">checked {age(m.lastCheck)}</span>}
      </div>
    </li>
  );
}

/** The glance row: how much of the fleet is alive right now. */
function FleetStats({ monitors, rows, accounts }: { monitors: MonitorSummary[]; rows: HealthRow[]; accounts: LiveAccount[] }) {
  const daemons = monitors.filter((m) => m.kind === "heartbeat");
  const daemonsUp = daemons.filter((m) => m.status === "up").length;
  const strategies = rows.reduce((n, r) => n + r.strategies, 0);
  const accountsLive = accounts.filter((a) => !a.stale).length;
  const down = monitors.filter((m) => m.status === "down");
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Stat label="daemons up" value={`${daemonsUp} / ${daemons.length}`} tone={daemons.length > 0 && daemonsUp === daemons.length ? "up" : daemonsUp < daemons.length ? "down" : "neutral"} sub="qkt instances with a live heartbeat" stagger={1} />
      <Stat label="strategies" value={strategies} sub="deployed across all daemons" stagger={2} />
      <Stat label="broker accounts" value={`${accountsLive} / ${accounts.length}`} tone={accounts.length > 0 && accountsLive === accounts.length ? "up" : accountsLive < accounts.length ? "down" : "neutral"} sub="polled within 30s" stagger={3} />
      <Stat label="monitors down" value={down.length} tone={down.length > 0 ? "down" : "up"} sub={down.length > 0 ? down.map((m) => m.name).join(", ") : "everything is answering"} stagger={4} />
    </div>
  );
}

function Monitors({ view, loading, failed }: { view: MonitorsView | undefined; loading: boolean; failed: boolean }) {
  const monitors = view?.monitors ?? [];
  const events = view?.events ?? [];
  return (
    <>
      <Panel
        className="mt-6"
        stagger={1}
        title="Uptime"
        hint="checked every 30s · down after 3 straight failures · each beat is 30 min, red if any check failed, grey when nothing was checking"
      >
        {loading && <Skeleton lines={3} className="p-4" />}
        {failed && !view && <div className="px-4 py-10 text-center text-sm text-down">Could not load monitors from the collector. Retrying.</div>}
        <ul className="divide-y divide-line/60">
          {!loading && !failed && monitors.length === 0 && (
            <li className="px-4 py-10 text-center text-sm text-faint">
              No monitors yet. Heartbeats appear once a qkt instance reports; add HTTP probes with INSIGHTS_MONITORS.
            </li>
          )}
          {monitors.map((m) => (
            <MonitorRow key={m.name} m={m} />
          ))}
        </ul>
      </Panel>

      <Panel className="mt-6" stagger={2} title="Incidents" hint="every up/down transition, newest first" scroll="max-h-[24rem]">
        <DataList
          head={["When", "Monitor", "Status", "Reason"]}
          rows={events}
          keyOf={(e) => `${e.monitor}:${e.ts}`}
          empty="No transitions recorded."
          cells={(e) => (
            <>
              <Cell className="whitespace-nowrap font-mono text-muted">{tsDay(e.ts)}</Cell>
              <Cell className="font-semibold text-bright">{e.monitor}</Cell>
              <Cell>
                <Pill tone={STATUS_TONE[e.status]}>{e.status}</Pill>
              </Cell>
              <Cell className="text-muted">{e.detail ?? "—"}</Cell>
            </>
          )}
          card={(e) => (
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold text-bright">{e.monitor}</span>
              <Pill tone={STATUS_TONE[e.status]}>{e.status}</Pill>
              <span className="ml-auto whitespace-nowrap font-mono text-xs text-muted">{tsShort(e.ts)}</span>
            </div>
          )}
        />
      </Panel>
    </>
  );
}

function accountSummary(accounts: LiveAccount[]): LiveAccount | null {
  if (accounts.length === 0) return null;
  return accounts.reduce((best, cur) => (cur.lastSeen > best.lastSeen ? cur : best), accounts[0]!);
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-[0.1em] text-faint">{label}</div>
      <div className={`truncate ${mono ? "font-mono" : ""} text-bright`}>{children}</div>
    </div>
  );
}

/** Collector delivery counters plus every broker account the instance reports. */
function InstanceDetail({ row, accounts }: { row: HealthRow; accounts: LiveAccount[] }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_2fr]">
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Collector delivery</div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Fact label="sent" mono>
            {row.insightsSent ?? "—"}
          </Fact>
          <Fact label="queued" mono>
            {row.insightsQueued ?? "—"}
          </Fact>
          <Fact label="health pulse" mono>
            {row.insightsHealthTs == null ? "—" : age(row.insightsHealthTs)}
          </Fact>
          <Fact label="journal" mono>
            {journalLabel(row)}
          </Fact>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-panel">
        <DataList
          head={["Broker", "Status", "Last poll", "Balance", "Equity", "Open P&L", "Server"]}
          rows={accounts}
          keyOf={(a) => `${a.instanceId}:${a.broker}`}
          empty="No broker account state yet — waiting for the state poller."
          cells={(a) => (
            <>
              <Cell className="font-semibold text-bright">{a.login ? `${a.broker} · #${a.login}` : a.broker}</Cell>
              <Cell>
                <Pill tone={a.stale ? "neutral" : "up"}>{a.stale ? "stale" : "live"}</Pill>
              </Cell>
              <Cell className="whitespace-nowrap text-muted">{age(a.lastSeen)}</Cell>
              <Cell className="font-mono text-muted">{money(a.balance)}</Cell>
              <Cell className="font-mono text-bright">{money(a.equity)}</Cell>
              <Cell className={`font-mono ${openTone(a.openProfit)}`}>{money(a.openProfit)}</Cell>
              <Cell className="text-muted">{a.server ?? a.name ?? "—"}</Cell>
            </>
          )}
          card={(a) => (
            <>
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-bright">{a.login ? `${a.broker} · #${a.login}` : a.broker}</span>
                <Pill tone={a.stale ? "neutral" : "up"}>{a.stale ? "stale" : "live"}</Pill>
                <span className="ml-auto whitespace-nowrap text-xs text-muted">{age(a.lastSeen)}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
                <Fact label="balance" mono>
                  {money(a.balance)}
                </Fact>
                <Fact label="equity" mono>
                  {money(a.equity)}
                </Fact>
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.1em] text-faint">open p&l</div>
                  <div className={`truncate font-mono ${openTone(a.openProfit)}`}>{money(a.openProfit)}</div>
                </div>
              </div>
            </>
          )}
        />
      </div>
    </div>
  );
}

function openTone(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-muted";
  return v > 0 ? "text-up" : "text-down";
}

export default function Health() {
  const [openInstance, setOpenInstance] = useState<string | null>(null);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 5000,
  });
  const liveState = useQuery({
    queryKey: ["live-state"],
    queryFn: () => get<LiveStateSnapshot>("/live/state"),
    refetchInterval: 5000,
  });
  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => get<MonitorsView>("/health/monitors"),
    refetchInterval: 5000,
  });

  const rows = health.data ?? [];
  const accounts = liveState.data?.accounts ?? [];

  return (
    <div>
      <PageHeader title="Health" sub="Uptime, runtime status, collector delivery, and broker account truth in one place." />

      <FleetStats monitors={monitors.data?.monitors ?? []} rows={rows} accounts={accounts} />

      <Monitors view={monitors.data} loading={monitors.isLoading} failed={monitors.isError} />

      <Panel className="mt-6" stagger={3} title="Runtime health" hint="live = recent qkt envelope or broker account poll within 30s" scroll="max-h-[72vh]">
        <ul className="divide-y divide-line/60 sm:hidden">
          {rows.length === 0 && (
            <li className="px-4 py-10 text-center text-sm text-faint">No instances reporting yet — enable the insights block on a qkt instance.</li>
          )}
          {rows.map((r) => {
            const rowAccounts = accounts.filter((a) => a.instanceId === r.instanceId);
            const acct = accountSummary(rowAccounts);
            const fresh = Date.now() - r.lastSeen < 30_000 || (acct != null && !acct.stale);
            const expanded = openInstance === r.instanceId;
            return (
              <li key={r.instanceId} className="px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <LiveDot on={fresh} />
                  <span className="truncate font-semibold text-bright">{r.instanceId}</span>
                  <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                  <span className="ml-auto whitespace-nowrap text-xs text-muted">{age(r.lastSeen)}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <Fact label="broker">{acct ? (acct.login ? `${acct.broker} · #${acct.login}` : acct.broker) : "—"}</Fact>
                  <Fact label="equity" mono>
                    {acct ? money(acct.equity) : "—"}
                  </Fact>
                  <Fact label="seq" mono>
                    {r.lastSeq}
                  </Fact>
                  <Fact label="strategies" mono>
                    {r.strategies}
                  </Fact>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Pill tone={sinkTone(r)}>
                    {r.insightsSent == null ? "unknown" : `${r.insightsFailed ?? 0} failed · ${r.insightsDropped ?? 0} dropped`}
                  </Pill>
                  <Pill tone={r.insightsJournalPending == null ? "neutral" : r.insightsJournalPending > 0 ? "warn" : "up"}>
                    journal {journalLabel(r)}
                  </Pill>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpenInstance(expanded ? null : r.instanceId)}
                    className="ml-auto rounded-lg border border-line bg-raised px-3 text-xs font-semibold text-muted transition active:bg-line"
                  >
                    {expanded ? "hide" : "details"}
                  </button>
                </div>
                {expanded && (
                  <div className="mt-3">
                    <InstanceDetail row={r} accounts={rowAccounts} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="hidden sm:block">
        <Table head={["Instance", "Status", "Last event", "Seq", "Strategies", "Broker", "Equity", "Sink", "Journal", ""]}>
          {rows.length === 0 && <Empty colSpan={10}>No instances reporting yet — enable the insights block on a qkt instance.</Empty>}
          {rows.map((r) => {
            const rowAccounts = accounts.filter((a) => a.instanceId === r.instanceId);
            const acct = accountSummary(rowAccounts);
            const eventFresh = Date.now() - r.lastSeen < 30_000;
            const brokerFresh = acct != null && !acct.stale;
            const fresh = eventFresh || brokerFresh;
            const expanded = openInstance === r.instanceId;
            return (
              <Fragment key={r.instanceId}>
                <Row>
                  <Cell className="font-semibold text-bright">
                    <span className="flex items-center gap-2.5">
                      <LiveDot on={fresh} />
                      {r.instanceId}
                    </span>
                  </Cell>
                  <Cell>
                    <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                  </Cell>
                  <Cell className="whitespace-nowrap text-muted">{age(r.lastSeen)}</Cell>
                  <Cell className="font-mono text-muted">{r.lastSeq}</Cell>
                  <Cell className="font-mono text-muted">{r.strategies}</Cell>
                  <Cell className="text-muted">{acct ? (acct.login ? `${acct.broker} · #${acct.login}` : acct.broker) : "—"}</Cell>
                  <Cell className="font-mono text-bright">{acct ? money(acct.equity) : "—"}</Cell>
                  <Cell>
                    <Pill tone={sinkTone(r)}>
                      {r.insightsSent == null ? "unknown" : `${r.insightsFailed ?? 0} failed · ${r.insightsDropped ?? 0} dropped`}
                    </Pill>
                  </Cell>
                  <Cell>
                    <Pill tone={r.insightsJournalPending == null ? "neutral" : r.insightsJournalPending > 0 ? "warn" : "up"}>
                      {journalLabel(r)}
                    </Pill>
                  </Cell>
                  <Cell className="text-right">
                    <button
                      type="button"
                      onClick={() => setOpenInstance(expanded ? null : r.instanceId)}
                      className="rounded-lg border border-line bg-raised px-2.5 py-1 text-xs font-semibold text-muted transition hover:border-line-strong hover:text-body"
                    >
                      {expanded ? "hide" : "details"}
                    </button>
                  </Cell>
                </Row>
                {expanded && (
                  <tr key={`${r.instanceId}:details`} className="border-b border-line/60">
                    <td colSpan={10} className="bg-ink/35 px-4 py-4">
                      <InstanceDetail row={r} accounts={rowAccounts} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </Table>
        </div>
      </Panel>
    </div>
  );
}
