export function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  const color = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

export function SidePill({ side }: { side: string | null }) {
  if (!side) return <span className="text-zinc-600">—</span>;
  return <span className={side === "BUY" ? "text-emerald-400" : "text-red-400"}>{side}</span>;
}

export const LEVEL_COLOR: Record<string, string> = {
  ERROR: "bg-red-900/60 text-red-300",
  WARN: "bg-amber-900/60 text-amber-300",
  INFO: "bg-sky-900/60 text-sky-300",
  DEBUG: "bg-zinc-800 text-zinc-400",
};
