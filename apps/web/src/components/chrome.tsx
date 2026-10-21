import { setTheme, useTheme } from "../theme";

/** Sidebar chrome shared by the signed-in dashboard and the shared-link view. */

export type Page = "overview" | "health" | "strategies" | "edge" | "trades" | "equity" | "logs" | "search" | "viewership";

export const ICONS: Record<Page, string> = {
  overview: "M3 13h5v8H3zM10 7h5v14h-5zM17 3h5v18h-5z",
  health: "M22 12h-4l-3 9L9 3l-3 9H2",
  strategies: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  edge: "M3 3v18h18M7 14h2v4H7zM11 10h2v8h-2zM15 6h2v12h-2z",
  trades: "M4 7h16M4 12h16M4 17h10",
  equity: "M3 3v18h18M8 15l4-6 4 3 4-7",
  logs: "M5 4h14M5 9h14M5 14h9M5 19h6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  viewership: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};

export function NavIcon({ d, big }: { d: string; big?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${big ? "h-[17px] w-[17px]" : "h-4 w-4"} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export function Mark() {
  return (
    <svg viewBox="0 0 200 200" className="h-7 w-7 shrink-0">
      <g fill="none" strokeWidth="14">
        <g stroke="var(--color-brand-violet)" strokeLinejoin="miter">
          <path d="M56 50H34v100h22" />
          <path d="M143 50h22v100h-22" />
        </g>
        <path d="M100 80v70" stroke="var(--color-bright)" strokeLinecap="round" />
      </g>
      <circle cx="100" cy="62" r="7" fill="var(--color-brand)" />
    </svg>
  );
}

/** The "qkt·insights" lockup: mark plus wordmark, with the deployment name under it. */
export function Wordmark({ brand, iconsOnly = false }: { brand?: string | null; iconsOnly?: boolean }) {
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${iconsOnly ? "justify-center" : ""}`}>
      <Mark />
      {!iconsOnly && (
        <div className="min-w-0">
          <div className="text-[15px] font-headline leading-tight tracking-tight text-bright">
            qkt<span className="text-brand">·</span>insights
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
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-body transition hover:bg-hover hover:text-bright ${iconsOnly ? "justify-center px-0" : ""} ${className}`}
    >
      <NavIcon d={theme === "dark" ? MOON : SUN} />
      {!iconsOnly && (theme === "dark" ? "Dark theme" : "Light theme")}
    </button>
  );
}
