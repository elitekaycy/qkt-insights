import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, Unauthorized, type InstanceRow } from "./api";
import { ICONS, MAIN_NAV, NavIcon, SETTINGS_NAV, Shell, Wordmark } from "./components/chrome";
import { PageFallback, Select, Spinner, StatusDot, useNow } from "./components/ui";
import Login from "./pages/Login";
import { useBrand } from "./useBrand";
import { usePullToRefresh } from "./hooks/usePullToRefresh";
import { useResumeRefresh } from "./hooks/useResumeRefresh";
import { useNavigationPending, useRoute, useSearchParam, type PageKey } from "./router";
import { instanceState } from "./instance";

// one chunk per page: the shell paints first, and a page's charts load only when it opens
const Overview = lazy(() => import("./pages/Overview"));
const Health = lazy(() => import("./pages/Health"));
const Strategies = lazy(() => import("./pages/Strategies"));
const Trades = lazy(() => import("./pages/Trades"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const Logs = lazy(() => import("./pages/Logs"));
const Equity = lazy(() => import("./pages/Equity"));
const Edge = lazy(() => import("./pages/Edge").then((m) => ({ default: m.Edge })));
const Settings = lazy(() => import("./pages/Settings"));

const PHONE_TABS: PageKey[] = ["home", "strategies", "trades", "calendar"];

/** After this long on the splash, it says it is still waiting and offers a retry. */
const SPLASH_PATIENCE_MS = 8000;

/**
 * Full-screen state before the app has anything to render: the locked mark and wordmark, then the spinner and
 * "Connecting to soak…" (still waiting after 8 s, with a retry), or "can't reach the collector". Nothing on it
 * claims a state the app does not know yet: no status dot.
 */
function Splash({ brand, status, busy, onRetry }: { brand: string | null; status: "loading" | "offline"; busy?: boolean; onRetry?: () => void }) {
  const [patient, setPatient] = useState(false);
  useEffect(() => {
    if (status !== "loading") return;
    const id = window.setTimeout(() => setPatient(true), SPLASH_PATIENCE_MS);
    return () => window.clearTimeout(id);
  }, [status]);
  return (
    <div className="pad-safe-top pad-safe-bottom flex h-dvh flex-col items-center justify-center gap-6 bg-ink px-6 text-center" aria-live="polite">
      <div className="lockup-in">
        <Wordmark brand={brand} stacked />
      </div>
      {status === "loading" ? (
        <div className="flex flex-col items-center gap-3">
          <Spinner label={`Connecting to ${brand ?? "the collector"}…`} show />
          {patient && (
            <div className="flex items-center gap-2 text-sm text-muted">
              Still waiting for the collector.
              {onRetry && <button type="button" onClick={onRetry} className="font-medium text-accent-ink hover:underline">Retry</button>}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="max-w-xs text-sm leading-relaxed text-muted">Can't reach the collector. Check the connection and try again.</div>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="h-9 rounded-lg bg-accent px-5 text-sm font-medium text-on-accent transition hover:bg-accent-hi disabled:opacity-60"
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        </>
      )}
    </div>
  );
}

/** Nothing while the instance reports on time; an amber "stale · 45s" or a red "down · 12m" when it does not. */
function InstanceStatus({ lastSeen, compact = false }: { lastSeen: number | null | undefined; compact?: boolean }) {
  const now = useNow(5000);
  const s = instanceState(lastSeen, now);
  if (!s) return null;
  const words = `${s.state} · ${s.age}`;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.state === "down" ? "text-loss" : "text-warn"}`} title={`last report ${s.age} ago`} role="status">
      <StatusDot state={s.state} />
      {compact ? <span className="sr-only">{words}</span> : words}
    </span>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const { route } = useRoute();
  const navigating = useNavigationPending();
  const [instance, setInstance] = useSearchParam("i");
  // "signed out" is a decision, not a server round-trip: the sign-in screen shows at
  // once, and a logout that could not be sent is retried when the link returns
  const [signedOut, setSignedOut] = useState(false);
  const brand = useBrand();
  const fetching = useIsFetching();
  const refreshAll = useCallback(() => queryClient.refetchQueries({ type: "active" }), [queryClient]);
  const pull = usePullToRefresh(refreshAll);
  useResumeRefresh(refreshAll);

  const instances = useQuery({
    queryKey: ["instances"],
    queryFn: () => get<InstanceRow[]>("/instances"),
    refetchInterval: 30_000,
  });

  if (signedOut || instances.error instanceof Unauthorized) {
    return (
      <Login
        onLoggedIn={() => {
          setSignedOut(false);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }
  // First load (and the reload right after signing in) has no data to show yet;
  // a bare dark screen on a phone reads as "the app is broken".
  if (instances.isPending) return <Splash brand={brand} status="loading" onRetry={() => void instances.refetch()} />;
  if (instances.isError && instances.data == null) {
    return <Splash brand={brand} status="offline" busy={instances.isFetching} onRetry={() => void instances.refetch()} />;
  }

  const list = instances.data ?? [];
  const selected = (instance && list.some((i) => i.id === instance) ? instance : list[0]?.id) ?? null;
  const selectedRow = list.find((i) => i.id === selected);

  const scope = (iconsOnly: boolean) =>
    iconsOnly ? (
      <div className="flex justify-center py-2" title={selected ?? "no instance"}>
        <InstanceStatus lastSeen={selectedRow?.lastSeen} compact />
      </div>
    ) : (
      <label className="block">
        <span className="flex items-center justify-between gap-2 px-1 pb-1.5 text-xs text-muted">
          Instance
          <InstanceStatus lastSeen={selectedRow?.lastSeen} />
        </span>
        <Select className="w-full" value={selected ?? ""} onChange={(e) => setInstance(e.target.value, { push: true })} aria-label="Instance">
          {list.length === 0 && <option value="">no instances yet</option>}
          {list.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name ?? i.id}
            </option>
          ))}
        </Select>
      </label>
    );

  const footer = (iconsOnly: boolean) => (
    <div className={`flex items-center gap-2 text-xs text-muted ${iconsOnly ? "justify-center" : ""}`}>
      {!iconsOnly && <span className="flex-1">All times UTC</span>}
      <button
        type="button"
        onClick={() => void refreshAll()}
        disabled={fetching > 0}
        title="Refresh every panel"
        aria-label="Refresh every panel"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-bright disabled:opacity-60"
      >
        <span className={fetching > 0 ? "animate-spin" : ""}>
          <NavIcon d={ICONS.refresh} />
        </span>
      </button>
    </div>
  );

  const page = (() => {
    switch (route.page) {
      case "home":
        return <Overview instanceId={selected} />;
      case "strategies":
        return <Strategies instanceId={selected} />;
      case "trades":
        return <Trades instanceId={selected} />;
      case "calendar":
        return <CalendarPage instanceId={selected} />;
      case "risk":
        return <Equity instanceId={selected} />;
      case "edge":
        return <Edge instanceId={selected} />;
      case "logs":
        return <Logs instanceId={selected} />;
      case "health":
        return <Health />;
      case "settings":
        return <Settings instanceId={selected} onSignedOut={() => setSignedOut(true)} />;
    }
  })();

  return (
    <Shell
      brand={brand}
      nav={MAIN_NAV}
      settings={SETTINGS_NAV}
      tabs={PHONE_TABS}
      scope={scope}
      footer={footer}
      mobileTitleRight={
        <span className="flex min-w-0 items-center gap-2">
          <span className="max-w-[8rem] truncate text-xs text-muted">{selectedRow?.name ?? selected ?? "no instance"}</span>
          <InstanceStatus lastSeen={selectedRow?.lastSeen} compact />
        </span>
      }
    >
      {navigating && <div className="nav-progress" role="progressbar" aria-label="Opening the page" />}
      <main ref={pull.ref} className="h-full overflow-auto overscroll-contain pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* pull-to-refresh well: grows with the drag, holds while refetching */}
        <div
          aria-live="polite"
          className="flex items-end justify-center overflow-hidden text-xs text-muted transition-[height] duration-150 lg:hidden"
          style={{ height: pull.offset }}
        >
          {(pull.offset > 0 || pull.refreshing) && (
            <span className="pb-3">{pull.refreshing ? "Refreshing…" : pull.offset >= 64 ? "Release to refresh" : "Pull to refresh"}</span>
          )}
        </div>
        <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
          <Suspense fallback={<PageFallback title={[...MAIN_NAV, SETTINGS_NAV].find((n) => n.key === route.page)?.label} />}>{page}</Suspense>
        </div>
      </main>
    </Shell>
  );
}
