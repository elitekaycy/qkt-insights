import { createContext, useContext, useEffect, type ReactNode } from "react";
import { reportPublicView, type PublicMeta } from "./api";

/** Signed-in dashboard, or a shared link rendering the same pages read-only. */
export type View = { public: false } | { public: true; meta: PublicMeta };

const ViewContext = createContext<View>({ public: false });

export function ViewProvider({ view, children }: { view: View; children: ReactNode }) {
  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}

export function useView(): View {
  return useContext(ViewContext);
}

/** On a shared link, reports each page (and the strategy on it) once as it opens. A null page reports nothing. */
export function usePublicPageView(page: string | null, strategyId?: string | null): void {
  const view = useView();
  useEffect(() => {
    if (view.public && page) reportPublicView(page, strategyId);
  }, [view.public, page, strategyId]);
}
