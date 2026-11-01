import { useQuery } from "@tanstack/react-query";
import { get, type StrategyConfigVersion, type StrategyConfigView } from "../api";
import { Loadable, Popover } from "../components/ui";
import { tsDay } from "../format";
import { configChanges, configGroups, currencyHint, type ConfigRow } from "./config/rows";
import { Widget } from "./widgets";

/*
 * What this strategy runs on: the settings qkt resolved at its start, in plain words. qkt sends an allow-list of
 * values, never its config file, and only a signed-in session can read it (api rest.ts /strategy-config).
 */

const NOT_SENT = "Not sent by this qkt version.";
const NOT_RECEIVED = "Not received for this configuration. qkt sends it once per process and configuration, and it is sent again the next time the qkt process restarts.";

function Quiet({ children }: { children: string }) {
  return <p className="rounded-lg border border-line bg-raised px-3 py-4 text-sm text-muted">{children}</p>;
}

function Row({ row }: { row: ConfigRow }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1">
      <dt className="min-w-0 text-xs text-muted">
        <Popover hover label={`What ${row.label} means`} trigger={<span className="cursor-help text-left underline decoration-line-strong decoration-dotted underline-offset-4">{row.label}</span>}>
          <span className="block max-w-64 whitespace-normal">
            {row.explain}
            {row.isDefault && " qkt's default: the config file does not set it."}
            {row.yaml && <span className="mt-1 block break-all font-mono text-xs text-muted">{row.yaml}</span>}
          </span>
        </Popover>
      </dt>
      <dd className="max-w-48 text-right text-sm tabular-nums text-bright">
        {row.value}
        {row.isDefault && <span className="ml-1.5 text-xs text-muted">default</span>}
      </dd>
    </div>
  );
}

/** Each earlier configuration, what changed to reach the next and when. */
function History({ versions }: { versions: StrategyConfigVersion[] }) {
  if (versions.length < 2) return null;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer select-none py-1">{versions.length} configurations over time</summary>
      <ol className="grid gap-2 pt-1">
        {versions.map((v, i) => {
          const before = versions[i + 1];
          const changes = v.config && before?.config ? configChanges(before.config, v.config) : null;
          return (
            <li key={v.sha256}>
              <div className="text-bright">{tsDay(v.firstSeen)} UTC</div>
              {!before ? <div>First reported</div> : changes == null ? <div>Settings not received</div> : changes.length === 0 ? <div>No setting shown here changed</div> : changes.map((c) => (
                <div key={c.label}>{c.label}: {c.from ?? "not stated"} → {c.to ?? "not stated"}</div>
              ))}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export default function ConfigurationSection({ instanceId, strategyId }: { instanceId: string; strategyId: string }) {
  const q = useQuery({
    queryKey: ["strategy-config", instanceId, strategyId],
    queryFn: () => get<StrategyConfigView>(`/strategy-config?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`),
    refetchInterval: 60_000,
  });
  const versions = q.data?.versions ?? [];
  const running = q.data?.running ? versions.find((v) => v.sha256 === q.data!.running) : undefined;
  const config = running?.config ?? null;
  const accountCurrencies = q.data?.accountCurrencies ?? [];
  return (
    <Widget
      title="Configuration"
      hint={config ? currencyHint(config, accountCurrencies) : undefined}
      explain="What this strategy runs on, as qkt resolved it when the strategy started: the config file, its environment and qkt's defaults together. Secrets are never sent."
    >
      <Loadable loading={q.isPending} error={q.isError} retry={() => q.refetch()} what="the strategy's configuration" shape="lines" lines={8}>
        <div className="grid gap-3">
          {config ? (
            configGroups(config, accountCurrencies).map((g) => (
              <section key={g.title}>
                <h4 className="border-b border-line pb-1 text-xs font-medium text-bright">{g.title}</h4>
                <dl className="pt-1">{g.rows.map((r) => <Row key={r.id} row={r} />)}</dl>
              </section>
            ))
          ) : (
            <Quiet>{q.data?.running ? NOT_RECEIVED : NOT_SENT}</Quiet>
          )}
          <History versions={versions} />
        </div>
      </Loadable>
    </Widget>
  );
}
