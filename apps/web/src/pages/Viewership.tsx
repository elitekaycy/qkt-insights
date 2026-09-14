import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type StrategyRow, type ViewBreakdown, type ViewRow, type ViewSummary } from "../api";
import { ChartCard } from "../components/ChartCard";
import { ViewsChart } from "../components/ViewsChart";
import { Card, Cell, DataList, Loadable, LoadMore, PageHeader, Panel, Pill, SearchInput, Select, Stat, TimeCell } from "../components/ui";
import { tsShort } from "../format";
import { strategyDisplayName } from "../portfolio";
import { fillDays, linkLabel, withShares } from "../viewership";

const RANGES = [
  { key: "24h", label: "Last 24h", ms: 86_400_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { key: "90d", label: "Last 90 days", ms: 90 * 86_400_000 },
] as const;
type Range = (typeof RANGES)[number]["key"];

const PAGE_LABELS: Record<string, string> = {
  overview: "Overview",
  equity: "Equity",
  strategies: "Strategies",
  edge: "Edge",
  trades: "Trades",
  strategy: "Strategy page",
  portfolio: "Portfolio page",
};

function splitLink(value: string): [string, string] {
  const i = value.indexOf(":");
  return [value.slice(0, i), value.slice(i + 1)];
}

function BreakdownPanel({
  title,
  hint,
  rows,
  total,
  empty,
  label = (k) => k ?? "unknown",
}: {
  title: string;
  hint: string;
  rows: ViewBreakdown[];
  total: number;
  empty: string;
  label?: (key: string | null) => string;
}) {
  const shares = withShares(rows, total);
  return (
    <Panel title={title} hint={hint}>
      {shares.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-faint">{empty}</div>
      ) : (
        <ul className="divide-y divide-line">
          {shares.slice(0, 10).map((r) => (
            <li key={r.key ?? "(none)"} className="relative px-4 py-2.5">
              <div className="absolute inset-y-1 left-0 rounded-r bg-accent/10" style={{ width: `${Math.max(2, r.share * 100)}%` }} aria-hidden />
              <div className="relative flex items-baseline justify-between gap-3 text-sm">
                <span className={`min-w-0 truncate ${r.key == null ? "text-faint" : "text-body"}`}>{label(r.key)}</span>
                <span className="shrink-0 font-mono text-xs text-muted">
                  {r.views} · {(r.share * 100).toFixed(r.share < 0.1 ? 1 : 0)}%
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Who opened the shared links, from what, where, and which pages they read. */
export default function Viewership({ instanceId }: { instanceId: string | null }) {
  const [range, setRange] = useState<Range>("30d");
  const [link, setLink] = useState("");
  const [q, setQ] = useState("");
  const [cap, setCap] = useState(30);
  const filter = link ? `&kind=${encodeURIComponent(splitLink(link)[0])}&subject=${encodeURIComponent(splitLink(link)[1])}` : "";

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });
  const summary = useQuery({
    queryKey: ["views-summary", instanceId, range, link],
    queryFn: () => get<ViewSummary>(`/views/summary?instance=${encodeURIComponent(instanceId!)}&range=${range}${filter}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  const allLinks = useQuery({
    queryKey: ["views-summary", instanceId, range, ""],
    queryFn: () => get<ViewSummary>(`/views/summary?instance=${encodeURIComponent(instanceId!)}&range=${range}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  const recent = useQuery({
    queryKey: ["views-list", instanceId, link, q],
    queryFn: () => get<ViewRow[]>(`/views?instance=${encodeURIComponent(instanceId!)}&limit=1000${filter}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });

  const names = useMemo(() => new Map((strategies.data ?? []).map((s) => [s.strategyId, strategyDisplayName(s)])), [strategies.data]);
  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const s = summary.data;
  const total = s?.views ?? 0;
  const span = RANGES.find((r) => r.key === range)!.ms;
  const now = Date.now();
  const days = s ? fillDays(s.daily, now - span, now) : [];
  const rows = recent.data ?? [];

  return (
    <div>
      <PageHeader
        title="Viewership"
        sub="Who opens your shared links. No cookies and no stored IP addresses; a visitor is counted once per UTC day."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setCap(30);
              }}
            >
              <option value="">All links</option>
              {(allLinks.data?.links ?? []).map((l) => (
                <option key={`${l.kind}:${l.subject}`} value={`${l.kind}:${l.subject}`}>
                  {linkLabel(l.kind, l.subject, names)}
                </option>
              ))}
            </Select>
            <Select value={range} onChange={(e) => setRange(e.target.value as Range)}>
              {RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      <Loadable loading={summary.isPending} error={summary.isError} retry={() => summary.refetch()} what="viewership" lines={3}>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Views" value={String(total)} sub="repeats within 30 min count once" stagger={0} />
          <Stat label="Unique visitors" value={String(s?.visitors ?? 0)} sub="summed per UTC day" stagger={1} />
          <Stat label="Links viewed" value={String(s?.links.length ?? 0)} stagger={2} />
          <Stat label="Countries" value={String((s?.countries ?? []).filter((c) => c.key != null).length)} sub="needs Cloudflare in front" stagger={3} />
        </div>

        <ChartCard className="mt-6" title="Views per day" description="Bars are views, the line is unique visitors that day" meta={`UTC days · n = ${total} views`} stagger={2}>
          <ViewsChart days={days} />
        </ChartCard>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {!link && (
            <BreakdownPanel
              title="Links"
              hint="shared overview, portfolio and strategy links"
              total={total}
              empty="No link has been opened yet."
              rows={(s?.links ?? []).map((l) => ({ key: `${l.kind}:${l.subject}`, views: l.views }))}
              label={(k) => (k == null ? "unknown" : linkLabel(...splitLink(k), names))}
            />
          )}
          <BreakdownPanel title="Pages" hint="what visitors read" rows={s?.pages ?? []} total={total} empty="No pages viewed." label={(k) => (k ? (PAGE_LABELS[k] ?? k) : "unknown")} />
          <BreakdownPanel
            title="Strategies"
            hint="strategy pages opened"
            rows={(s?.strategies ?? []).filter((r) => r.key != null)}
            total={total}
            empty="No strategy page opened."
            label={(k) => (k ? (names.get(k) ?? k) : "unknown")}
          />
          <BreakdownPanel title="Browsers" hint="from the user agent" rows={s?.browsers ?? []} total={total} empty="No views." />
          <BreakdownPanel title="Systems" hint="operating system" rows={s?.os ?? []} total={total} empty="No views." />
          <BreakdownPanel title="Devices" hint="desktop, mobile or tablet" rows={s?.devices ?? []} total={total} empty="No views." />
          <BreakdownPanel title="Countries" hint="Cloudflare's country header" rows={s?.countries ?? []} total={total} empty="No views." />
          <BreakdownPanel title="Referrers" hint="the site a visitor came from" rows={s?.referrers ?? []} total={total} empty="No views." label={(k) => k ?? "direct or hidden"} />
          <BreakdownPanel title="Languages" hint="browser language" rows={s?.languages ?? []} total={total} empty="No views." />
        </div>
      </Loadable>

      <Panel
        className="mt-6"
        title="Recent views"
        hint="newest first, last 90 days"
        toolbar={
          <SearchInput
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCap(30);
            }}
            placeholder="search browser, country, referrer…"
            className="w-full sm:w-64"
          />
        }
      >
        <Loadable loading={recent.isPending} error={recent.isError} retry={() => recent.refetch()} what="recent views">
          <DataList
            head={["Time", "Link", "Page", "Browser", "System", "Device", "Country", "Referrer"]}
            rows={rows.slice(0, cap)}
            keyOf={(r) => `${r.ts}-${r.visitor}-${r.page}-${r.strategyId ?? ""}`}
            empty={q ? "No views match the search." : "No views yet."}
            cells={(r) => (
              <>
                <TimeCell ts={r.ts} />
                <Cell className="font-semibold text-bright">{linkLabel(r.kind, r.subject, names)}</Cell>
                <Cell className="text-muted">
                  {PAGE_LABELS[r.page] ?? r.page}
                  {r.strategyId && r.kind !== "strategy" ? ` · ${names.get(r.strategyId) ?? r.strategyId}` : ""}
                </Cell>
                <Cell>{r.browser ?? "—"}</Cell>
                <Cell className="text-muted">{r.os ?? "—"}</Cell>
                <Cell className="text-muted">{r.device ?? "—"}</Cell>
                <Cell className="font-mono text-xs">{r.country ?? "—"}</Cell>
                <Cell className="text-muted">{r.referrer ?? "direct"}</Cell>
              </>
            )}
            card={(r) => (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate font-semibold text-bright">{linkLabel(r.kind, r.subject, names)}</span>
                  <Pill>{PAGE_LABELS[r.page] ?? r.page}</Pill>
                  <span className="ml-auto shrink-0 font-mono text-xs text-faint">{tsShort(r.ts)}</span>
                </div>
                <div className="mt-1 text-xs text-faint">{[r.browser, r.os, r.device, r.country, r.referrer ?? "direct"].filter(Boolean).join(" · ")}</div>
              </>
            )}
          />
          <LoadMore shown={Math.min(cap, rows.length)} total={rows.length} onMore={() => setCap((c) => c + 30)} />
        </Loadable>
      </Panel>
    </div>
  );
}
