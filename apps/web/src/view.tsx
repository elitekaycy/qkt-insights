import { createContext, useContext, type ReactNode } from "react";
import type { PublicMeta } from "./api";

/** Signed-in dashboard, or a shared link rendering the same pages read-only. */
export type View = { public: false } | { public: true; meta: PublicMeta };

const ViewContext = createContext<View>({ public: false });

export function ViewProvider({ view, children }: { view: View; children: ReactNode }) {
  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}

export function useView(): View {
  return useContext(ViewContext);
}
