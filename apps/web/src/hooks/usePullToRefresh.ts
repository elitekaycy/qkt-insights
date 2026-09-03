import { useCallback, useEffect, useState } from "react";

const TRIGGER_PX = 64;
const MAX_PX = 96;
const HOLD_PX = 56;

/** Native-style pull-to-refresh on a scroll container: dragging down from the top
 *  opens a well, releasing past the threshold runs `onRefresh` and holds the well
 *  open until it settles. Standalone apps have no browser reload, so this is the
 *  only refresh gesture on a phone. Attach the returned `ref` to the scroller —
 *  a callback ref, because the scroller mounts after the splash and login. */
export function usePullToRefresh(onRefresh: () => Promise<unknown>) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    let startY: number | null = null;
    let pulling = false;
    let dist = 0;
    let busy = false;

    const onStart = (e: TouchEvent) => {
      if (busy || el.scrollTop > 0) return;
      startY = e.touches[0]?.clientY ?? null;
      dist = 0;
      pulling = false;
    };
    const onMove = (e: TouchEvent) => {
      if (startY == null) return;
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        if (pulling) {
          pulling = false;
          setOffset(0);
        }
        return;
      }
      pulling = true;
      dist = Math.min(dy * 0.5, MAX_PX);
      setOffset(dist);
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = async () => {
      startY = null;
      if (!pulling) return;
      pulling = false;
      if (dist < TRIGGER_PX) {
        setOffset(0);
        return;
      }
      busy = true;
      setRefreshing(true);
      setOffset(HOLD_PX);
      try {
        await onRefresh();
      } finally {
        busy = false;
        setRefreshing(false);
        setOffset(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [el, onRefresh]);

  return { ref, offset, refreshing };
}
