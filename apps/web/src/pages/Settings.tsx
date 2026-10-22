import { lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, logout, logoutEverywhere, type StrategyRow } from "../api";
import { ThemeToggle } from "../components/chrome";
import { InstallApp } from "../components/InstallApp";
import { ShareControl } from "../components/ShareControl";
import { Button, Card, PageFallback, PageHeader, Segmented } from "../components/ui";
import { portfolioGroupId, strategyDisplayName } from "../portfolio";
import { routePath, useRoute, type SettingsSection } from "../router";

const Viewership = lazy(() => import("./Viewership"));

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: "sharing", label: "Sharing" },
  { key: "viewership", label: "Viewership" },
  { key: "appearance", label: "Appearance" },
  { key: "account", label: "Account" },
];

/** Settings: public links and who opened them, the theme, and the session. */
export default function Settings({ instanceId, onSignedOut }: { instanceId: string | null; onSignedOut: () => void }) {
  const { route, navigate } = useRoute();
  const section = route.section ?? "sharing";
  return (
    <div>
      <PageHeader title="Settings" sub="Shared links, their viewers, the theme and your session." />
      <div className="mt-4">
        <Segmented label="Settings sections" value={section} options={SECTIONS} onChange={(s) => navigate(routePath({ page: "settings", section: s }))} />
      </div>
      <div className="mt-5">
        {section === "sharing" && <Sharing instanceId={instanceId} />}
        {section === "viewership" && (
          <Suspense fallback={<PageFallback />}>
            <Viewership instanceId={instanceId} />
          </Suspense>
        )}
        {section === "appearance" && <Appearance />}
        {section === "account" && <Account onSignedOut={onSignedOut} />}
      </div>
    </div>
  );
}

function Row({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-bright">{title}</div>
        {sub && <div className="text-xs text-muted">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/** Every shareable subject with its public/private toggle and link; strategies inherit from the overview. */
function Sharing({ instanceId }: { instanceId: string | null }) {
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });
  if (!instanceId) return <Card className="p-8 text-center text-muted">No instance selected.</Card>;
  const rows = (strategies.data ?? []).filter((s) => s.active);
  const portfolios = [...new Set(rows.map(portfolioGroupId).filter((p): p is string => p != null))];
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="max-w-2xl text-sm text-muted">
        A public link shows the page read-only, 15 minutes behind, without tickets, logs or account logins. Strategies and portfolios follow the
        overview unless set here.
      </p>
      <Card className="overflow-hidden">
        <Row title="Overview" sub={`the whole ${instanceId} dashboard`}>
          <ShareControl instanceId={instanceId} kind="overview" />
        </Row>
        {portfolios.map((p) => (
          <Row key={p} title={p} sub="portfolio">
            <ShareControl instanceId={instanceId} kind="portfolio" subject={p} />
          </Row>
        ))}
        {rows.map((r) => (
          <Row key={r.strategyId} title={strategyDisplayName(r)} sub="strategy">
            <ShareControl instanceId={instanceId} kind="strategy" subject={r.strategyId} />
          </Row>
        ))}
      </Card>
    </div>
  );
}

function Appearance() {
  return (
    <Card className="max-w-md overflow-hidden">
      <Row title="Theme" sub="dark is the default; the choice is remembered on this device">
        <div className="w-44">
          <ThemeToggle />
        </div>
      </Row>
      <Row title="Times" sub="every time in the dashboard is UTC and labelled so">
        <span className="text-sm text-body">UTC</span>
      </Row>
    </Card>
  );
}

function Account({ onSignedOut }: { onSignedOut: () => void }) {
  const queryClient = useQueryClient();
  return (
    <Card className="max-w-md overflow-hidden">
      <Row title="Install" sub="add the dashboard to your home screen or dock">
        <div className="w-48">
          <InstallApp variant="sidebar" />
        </div>
      </Row>
      <Row title="Sign out" sub="this device only">
        <Button
          onClick={async () => {
            onSignedOut();
            queryClient.clear();
            if (!(await logout())) window.addEventListener("online", () => void logout(), { once: true });
          }}
        >
          Sign out
        </Button>
      </Row>
      <Row title="Sign out everywhere" sub="every device with a session, this one included">
        <Button
          onClick={async () => {
            if (!window.confirm("Sign out every device, including this one?")) return;
            if (!(await logoutEverywhere())) {
              window.alert("Could not reach the collector. Nothing was signed out.");
              return;
            }
            onSignedOut();
            queryClient.clear();
          }}
        >
          Sign out everywhere
        </Button>
      </Row>
    </Card>
  );
}
