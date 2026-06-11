import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, Unauthorized, type InstanceRow } from "./api";
import Login from "./pages/Login";
import Health from "./pages/Health";
import Orderflow from "./pages/Orderflow";
import Strategies from "./pages/Strategies";
import Trades from "./pages/Trades";
import Logs from "./pages/Logs";
import Search from "./pages/Search";
import Equity from "./pages/Equity";

type Page = "health" | "strategies" | "orderflow" | "trades" | "equity" | "logs" | "search";

const NAV: { key: Page; label: string }[] = [
  { key: "health", label: "Health" },
  { key: "strategies", label: "Strategies" },
  { key: "orderflow", label: "Orderflow" },
  { key: "trades", label: "Trades" },
  { key: "equity", label: "Equity" },
  { key: "logs", label: "Logs" },
  { key: "search", label: "Search" },
];

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
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        {page === "health" && <Health />}
        {page === "strategies" && <Strategies instanceId={selected} />}
        {page === "orderflow" && <Orderflow instanceId={selected} />}
        {page === "trades" && <Trades instanceId={selected} />}
        {page === "equity" && <Equity instanceId={selected} />}
        {page === "logs" && <Logs instanceId={selected} />}
        {page === "search" && <Search instanceId={selected} />}
      </main>
    </div>
  );
}
