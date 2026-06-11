import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, logout, Unauthorized, type InstanceRow } from "./api";
import { LiveDot, Select } from "./components/ui";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import Health from "./pages/Health";
import Orderflow from "./pages/Orderflow";
import Strategies from "./pages/Strategies";
import Trades from "./pages/Trades";
import Logs from "./pages/Logs";
import Search from "./pages/Search";
import Equity from "./pages/Equity";

type Page = "overview" | "health" | "strategies" | "orderflow" | "trades" | "equity" | "logs" | "search";

const ICONS: Record<Page, string> = {
  overview: "M3 13h5v8H3zM10 7h5v14h-5zM17 3h5v18h-5z",
  health: "M22 12h-4l-3 9L9 3l-3 9H2",
  strategies: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  orderflow: "M7 16V4M7 4L3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4",
  trades: "M4 7h16M4 12h16M4 17h10",
  equity: "M3 3v18h18M8 15l4-6 4 3 4-7",
  logs: "M5 4h14M5 9h14M5 14h9M5 19h6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
};

/** Nav groups; "All strategies" renders above the instance selector. */
const ALL_STRATEGIES: { key: Page; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "equity", label: "Equity" },
];

const PER_INSTANCE: { section: string; items: { key: Page; label: string }[] }[] = [
  {
    section: "Performance",
    items: [
      { key: "strategies", label: "Strategies" },
      { key: "trades", label: "Trades" },
    ],
  },
  {
    section: "Monitor",
    items: [
      { key: "orderflow", label: "Orderflow" },
      { key: "logs", label: "Logs" },
      { key: "health", label: "Health" },
    ],
  },
  { section: "Find", items: [{ key: "search", label: "Search" }] },
];

function NavIcon({ d, big }: { d: string; big?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${big ? "h-5 w-5" : "h-4 w-4"} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 200 200" className="h-7 w-7 shrink-0">
      <g fill="none" strokeWidth="14">
        <g stroke="#a78bfa" strokeLinejoin="miter">
          <path d="M56 50H34v100h22" />
          <path d="M143 50h22v100h-22" />
        </g>
        <path d="M100 80v70" stroke="var(--color-bright)" strokeLinecap="round" />
      </g>
      <circle cx="100" cy="62" r="7" fill="var(--color-accent)" />
    </svg>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>("overview");
  const [instance, setInstance] = useState<string | null>(null);
  const [focusStrategy, setFocusStrategy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const instances = useQuery({
    queryKey: ["instances"],
    queryFn: () => get<InstanceRow[]>("/instances"),
    refetchInterval: 15000,
  });

  if (instances.error instanceof Unauthorized) {
    return <Login onLoggedIn={() => queryClient.invalidateQueries()} />;
  }
  if (instances.isPending) {
    return <div className="h-screen bg-ink" />;
  }

  const list = instances.data ?? [];
  const selected = instance ?? list[0]?.id ?? null;
  const selectedRow = list.find((i) => i.id === selected);
  const live = selectedRow != null && Date.now() - selectedRow.lastSeen < 30_000;

  const goto = (p: Page) => {
    setPage(p);
    setDrawer(false);
  };

  const navButton = (n: { key: Page; label: string }, iconsOnly: boolean) => {
    const active = page === n.key;
    return (
      <button
        key={n.key}
        onClick={() => goto(n.key)}
        title={n.label}
        className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
          iconsOnly ? "justify-center px-0 py-2.5" : ""
        } ${active ? "bg-accent text-ink" : "text-muted hover:bg-raised hover:text-body"}`}
      >
        <NavIcon d={ICONS[n.key]} big={iconsOnly} />
        {!iconsOnly && n.label}
      </button>
    );
  };

  const sidebar = (iconsOnly: boolean) => (
    <>
      <div className={`flex items-center gap-2.5 px-5 pb-4 pt-5 ${iconsOnly ? "justify-center px-0" : ""}`}>
        <Mark />
        {!iconsOnly && (
          <div className="text-[15px] font-extrabold tracking-tight text-bright">
            qkt<span className="text-accent">·</span>insights
          </div>
        )}
      </div>

      <div className={iconsOnly ? "px-2" : "px-4"}>
        {!iconsOnly && (
          <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-faint">All strategies</div>
        )}
        {ALL_STRATEGIES.map((n) => navButton(n, iconsOnly))}
      </div>

      <div className={`mt-3 ${iconsOnly ? "px-2" : "px-4"}`}>
        {iconsOnly ? (
          <div className="flex justify-center py-2" title={selected ?? "no instance"}>
            <LiveDot on={live} />
          </div>
        ) : (
          <div className="rounded-card border border-line bg-raised p-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Instance</span>
              <LiveDot on={live} />
            </div>
            <Select
              className="mt-2 w-full border-line-strong bg-panel"
              value={selected ?? ""}
              onChange={(e) => setInstance(e.target.value)}
            >
              {list.length === 0 && <option value="">no instances yet</option>}
              {list.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name ?? i.id}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      <nav className={`mt-1 flex-1 overflow-y-auto pb-4 ${iconsOnly ? "px-2" : "px-4"}`}>
        {PER_INSTANCE.map((group) => (
          <div key={group.section} className="mt-4">
            {!iconsOnly && (
              <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-faint">
                {group.section}
              </div>
            )}
            {group.items.map((n) => navButton(n, iconsOnly))}
          </div>
        ))}
      </nav>

      <div className={`border-t border-line p-3 ${iconsOnly ? "px-2" : "px-4"}`}>
        <button
          onClick={async () => {
            await logout();
            queryClient.invalidateQueries();
          }}
          title="Sign out"
          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:bg-raised hover:text-body ${
            iconsOnly ? "justify-center px-0" : ""
          }`}
        >
          <NavIcon d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" big={iconsOnly} />
          {!iconsOnly && "Sign out"}
        </button>
      </div>
    </>
  );

  const main = (
    <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      {page === "overview" && (
        <Overview
          instanceId={selected}
          onOpenStrategy={(id) => {
            setFocusStrategy(id);
            setPage("strategies");
          }}
        />
      )}
      {page === "health" && <Health />}
      {page === "strategies" && (
        <Strategies key={focusStrategy ?? "all"} instanceId={selected} focus={focusStrategy} onClearFocus={() => setFocusStrategy(null)} />
      )}
      {page === "orderflow" && <Orderflow instanceId={selected} />}
      {page === "trades" && <Trades instanceId={selected} />}
      {page === "equity" && <Equity instanceId={selected} />}
      {page === "logs" && <Logs instanceId={selected} />}
      {page === "search" && <Search instanceId={selected} />}
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-ink text-body lg:flex-row">
      {/* mobile top bar */}
      <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-3 lg:hidden">
        <button
          onClick={() => setDrawer(true)}
          aria-label="open menu"
          className="rounded-lg border border-line bg-raised p-2 text-body"
        >
          <NavIcon d="M4 6h16M4 12h16M4 18h16" />
        </button>
        <Mark />
        <div className="text-[15px] font-extrabold tracking-tight text-bright">
          qkt<span className="text-accent">·</span>insights
        </div>
        <span className="ml-auto">
          <LiveDot on={live} />
        </span>
      </div>

      {/* mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 bg-ink/70 backdrop-blur-md lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <aside className="flex h-full w-72 flex-col border-r border-line bg-panel">{sidebar(false)}</aside>
        </div>
      )}

      {/* desktop sidebar */}
      <aside
        className={`relative hidden shrink-0 flex-col border-r border-line bg-panel transition-all lg:flex ${
          collapsed ? "w-[4.25rem]" : "w-60"
        }`}
      >
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

      <main className="min-h-0 flex-1 overflow-auto">{main}</main>
    </div>
  );
}
