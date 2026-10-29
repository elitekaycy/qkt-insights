import { useState, type ReactNode } from "react";
import { Link, PAGE_PATHS, useRoute, type PageKey } from "../router";
import { setTheme, useTheme } from "../theme";
import { Drawer } from "./Drawer";

/*
 * The app shell shared by the signed-in dashboard and the shared-link view: a left rail on
 * desktop (icons + labels, collapsible), a top bar plus bottom tab bar on phones. Navigation is
 * links, so every page has a URL, Back works, and a middle-click opens a new tab.
 */

export const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  strategies: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  trades: "M4 6h16M4 12h16M4 18h10",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  risk: "M3 3v18h18M8 15l4-6 4 3 4-7",
  edge: "M3 3v18h18M7 14h2v4H7zM11 10h2v8h-2zM15 6h2v12h-2z",
  logs: "M5 4h14M5 9h14M5 14h9M5 19h6",
  health: "M22 12h-4l-3 9L9 3l-3 9H2",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",
  collapse: "M15 18l-6-6 6-6",
  expand: "M9 18l6-6-6-6",
} as const;

export function NavIcon({ d, big, className = "" }: { d: string; big?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${big ? "h-[17px] w-[17px]" : "h-4 w-4"} shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

export function Mark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={`shrink-0 ${className}`} aria-hidden>
      <g fill="none" strokeWidth="14">
        <g stroke="var(--color-brand-violet)" strokeLinejoin="miter">
          <path d="M56 50H34v100h22" />
          <path d="M143 50h22v100h-22" />
        </g>
        <path d="M100 80v70" stroke="var(--color-bright)" strokeLinecap="round" />
      </g>
      <circle cx="100" cy="62" r="7" fill="var(--color-tittle)" />
    </svg>
  );
}

/**
 * The "qkt·insights" lockup exactly as the brand draws it, with the deployment name under it. `stacked` sets the
 * mark above the words at a larger size (the splash); the mark itself is the same drawing.
 */
export function Wordmark({ brand, iconsOnly = false, stacked = false }: { brand?: string | null; iconsOnly?: boolean; stacked?: boolean }) {
  if (stacked) {
    return (
      <div className="flex flex-col items-center gap-3">
        <Mark className="h-12 w-12" />
        <div className="text-center">
          <div className="wordmark text-xl leading-tight text-bright">
            qkt<span className="text-tittle">·</span>insights
          </div>
          {brand && <div className="text-sm font-medium text-muted">{brand}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${iconsOnly ? "justify-center" : ""}`}>
      <Mark />
      {!iconsOnly && (
        <div className="min-w-0">
          <div className="wordmark text-[17px] leading-tight text-bright">
            qkt<span className="text-tittle">·</span>insights
          </div>
          {brand && <div className="truncate text-xs font-medium text-muted">{brand}</div>}
        </div>
      )}
    </div>
  );
}

const SUN = "M12 3v1.5M12 19.5V21M4.6 4.6l1.1 1.1M18.3 18.3l1.1 1.1M3 12h1.5M19.5 12H21M4.6 19.4l1.1-1.1M18.3 5.7l1.1-1.1M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z";
const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";

/** Dark/light switch; the choice is remembered per viewer. */
export function ThemeToggle({ iconsOnly = false, className = "" }: { iconsOnly?: boolean; className?: string }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Switch to the ${next} theme`}
      aria-label={`Switch to the ${next} theme`}
      className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-body transition hover:bg-hover hover:text-bright ${
        iconsOnly ? "justify-center px-0" : ""
      } ${className}`}
    >
      <NavIcon d={theme === "dark" ? MOON : SUN} big />
      {!iconsOnly && (theme === "dark" ? "Dark theme" : "Light theme")}
    </button>
  );
}

const RAIL_KEY = "qkt-insights-rail-collapsed";

/** The rail's collapsed state, remembered per viewer; storage failures only lose the memory. */
function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_KEY, c ? "0" : "1");
      } catch {
        // private mode or blocked storage: the choice lasts for this page only
      }
      return !c;
    });
  return [collapsed, toggle];
}

export interface NavItem {
  key: PageKey;
  label: string;
  icon: string;
}

/** The main sections in rail order. */
export const MAIN_NAV: NavItem[] = [
  { key: "home", label: "Home", icon: ICONS.home },
  { key: "strategies", label: "Strategies", icon: ICONS.strategies },
  { key: "trades", label: "Trades", icon: ICONS.trades },
  { key: "calendar", label: "Calendar", icon: ICONS.calendar },
  { key: "risk", label: "Equity & risk", icon: ICONS.risk },
  { key: "edge", label: "Edge", icon: ICONS.edge },
  { key: "logs", label: "Logs", icon: ICONS.logs },
  { key: "health", label: "Health", icon: ICONS.health },
];

export const SETTINGS_NAV: NavItem = { key: "settings", label: "Settings", icon: ICONS.settings };

function RailLink({ item, iconsOnly, onNavigate }: { item: NavItem; iconsOnly: boolean; onNavigate?: () => void }) {
  const { route } = useRoute();
  const active = route.page === item.key;
  return (
    <Link
      to={PAGE_PATHS[item.key]}
      onClick={onNavigate}
      title={iconsOnly ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-9 shrink-0 items-center gap-3 rounded-lg px-3 text-sm font-medium transition ${iconsOnly ? "justify-center px-0" : ""} ${
        active
          ? "bg-accent-soft text-bright before:absolute before:-left-2 before:bottom-2 before:top-2 before:w-[3px] before:rounded-r before:bg-accent-hi"
          : "text-body hover:bg-hover hover:text-bright"
      }`}
    >
      <NavIcon d={item.icon} big className={active ? "text-accent-ink" : "text-muted"} />
      {!iconsOnly && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

/**
 * Desktop rail + phone chrome around a page. `scope` sits under the wordmark (instance picker or
 * the shared-view label), `footer` at the very bottom (time-zone note, refresh, delay note).
 */
export function Shell({
  brand,
  nav,
  settings,
  tabs,
  scope,
  footer,
  mobileTitleRight,
  children,
}: {
  brand: string | null;
  nav: NavItem[];
  /** The Settings entry pinned to the bottom of the rail; absent on shared links. */
  settings?: NavItem;
  /** The phone bottom bar's four page tabs; the rest sit behind "More". */
  tabs: PageKey[];
  scope?: (iconsOnly: boolean) => ReactNode;
  footer?: (iconsOnly: boolean) => ReactNode;
  mobileTitleRight?: ReactNode;
  children: ReactNode;
}) {
  const { route } = useRoute();
  const [collapsed, toggleCollapsed] = useRailCollapsed();
  const [more, setMore] = useState(false);
  const all = settings ? [...nav, settings] : nav;
  const current = all.find((n) => n.key === route.page);
  const tabItems = tabs.map((k) => nav.find((n) => n.key === k)).filter((n): n is NavItem => n != null);
  const rest = all.filter((n) => !tabs.includes(n.key));
  const moreActive = rest.some((n) => n.key === route.page);

  return (
    <div className="flex h-dvh flex-col bg-ink text-bright lg:flex-row">
      {/* phone top bar */}
      <header className="pad-safe-top sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-side px-4 lg:hidden">
        <Mark />
        <div className="min-w-0 flex-1 truncate text-[15px] font-headline text-bright">{current?.label ?? "qkt·insights"}</div>
        {mobileTitleRight}
      </header>

      {/* desktop rail */}
      <aside
        className={`pad-safe-left relative hidden shrink-0 flex-col border-r border-line bg-side transition-[width] lg:flex ${collapsed ? "w-14" : "w-[216px]"}`}
        aria-label="Main navigation"
      >
        <div className={`flex h-14 shrink-0 items-center ${collapsed ? "justify-center" : "px-4"}`}>
          <Wordmark brand={brand} iconsOnly={collapsed} />
        </div>
        {/* sits on the rail's border line, level with the logo */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          className="absolute -right-3 top-4 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-side text-muted shadow-sm transition hover:bg-raised hover:text-bright"
        >
          <NavIcon d={collapsed ? ICONS.expand : ICONS.collapse} className="!h-3.5 !w-3.5" />
        </button>
        {scope && <div className={`shrink-0 pb-2 ${collapsed ? "px-2" : "px-3"}`}>{scope(collapsed)}</div>}
        <nav className={`flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-2 ${collapsed ? "px-2" : "px-3"}`}>
          {nav.map((n) => (
            <RailLink key={n.key} item={n} iconsOnly={collapsed} />
          ))}
        </nav>
        <div className={`flex shrink-0 flex-col gap-0.5 border-t border-line py-2 ${collapsed ? "px-2" : "px-3"}`}>
          {settings && <RailLink item={settings} iconsOnly={collapsed} />}
          <ThemeToggle iconsOnly={collapsed} />
        </div>
        {footer && <div className={`shrink-0 border-t border-line py-2 ${collapsed ? "px-2" : "px-4"}`}>{footer(collapsed)}</div>}
      </aside>

      <div className="relative min-h-0 min-w-0 flex-1">{children}</div>

      {/* phone bottom tab bar */}
      <nav
        aria-label="Sections"
        className="pad-safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-side lg:hidden"
      >
        {tabItems.map((n) => {
          const active = route.page === n.key;
          return (
            <Link
              key={n.key}
              to={PAGE_PATHS[n.key]}
              aria-current={active ? "page" : undefined}
              className={`flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-accent-ink" : "text-muted"}`}
            >
              <NavIcon d={n.icon} big />
              <span className="max-w-full truncate px-1">{n.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMore(true)}
          aria-expanded={more}
          className={`flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium ${moreActive ? "text-accent-ink" : "text-muted"}`}
        >
          <svg viewBox="0 0 24 24" className="h-[17px] w-[17px]" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
          More
        </button>
      </nav>

      <Drawer open={more} onClose={() => setMore(false)} label="More sections">
        <div className="flex h-14 shrink-0 items-center px-4">
          <Wordmark brand={brand} />
        </div>
        {scope && <div className="shrink-0 px-3 pb-2">{scope(false)}</div>}
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
          {rest.map((n) => (
            <RailLink key={n.key} item={n} iconsOnly={false} onNavigate={() => setMore(false)} />
          ))}
          <ThemeToggle />
        </nav>
        {footer && <div className="shrink-0 border-t border-line px-4 py-3">{footer(false)}</div>}
      </Drawer>
    </div>
  );
}
