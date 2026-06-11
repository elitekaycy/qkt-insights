import { useQuery } from "@tanstack/react-query";
import { get, type HealthRow } from "../api";

function age(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function Health() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 5000,
  });

  const rows = health.data ?? [];

  return (
    <div>
      <h2 className="text-xl font-semibold">Health</h2>
      <p className="mt-1 text-sm text-zinc-500">Every qkt instance the collector has heard from.</p>
      <div className="mt-6 overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">Instance</th>
              <th className="p-3">Last event</th>
              <th className="p-3">Last seq</th>
              <th className="p-3">Strategies</th>
              <th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-zinc-600">
                  No instances reporting yet — enable the insights block on a qkt instance.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const fresh = Date.now() - r.lastSeen < 30_000;
              return (
                <tr key={r.instanceId} className="border-t border-zinc-800">
                  <td className="p-3 font-medium">{r.instanceId}</td>
                  <td className="p-3 text-zinc-400">{age(r.lastSeen)}</td>
                  <td className="p-3 text-zinc-400">{r.lastSeq}</td>
                  <td className="p-3 text-zinc-400">{r.strategies}</td>
                  <td className="p-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        fresh ? "bg-emerald-900/60 text-emerald-300" : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {fresh ? "live" : "idle"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
