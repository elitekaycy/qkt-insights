import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { movedPath, parsePath, withScope, type Route } from "./routes";

export * from "./routes";

/*
 * URL routing without a router dependency: the History API, one context, and a path scheme that
 * never collides with the collector's API routes (they share the origin and the server answers a
 * reload of any unknown GET with the app shell). Everything a viewer selects that changes what is
 * on screen lives in the URL: page, strategy, tab, instance (`i`), date range (`range`), filters.
 * Shared links (/p/<token>/...) use the same scheme under their own base.
 */

/**
 * Where a drill-down came from, kept in the history entry it opened: the label its back control
 * shows ("Calendar · Oct 7") and how many entries back the origin is (a filter the viewer pushes
 * after arriving adds one). The origin's own entry keeps its scroll position for the return.
 */
export interface Origin {
  label: string;
  hops: number;
}

interface HistoryState {
  from?: Origin;
  scroll?: number;
}

export interface NavigateOptions {
  replace?: boolean;
  keepScope?: boolean;
  /** A drill-down: the label of the place being left, shown on the back control of the target. */
  from?: string;
}

interface RouterState {
  base: string;
  path: string;
  search: string;
  origin: Origin | null;
  navigate: (to: string, opts?: NavigateOptions) => void;
}

/** The scrolling page body; its offset is what a return restores. */
function scroller(): HTMLElement | null {
  return document.querySelector("main");
}

function historyState(): HistoryState {
  const s = window.history.state as HistoryState | null;
  return s && typeof s === "object" ? s : {};
}

/** Puts the page back where the viewer left it once the content is tall enough to scroll there. */
function restoreScroll(top: number): void {
  let tries = 0;
  const step = () => {
    const el = scroller();
    if (!el) return;
    el.scrollTop = top;
    if (Math.abs(el.scrollTop - top) > 2 && tries++ < 40) window.setTimeout(step, 50);
  };
  window.requestAnimationFrame(step);
}

const RouterContext = createContext<RouterState | null>(null);

function readLocation(base: string): { path: string; search: string; origin: Origin | null } {
  const full = window.location.pathname;
  const path = base && full.startsWith(base) ? full.slice(base.length) || "/" : full;
  return { path, search: window.location.search, origin: historyState().from ?? null };
}

export function RouterProvider({ base = "", children }: { base?: string; children: ReactNode }) {
  const [loc, setLoc] = useState(() => {
    const at = readLocation(base);
    const moved = movedPath(at.path);
    if (!moved) return at;
    // a retired page's link lands on its successor, without an extra Back step
    window.history.replaceState(window.history.state, "", `${base}${moved}${at.search}`);
    return { path: moved, search: at.search, origin: at.origin };
  });
  useEffect(() => {
    const onPop = () => {
      setLoc(readLocation(base));
      const top = historyState().scroll;
      if (top != null) restoreScroll(top);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [base]);
  const navigate = useCallback(
    (to: string, opts: NavigateOptions = {}) => {
      const target = opts.keepScope === false ? to : withScope(to, window.location.search);
      const url = `${base}${target.startsWith("/") ? target : `/${target}`}`;
      if (url === `${window.location.pathname}${window.location.search}`) return;
      const here = historyState();
      const samePage = parsePath(target.split("?")[0] ?? "/").page === parsePath(readLocation(base).path).page;
      if (opts.from != null) {
        window.history.replaceState({ ...here, scroll: scroller()?.scrollTop ?? 0 }, "", window.location.href);
        window.history.pushState({ from: { label: opts.from, hops: 1 } } satisfies HistoryState, "", url);
      } else if (opts.replace) {
        // a filter typed on the page keeps the way back; another page replaces it
        window.history.replaceState(samePage && here.from ? { from: here.from } : null, "", url);
      } else {
        window.history.pushState(samePage && here.from ? { from: { ...here.from, hops: here.from.hops + 1 } } : null, "", url);
      }
      setLoc(readLocation(base));
      if (!samePage) scroller()?.scrollTo({ top: 0 });
    },
    [base],
  );
  const value = useMemo(() => ({ base, path: loc.path, search: loc.search, origin: loc.origin, navigate }), [base, loc, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterState {
  const r = useContext(RouterContext);
  if (!r) throw new Error("useRouter outside RouterProvider");
  return r;
}

/** The parsed current route plus navigation. */
export function useRoute(): { route: Route; navigate: RouterState["navigate"]; href: (to: string) => string } {
  const r = useRouter();
  const route = useMemo(() => parsePath(r.path), [r.path]);
  const href = useCallback((to: string) => `${r.base}${withScope(to, r.search)}`, [r.base, r.search]);
  return { route, navigate: r.navigate, href };
}

/**
 * One query parameter as state. Setting it to the fallback removes it from the URL; filters
 * replace the history entry (typing does not flood Back), while `push` makes a step Back can undo.
 */
export function useSearchParam(key: string, fallback = ""): [string, (value: string, opts?: { push?: boolean }) => void] {
  const r = useRouter();
  const value = new URLSearchParams(r.search).get(key) ?? fallback;
  const set = useCallback(
    (v: string, opts: { push?: boolean } = {}) => {
      const params = new URLSearchParams(window.location.search);
      if (v === fallback || v === "") params.delete(key);
      else params.set(key, v);
      const q = params.toString();
      r.navigate(`${r.path}${q ? `?${q}` : ""}`, { replace: !opts.push, keepScope: false });
    },
    [key, fallback, r],
  );
  return [value, set];
}

/** In-app link: a real href (open in a new tab works) that navigates without a reload on a plain click. */
export function Link({ to, replace, from, children, onClick, ...rest }: { to: string; replace?: boolean; from?: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const { navigate, href } = useRoute();
  return (
    <a
      {...rest}
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to, { replace, from });
      }}
    >
      {children}
    </a>
  );
}

/** The drill-down origin of the current entry and the step back to it; null on a direct visit. */
export function useOrigin(): { label: string; back: () => void } | null {
  const r = useRouter();
  const origin = r.origin;
  return useMemo(() => (origin ? { label: origin.label, back: () => window.history.go(-origin.hops) } : null), [origin]);
}
