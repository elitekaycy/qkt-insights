import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, Unauthorized, type InstanceRow } from "./api";
import Login from "./pages/Login";
import Health from "./pages/Health";
import Orderflow from "./pages/Orderflow";

type Page = "health" | "orderflow";

const NAV: { key: Page; label: string }[] = [
  { key: "health", label: "Health" },
  { key: "orderflow", label: "Orderflow" },
];

const STUBS = ["Strategies", "Trades", "Logs", "Search", "Equity"];

export default function App() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>("health");
  const [instance, setInstance] = useState<string | null>(null);

  const instances = useQuery({
    queryKey: ["instances"],
    queryFn: () => get<InstanceRow[]>("/instances"),
  });

  if (instances.error instanceof Unauthorized) {
    return <Login onLoggedIn={() => queryClient.invalidateQueries()} />;
  }

  const list = instances.data ?? [];
  const selected = instance ?? list[0]?.id ?? null;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <aside className="flex w-56 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="border-b border-zinc-800 p-4">
          <div className="text-sm font-semibold tracking-wide text-zinc-400">qkt insights</div>
          <select
            className="mt-2 w-full rounded bg-zinc-800 p-1.5 text-sm"
            value={selected ?? ""}
            onChange={(e) => setInstance(e.target.value)}
          >
            {list.length === 0 && <option value="">no instances yet</option>}
            {list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name ?? i.id}
              </option>
            ))}
          </select>
        </div>
        <nav className="flex-1 p-2">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setPage(n.key)}
              className={`block w-full rounded px-3 py-2 text-left text-sm ${
                page === n.key ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50"
              }`}
            >
              {n.label}
            </button>
          ))}
          {STUBS.map((s) => (
            <div key={s} className="cursor-not-allowed px-3 py-2 text-sm text-zinc-700">
              {s}
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        {page === "health" && <Health />}
        {page === "orderflow" && <Orderflow instanceId={selected} />}
      </main>
    </div>
  );
}
