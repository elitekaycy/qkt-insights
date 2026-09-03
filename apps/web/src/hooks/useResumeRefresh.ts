import { useEffect } from "react";

const STALE_AFTER_MS = 60_000;

/** Polling pauses while the app is hidden (a backgrounded PWA, a switched tab). When it
 *  comes back after a real absence, refetch once instead of showing minute-old
 *  numbers until the next interval tick. Short tab switches don't trigger it. */
export function useResumeRefresh(refresh: () => Promise<unknown>) {
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt != null && Date.now() - hiddenAt > STALE_AFTER_MS) void refresh();
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [refresh]);
}
