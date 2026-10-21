import { useQuery } from "@tanstack/react-query";
import { get, type AccountSummary } from "../api";
import { CalendarView } from "../components/Calendar";
import { Card, Loadable, PageHeader } from "../components/ui";
import { usePublicPageView, useView } from "../view";

/** The account's P&L calendar: every close on the account by UTC day, with monthly returns. */
export default function CalendarPage({ instanceId }: { instanceId: string | null }) {
  const view = useView();
  // the collector counts the calendar under its overview link (it shows the same account data)
  usePublicPageView("overview");
  const summary = useQuery({
    queryKey: ["accountSummary", instanceId],
    queryFn: () => get<AccountSummary>(`/account/summary?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 60_000,
  });
  if (!instanceId) return <Card className="p-8 text-center text-muted">No instance selected.</Card>;
  const bases = new Map((summary.data?.monthBases ?? []).map((b) => [b.period, b]));
  const baseLabel = summary.data?.monthBases.some((b) => b.source === "account equity") ? "account equity at month start" : "account start balance";
  return (
    <div>
      <PageHeader
        title="Calendar"
        sub={`Every day's realized P&L on ${instanceId}, week by week${view.public ? `, ${view.meta.delayMinutes} minutes behind` : ""}. Retired strategies and unattributed deals included.`}
      />
      <div className="mt-5">
        <Loadable loading={summary.isPending} error={summary.isError} retry={() => summary.refetch()} what="the calendar" lines={8}>
          {summary.data && <CalendarView days={summary.data.dailyNets} returnBase={(month) => bases.get(month)?.base ?? null} baseLabel={baseLabel} drill={{ instanceId }} />}
        </Loadable>
      </div>
    </div>
  );
}
