import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { parsePath, withScope, type Route } from "./routes";

export * from "./routes";

/*
 * URL routing without a router dependency: the History API, one context, and a path scheme that
 * never collides with the collector's API routes (they share the origin and the server answers a
 * reload of any unknown GET with the app shell). Everything a viewer selects that changes what is
 * on screen lives in the URL: page, strategy, tab, instance (`i`), date range (`range`), filters.
 * Shared links (/p/<token>/...) use the same scheme under their own base.
 */

interface RouterState {
  base: string;
  path: string;
  search: string;
  navigate: (to: string, opts?: { replace?: boolean; keepScope?: boolean }) => void;
}

const RouterContext = createContext<RouterState | null>(null);

function readLocation(base: string): { path: string; search: string } {
  const full = window.location.pathname;
  const path = base && full.startsWith(base) ? full.slice(base.length) || "/" : full;
  return { path, search: window.location.search };
}

export function RouterProvider({ base = "", children }: { base?: string; children: ReactNode }) {
  const [loc, setLoc] = useState(() => readLocation(base));
  useEffect(() => {
    const onPop = () => setLoc(readLocation(base));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [base]);
  const navigate = useCallback(
    (to: string, opts: { replace?: boolean; keepScope?: boolean } = {}) => {
      const target = opts.keepScope === false ? to : withScope(to, window.location.search);
      const url = `${base}${target.startsWith("/") ? target : `/${target}`}`;
      if (url === `${window.location.pathname}${window.location.search}`) return;
      if (opts.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
      setLoc(readLocation(base));
    },
    [base],
  );
  const value = useMemo(() => ({ base, path: loc.path, search: loc.search, navigate }), [base, loc, navigate]);
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
export function Link({ to, replace, children, onClick, ...rest }: { to: string; replace?: boolean; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const { navigate, href } = useRoute();
  return (
    <a
      {...rest}
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
    >
      {children}
    </a>
  );
}
