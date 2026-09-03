import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const SWIPE_CLOSE_PX = 70;

/** Edge-anchored mobile navigation panel: slides in, closes on Escape, a scrim tap,
 *  or a leftward swipe, and holds focus while open. */
export function Drawer({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  // the ref is the source of truth: a flick can deliver move and end in one tick,
  // before a state update from the move has committed
  const dragged = useRef(0);
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      dragged.current = 0;
      setDrag(0);
    }
  }, [open]);

  if (!open) return null;

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (t) start.current = { x: t.clientX, y: t.clientY, horizontal: null };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // first meaningful movement decides whether this is a swipe or a scroll
    if (s.horizontal == null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (!s.horizontal) return;
    dragged.current = Math.min(0, dx);
    setDrag(dragged.current);
  };

  const onTouchEnd = () => {
    if (dragged.current < -SWIPE_CLOSE_PX) onClose();
    else setDrag(0);
    dragged.current = 0;
    start.current = null;
  };

  return createPortal(
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="drawer-scrim absolute inset-0 bg-ink/70 backdrop-blur-md" onClick={onClose} />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className={`pad-safe-bottom pad-safe-left pad-safe-top absolute inset-y-0 left-0 flex w-[min(19rem,85vw)] flex-col border-r border-line bg-panel outline-none ${
          drag === 0 ? "drawer-panel" : ""
        }`}
        style={drag !== 0 ? { transform: `translateX(${drag}px)` } : undefined}
      >
        {children}
      </aside>
    </div>,
    document.body,
  );
}
