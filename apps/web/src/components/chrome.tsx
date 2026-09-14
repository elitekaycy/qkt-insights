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

export function Mark() {
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
