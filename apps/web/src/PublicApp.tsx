import { lazy, Suspense, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, NotFound, type PublicMeta } from "./api";
import { MAIN_NAV, Mark, Shell, ThemeToggle, Wordmark } from "./components/chrome";
import { PageFallback } from "./components/ui";
import { tsShort } from "./format";
import { useRoute, type PageKey } from "./router";
import { useBrand } from "./useBrand";
import { ViewProvider } from "./view";

const Overview = lazy(() => import("./pages/Overview"));
const Strategies = lazy(() => import("./pages/Strategies"));
const SharedPortfolio = lazy(() => import("./pages/Strategies").then((m) => ({ default: m.SharedPortfolio })));
const StrategyDetail = lazy(() => import("./pages/Strategies").then((m) => ({ default: m.StrategyDetail })));
const Trades = lazy(() => import("./pages/Trades"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const Equity = lazy(() => import("./pages/Equity"));
const Edge = lazy(() => import("./pages/Edge").then((m) => ({ default: m.Edge })));

/** What a shared overview link can open; logs, health and settings stay private. */
const SHARED_PAGES: PageKey[] = ["home", "strategies", "trades", "calendar", "risk", "edge"];
const SHARED_NAV = MAIN_NAV.filter((n) => SHARED_PAGES.includes(n.key));
const PHONE_TABS: PageKey[] = ["home", "strategies", "trades", "calendar"];

function DelayNote({ meta }: { meta: PublicMeta }) {
  return (
    <div className="text-xs leading-relaxed text-muted">
      Read-only shared view. Figures run {meta.delayMinutes} minutes behind; as of {tsShort(meta.asOf)} UTC.
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="pad-safe-top pad-safe-bottom flex h-dvh flex-col items-center justify-center gap-4 bg-ink px-6 text-center">{children}</div>;
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
          <span className="live-dot inline-block h-2 w-2 rounded-full bg-ok" />
          Loading…
        </div>
      </Centered>
    );
  }
  if (meta.isError && !(meta.error instanceof NotFound) && !meta.data) {
    return (
      <Centered>
        <Mark />
        <div className="text-[15px] font-headline text-bright">Temporarily unavailable</div>
        <div className="max-w-sm text-sm leading-relaxed text-muted">The dashboard is busy or unreachable. Try again in a minute.</div>
        <button type="button" onClick={() => void meta.refetch()} className="h-9 rounded-lg bg-accent px-5 text-sm font-medium text-on-accent hover:bg-accent-hi">
          Retry
        </button>
      </Centered>
    );
  }
  if (meta.isError || !meta.data) {
    return (
      <Centered>
        <Mark />
        <div className="text-[15px] font-headline text-bright">This link is not available</div>
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
        <div className="min-h-dvh bg-ink text-bright">
          <header className="pad-safe-top flex flex-wrap items-center gap-3 border-b border-line bg-side px-4 py-3 sm:px-6">
            <Wordmark brand={brand} />
            <div className="ml-auto flex items-center gap-3">
              <DelayNote meta={m} />
              <div className="w-auto">
                <ThemeToggle iconsOnly />
              </div>
            </div>
          </header>
          <main className="pad-safe-bottom mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
            <Suspense fallback={<PageFallback />}>
              {m.kind === "portfolio" ? (
                <SharedPortfolio instanceId={m.instanceId} portfolioId={m.subject} />
              ) : (
                <StrategyDetail instanceId={m.instanceId} strategyId={m.subject} />
              )}
            </Suspense>
          </main>
        </div>
      )}
    </ViewProvider>
  );
}

function SharedOverview({ meta, brand }: { meta: PublicMeta; brand: string | null }) {
  const { route } = useRoute();
  const id = meta.instanceId;
  const page = (() => {
    switch (route.page) {
      case "strategies":
        return <Strategies instanceId={id} />;
      case "trades":
        return <Trades instanceId={id} />;
      case "calendar":
        return <CalendarPage instanceId={id} />;
      case "risk":
        return <Equity instanceId={id} />;
      case "edge":
        return <Edge instanceId={id} />;
      default:
        return <Overview instanceId={id} />;
    }
  })();
  return (
    <Shell
      brand={brand}
      nav={SHARED_NAV}
      tabs={PHONE_TABS}
      scope={(iconsOnly) =>
        iconsOnly ? null : (
          <div className="rounded-lg border border-line bg-panel px-3 py-2">
            <div className="eyebrow">Shared view</div>
            <div className="mt-0.5 truncate text-sm font-medium text-bright">{id}</div>
          </div>
        )
      }
      footer={(iconsOnly) => (iconsOnly ? null : <DelayNote meta={meta} />)}
    >
      <main className="h-full overflow-auto overscroll-contain pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
          <Suspense fallback={<PageFallback />}>{page}</Suspense>
        </div>
      </main>
    </Shell>
  );
}
