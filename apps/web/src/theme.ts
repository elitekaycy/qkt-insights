import { useSyncExternalStore } from "react";

/** The two hand-tuned themes. Dark is the default; light is a separate palette, not an inversion. */
export type Theme = "dark" | "light";

const KEY = "qkt-insights-theme";
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The saved choice, or null when the viewer never picked one (or storage is unavailable). */
function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  const attr = typeof document === "undefined" ? null : document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : (savedTheme() ?? systemTheme());
}

/** Applies a theme and remembers it for this viewer; storage failures only lose the memory. */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode or blocked storage: the choice lasts for this page only
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", theme === "light" ? "#f6f7f9" : "#0e0f12");
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // follow the system while the viewer has not chosen
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  const onSystem = () => {
    if (savedTheme() == null) {
      document.documentElement.setAttribute("data-theme", systemTheme());
      listener();
    }
  };
  mq?.addEventListener("change", onSystem);
  return () => {
    listeners.delete(listener);
    mq?.removeEventListener("change", onSystem);
  };
}

/** Current theme; re-renders on a toggle so canvas charts can re-read their colour tokens. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "dark");
}

/** Reads a CSS colour token (e.g. "--color-gain") as the browser resolved it for the active theme. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
