import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type SetMembershipChange, type SetMembershipView } from "../api";
import { Loadable, Pill } from "../components/ui";
import { DASH, ts, tsShort } from "../format";
import { changeWords, membersBySet, memberSymbol } from "./membership";
import { Widget } from "./widgets";

/*
 * Who is in the strategy's moving symbol sets now, and the latest changes of place, from qkt's set.membership
 * journal. Signed-in only: no public route serves it (api publicView.ts). A strategy without a moving set shows
 * nothing.
 */

/** Changes shown before "Show all". */
const FIRST_ROWS = 8;

function ChangeRow({ c, sets }: { c: SetMembershipChange; sets: boolean }) {
  const w = changeWords(c.change);
  return (
    <tr className="border-t border-line align-baseline">
      <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted">
        <span className="hidden sm:inline">{ts(c.ts)}</span>
        <span className="sm:hidden">{tsShort(c.ts)}</span>
      </td>
      {sets && <td className="py-1.5 pr-3 text-muted">{c.set}</td>}
      <td className="max-w-40 truncate py-1.5 pr-3 font-mono text-bright" title={c.member}>{memberSymbol(c.member)}</td>
      <td className="py-1.5 pr-3"><span title={w.explain}><Pill tone={w.tone}>{w.label}</Pill></span></td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-bright">{c.rank == null ? DASH : `#${c.rank}`}</td>
      <td className="hidden max-w-56 truncate py-1.5 text-muted md:table-cell" title={c.reason ?? undefined}>{c.reason ?? ""}</td>
    </tr>
  );
}

export function SetMembershipSection({ instanceId, strategyId }: { instanceId: string; strategyId: string }) {
  const q = useQuery({
    queryKey: ["set-membership", instanceId, strategyId],
    queryFn: () => get<SetMembershipView>(`/set-membership?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`),
    refetchInterval: 60_000,
  });
  const [all, setAll] = useState(false);
  // Most strategies have no moving set: nothing shows while loading or when the journal is empty.
  if (q.isPending || (q.data && q.data.changes.length === 0 && q.data.members.length === 0)) return null;
  const members = q.data?.members ?? [];
  const changes = q.data?.changes ?? [];
  const groups = membersBySet(members);
  const sets = new Set(changes.map((c) => c.set)).size > 1;
  const shown = all ? changes : changes.slice(0, FIRST_ROWS);
  return (
    <Widget
      title="Symbol sets"
      hint={`${members.length} member${members.length === 1 ? "" : "s"} now · UTC`}
      explain="The strategy's moving symbol sets as qkt journals them: who is in each set now (in the ranking, or sticky while it still holds a position), and every join, leave and restore with its rank and the close that decided it."
    >
      <Loadable loading={false} error={q.isError} retry={() => q.refetch()} what="the strategy's symbol sets" shape="lines" lines={4}>
        <div className="grid gap-3">
          {groups.length === 0 ? (
            <p className="text-sm text-muted">No member in any set now.</p>
          ) : (
            <dl className="grid gap-1.5">
              {groups.map((g) => (
                <div key={g.set} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <dt className="min-w-20 text-xs font-medium text-bright">{g.set}</dt>
                  {g.members.map((m) => (
                    <dd key={m.member} title={`${m.member}${m.state === "sticky" ? ": out of the ranking, kept while it holds" : ""}`}
                      className={`inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-xs ${m.state === "sticky" ? "border-warn/45 border-dashed" : "border-line bg-raised"}`}>
                      {m.rank != null && <span className="tabular-nums text-muted">#{m.rank}</span>}
                      <span className="font-mono text-bright">{memberSymbol(m.member)}</span>
                      {m.state === "sticky" && <span className="text-warn">sticky</span>}
                    </dd>
                  ))}
                </div>
              ))}
            </dl>
          )}
          {changes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <caption className="sr-only">Latest set membership changes, newest first</caption>
                <thead>
                  <tr className="text-left text-muted">
                    <th className="pb-1 pr-3 font-normal">Time</th>
                    {sets && <th className="pb-1 pr-3 font-normal">Set</th>}
                    <th className="pb-1 pr-3 font-normal">Member</th>
                    <th className="pb-1 pr-3 font-normal">Change</th>
                    <th className="pb-1 pr-3 text-right font-normal">Rank</th>
                    <th className="hidden pb-1 font-normal md:table-cell">Reason</th>
                  </tr>
                </thead>
                <tbody>{shown.map((c) => <ChangeRow key={c.id} c={c} sets={sets} />)}</tbody>
              </table>
              {changes.length > FIRST_ROWS && (
                <button type="button" onClick={() => setAll(!all)} className="mt-1 text-xs font-medium text-accent-ink">
                  {all ? "Show fewer" : `Show all ${changes.length} latest changes`}
                </button>
              )}
            </div>
          )}
        </div>
      </Loadable>
    </Widget>
  );
}
