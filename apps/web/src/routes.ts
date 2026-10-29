/*
 * The URL scheme: pure functions, no React. Page paths never collide with the collector's API
 * routes, which share the origin (the server answers a reload of any unknown GET with the app
 * shell). routes.test.ts checks that against the API source.
 */

export type PageKey = "home" | "strategies" | "trades" | "calendar" | "risk" | "edge" | "logs" | "health" | "settings";

/** Page roots. Short on purpose: "/strategies", "/trades", "/health", "/logs" and "/search" are API routes. */
export const PAGE_PATHS: Record<PageKey, string> = {
  home: "/",
  strategies: "/s",
  trades: "/t",
  calendar: "/calendar",
  risk: "/risk",
  edge: "/edge",
  logs: "/log",
  health: "/status",
  settings: "/settings",
};

/** Retired paths and where they lead now, so old links never land on Home by surprise. */
const MOVED: Record<string, PageKey> = {
  // the search page gave way to the query bar on each page; logs is where text search lives
  find: "logs",
};

/** A strategy's sections, the journal's: the path segment of each (overview has none). */
export type StrategyTab = "overview" | "periods" | "trades" | "time" | "code" | "logs";
export const STRATEGY_TABS: readonly StrategyTab[] = ["overview", "periods", "trades", "time", "code", "logs"];

/** The Periods section's views: `/s/<id>/periods`, `/periods/days`, `/periods/months`. */
export type PeriodView = "calendar" | "days" | "months";
export const PERIOD_VIEWS: readonly PeriodView[] = ["calendar", "days", "months"];

/** The strategy sections Periods replaced, and the view each now opens (old links keep working). */
const MOVED_TABS: Record<string, PeriodView> = { calendar: "calendar", daily: "days", monthly: "months" };
/** Sections a shared link never shows: the strategy's code and its engine logs. */
export const PRIVATE_STRATEGY_TABS: ReadonlySet<StrategyTab> = new Set<StrategyTab>(["code", "logs"]);

export type SettingsSection = "sharing" | "viewership" | "appearance" | "account";
const SETTINGS_SECTIONS: readonly SettingsSection[] = ["sharing", "viewership", "appearance", "account"];

export interface Route {
  page: PageKey;
  /** Strategy page: the strategy id. */
  strategy?: string;
  /** Strategy page: the tab. */
  tab?: StrategyTab;
  /** Strategy page, Periods tab: the view. */
  period?: PeriodView;
  /** Portfolio page under Strategies. */
  portfolio?: string;
  /** Settings section. */
  section?: SettingsSection;
}

const seg = (s: string | undefined) => (s == null ? undefined : decodeURIComponent(s));

/** The current path for a retired one ("/find" → "/log", "/s/gold/daily" → "/s/gold/periods/days"), or null when the path is current. */
export function movedPath(path: string): string | null {
  const [head, a, b] = path.split("/").filter(Boolean);
  if (head === "s" && a && b && MOVED_TABS[b]) return routePath(parsePath(path));
  const to = head ? MOVED[head] : undefined;
  return to ? PAGE_PATHS[to] : null;
}

/** Parses a path relative to the app base ("/s/gold/performance") into a route; unknown paths are Home. */
export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  const [head, a, b, c] = parts;
  if (!head) return { page: "home" };
  if (head === "s") {
    if (!a) return { page: "strategies" };
    const moved = b ? MOVED_TABS[b] : undefined;
    if (moved) return { page: "strategies", strategy: seg(a), tab: "periods", period: moved };
    const tab = STRATEGY_TABS.find((t) => t === b) ?? "overview";
    if (tab === "periods") return { page: "strategies", strategy: seg(a), tab, period: PERIOD_VIEWS.find((v) => v === c) ?? "calendar" };
    return { page: "strategies", strategy: seg(a), tab };
  }
  if (head === "portfolio" && a) return { page: "strategies", portfolio: seg(a) };
  if (head === "settings") return { page: "settings", section: SETTINGS_SECTIONS.find((x) => x === a) ?? "sharing" };
  const page = (Object.keys(PAGE_PATHS) as PageKey[]).find((k) => PAGE_PATHS[k] === `/${head}`);
  return { page: page ?? MOVED[head] ?? "home" };
}

/** The canonical path of a route; inverse of parsePath. */
export function routePath(route: Route): string {
  if (route.page === "strategies" && route.strategy) {
    const base = `/s/${encodeURIComponent(route.strategy)}`;
    if (route.tab === "periods") return `${base}/periods${route.period && route.period !== "calendar" ? `/${route.period}` : ""}`;
    return route.tab && route.tab !== "overview" ? `${base}/${route.tab}` : base;
  }
  if (route.page === "strategies" && route.portfolio) return `/portfolio/${encodeURIComponent(route.portfolio)}`;
  if (route.page === "settings" && route.section && route.section !== "sharing") return `/settings/${route.section}`;
  return PAGE_PATHS[route.page];
}

/** Query keys that describe the viewer's scope and follow them from page to page: instance, date range, venue account. */
const SCOPE_KEYS = ["i", "range", "account"];

/** Pages with the query bar: the search (`q`) follows the viewer between them, and only them. */
const QUERY_PAGES: ReadonlySet<PageKey> = new Set<PageKey>(["trades", "strategies", "calendar", "logs"]);

/** Merges the current scope params into a target URL's query unless the target sets them itself. */
export function withScope(to: string, currentSearch: string): string {
  const [p, q = ""] = to.split("?");
  const next = new URLSearchParams(q);
  const cur = new URLSearchParams(currentSearch);
  const keys = QUERY_PAGES.has(parsePath(p ?? "/").page) ? [...SCOPE_KEYS, "q"] : SCOPE_KEYS;
  for (const k of keys) {
    const v = cur.get(k);
    if (v != null && !next.has(k)) next.set(k, v);
  }
  const s = next.toString();
  return s ? `${p}?${s}` : p!;
}
