import { useState, type ReactNode } from "react";
import { Card, IconButton, Modal } from "./ui";

/** Consistent frame for every analytical chart and its expanded view. */
export function ChartCard({
  title,
  description,
  meta,
  value,
  toolbar,
  children,
  className = "",
  stagger,
}: {
  title: string;
  description: string;
  meta?: string;
  value?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const header = (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-bright">{title}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>
        {meta && <p className="mt-1 text-[11px] text-faint">{meta}</p>}
      </div>
      {value && <div className="font-mono text-xl font-semibold text-bright">{value}</div>}
    </div>
  );

  return (
    <>
      <Card className={`min-w-0 overflow-hidden ${className}`} stagger={stagger}>
        <div className="flex items-start gap-3 border-b border-line/70 px-4 py-3.5 sm:px-5">
          {header}
          <div className="flex shrink-0 items-center gap-2">
            {toolbar}
            <IconButton
              label={`Expand ${title}`}
              onClick={() => setExpanded(true)}
              d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
            />
          </div>
        </div>
        {children}
      </Card>
      <Modal open={expanded} onClose={() => setExpanded(false)} title={title} hint={meta} toolbar={toolbar}>
        <div className="min-h-[420px]">{children}</div>
      </Modal>
    </>
  );
}
