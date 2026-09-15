import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, NotFound, type PublicMeta } from "./api";
import { Drawer } from "./components/Drawer";
import { ICONS, Mark, NavIcon, type Page } from "./components/chrome";
import { tsShort } from "./format";
import Overview from "./pages/Overview";
import Strategies, { SharedPortfolio, StrategyDetail } from "./pages/Strategies";
import Trades from "./pages/Trades";
import Equity from "./pages/Equity";
import { Edge } from "./pages/Edge";
import { useBrand } from "./useBrand";
import { ViewProvider } from "./view";

type SharedPage = Extract<Page, "overview" | "equity" | "strategies" | "edge" | "trades">;

const NAV: { section: string; items: { key: SharedPage; label: string }[] }[] = [
  { section: "All strategies", items: [{ key: "overview", label: "Overview" }, { key: "equity", label: "Equity" }] },
  { section: "Performance", items: [{ key: "strategies", label: "Strategies" }, { key: "edge", label: "Edge" }, { key: "trades", label: "Trades" }] },
];

function Wordmark({ brand, iconsOnly = false }: { brand: string | null; iconsOnly?: boolean }) {
  return (
    <div className={`flex min-w-0 items-center gap-3 ${iconsOnly ? "justify-center" : ""}`}>
      <Mark />
      <div className={`min-w-0 ${iconsOnly ? "hidden" : ""}`}>
        <div className="text-lg font-extrabold leading-tight tracking-tight text-bright">
          qkt<span className="text-accent">·</span>insights
        </div>
        {brand && <div className="truncate text-xs font-semibold text-accent">{brand}</div>}
      </div>
    </div>
  );
}

function DelayNote({ meta }: { meta: PublicMeta }) {
  return (
    <div className="text-xs leading-relaxed text-faint">
      Read-only shared view. Figures run {meta.delayMinutes} minutes behind; as of {tsShort(meta.asOf)}.
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="pad-safe-top pad-safe-bottom flex h-screen flex-col items-center justify-center gap-4 bg-ink px-6 text-center">{children}</div>;
}

/** Everything a shared link can show: an instance overview, a portfolio, or one strategy. */
export default function PublicApp() {
  const brand = useBrand();
  const meta = useQuery({
    queryKey: ["public-meta"],
    queryFn: () => get<PublicMeta>("/meta"),
    // A revoked link is final; anything else (busy, offline) is worth retrying.
    retry: (failures, error) => !(error instanceof NotFound) && failures < 5,
    retryDelay: (attempt) => Math.min(10_000, 1000 * 2 ** attempt),
    refetchInterval: 60_000,
  });

  if (meta.isPending) {
    return (
      <Centered>
        <Mark />
        <div className="flex items-center gap-2.5 text-sm text-muted">
          <span className="live-dot inline-block h-2 w-2 rounded-full bg-accent" />
          Loading…
        </div>
      </Centered>
    );
  }
  if (meta.isError && !(meta.error instanceof NotFound) && !meta.data) {
    return (
      <Centered>
        <Mark />
        <div className="text-lg font-bold text-bright">Temporarily unavailable</div>
        <div className="max-w-sm text-sm leading-relaxed text-muted">The dashboard is busy or unreachable. Try again in a minute.</div>
        <button type="button" onClick={() => void meta.refetch()} className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-ink">
          Retry
        </button>
      </Centered>
    );
  }
  if (meta.isError || !meta.data) {
    return (
      <Centered>
        <Mark />
        <div className="text-lg font-bold text-bright">This link is not available</div>
        <div className="max-w-sm text-sm leading-relaxed text-muted">It may have been made private or replaced by a new link. Ask whoever shared it for a current one.</div>
      </Centered>
    );
  }

  const m = meta.data;
  return (
    <ViewProvider view={{ public: true, meta: m }}>
      {m.kind === "overview" ? (
        <SharedOverview meta={m} brand={brand} />
      ) : (
        <div className="min-h-screen bg-ink text-body">
          <header className="pad-safe-top flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel px-4 py-3 sm:px-6">
            <Wordmark brand={brand} />
            <DelayNote meta={m} />
          </header>
          <main className="pad-safe-bottom mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            {m.kind === "portfolio" ? (
              <SharedPortfolio instanceId={m.instanceId} portfolioId={m.subject} />
            ) : (
              <StrategyDetail instanceId={m.instanceId} strategyId={m.subject} />
            )}
          </main>
        </div>
      )}
    </ViewProvider>
  );
}

function SharedOverview({ meta, brand }: { meta: PublicMeta; brand: string | null }) {
  const [page, setPage] = useState<SharedPage>("overview");
  const [focus, setFocus] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const goto = (p: SharedPage) => {
    setPage(p);
    setDrawer(false);
  };

  const sidebar = (iconsOnly: boolean) => (
    <>
      <div className={`pb-5 pt-6 ${iconsOnly ? "px-0" : "px-5"}`}>
        <Wordmark brand={brand} iconsOnly={iconsOnly} />
      </div>
      {!iconsOnly && (
        <div className="px-4">
          <div className="rounded-card border border-line bg-raised p-3.5">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Shared view</div>
            <div className="mt-1.5 truncate text-[15px] font-semibold text-bright">{meta.instanceId}</div>
          </div>
        </div>
      )}
      <nav className={`mt-1 flex-1 overflow-y-auto pb-4 ${iconsOnly ? "px-2" : "px-4"}`}>
        {NAV.map((group) => (
          <div key={group.section} className="mt-4">
            {!iconsOnly && <div className="px-3.5 pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-faint">{group.section}</div>}
            {group.items.map((n) => {
              const active = page === n.key;
              return (
                <button
                  key={n.key}
                  onClick={() => goto(n.key)}
                  title={n.label}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left text-[15px] font-medium transition active:scale-[0.98] ${
                    iconsOnly ? "justify-center px-0" : ""
                  } ${active ? "bg-accent text-ink" : "text-muted hover:bg-raised hover:text-body"}`}
                >
                  <NavIcon d={ICONS[n.key]} big />
                  {!iconsOnly && n.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      {!iconsOnly && (
        <div className="border-t border-line p-4">
          <DelayNote meta={meta} />
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-screen flex-col bg-ink text-body lg:flex-row">
      <div className="pad-safe-top sticky top-0 z-30 flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2.5 lg:hidden">
        <button onClick={() => setDrawer(true)} aria-label="open menu" aria-expanded={drawer} className="-ml-1 rounded-lg p-2.5 text-body transition active:bg-raised">
          <NavIcon d="M4 6h16M4 12h16M4 18h16" big />
        </button>
        <Mark />
        <div className="min-w-0 truncate text-[15px] font-extrabold tracking-tight text-bright">{brand ?? meta.instanceId}</div>
      </div>
      <Drawer open={drawer} onClose={() => setDrawer(false)} label="shared navigation">
        {sidebar(false)}
      </Drawer>
      <aside className={`pad-safe-left relative hidden shrink-0 flex-col border-r border-line bg-panel transition-all lg:flex ${collapsed ? "w-[4.5rem]" : "w-[17rem]"}`}>
        {sidebar(collapsed)}
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "expand sidebar" : "collapse sidebar"}
          title={collapsed ? "expand sidebar" : "collapse sidebar"}
          className="absolute -right-3 top-7 rounded-full border border-line bg-raised p-1 text-muted transition hover:border-line-strong hover:text-body"
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d={collapsed ? "M9 18l6-6-6-6" : "M15 18l-6-6 6-6"} />
          </svg>
        </button>
      </aside>
      <main className="pad-safe-bottom min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          {page === "overview" && (
            <Overview
              instanceId={meta.instanceId}
              onOpenStrategy={(id) => {
                setFocus(id);
                setPage("strategies");
              }}
            />
          )}
          {page === "equity" && <Equity instanceId={meta.instanceId} />}
          {page === "strategies" && <Strategies key={focus ?? "all"} instanceId={meta.instanceId} focus={focus} onClearFocus={() => setFocus(null)} />}
          {page === "edge" && <Edge instanceId={meta.instanceId} />}
          {page === "trades" && <Trades instanceId={meta.instanceId} />}
        </div>
      </main>
    </div>
  );
}
