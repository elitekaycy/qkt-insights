import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, rotateShareLink, setShareVisibility, shareUrl, type ShareKind, type ShareState, type SharesView } from "../api";
import { useView } from "../view";

const EYE = "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z";
const EYE_OFF = "M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22";
const COPY = "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1";
const CHECK = "M20 6L9 17l-5-5";
const ROTATE = "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6";
const INHERIT = "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3";

function stateOf(view: SharesView | undefined, kind: ShareKind, subject: string): ShareState | null {
  if (!view) return null;
  if (kind === "overview") return view.overview;
  const list = kind === "portfolio" ? view.portfolios : view.strategies;
  return list.find((s) => s.id === subject) ?? null;
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const BUTTON = "inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition disabled:opacity-50";

/**
 * Eye toggle and share link for the overview, a portfolio or a strategy. Absent on shared
 * links. The copy and regenerate icons appear only while the subject is public.
 */
export function ShareControl({ instanceId, kind, subject = "" }: { instanceId: string; kind: ShareKind; subject?: string }) {
  const view = useView();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const shares = useQuery({
    queryKey: ["shares", instanceId],
    queryFn: () => get<SharesView>(`/shares?instance=${encodeURIComponent(instanceId)}`),
    enabled: !view.public,
    staleTime: 10_000,
  });
  const update = (next: SharesView) => qc.setQueryData(["shares", instanceId], next);
  const toggle = useMutation({
    mutationFn: (visibility: "public" | "private" | null) => setShareVisibility(instanceId, kind, subject, visibility),
    onSuccess: update,
  });
  const rotate = useMutation({ mutationFn: () => rotateShareLink(instanceId, kind, subject), onSuccess: update });

  if (view.public) return null;
  const state = stateOf(shares.data, kind, subject);
  if (!state) return null;
  const busy = toggle.isPending || rotate.isPending;
  const what = kind === "overview" ? "overview" : kind;
  const origin = state.visibility != null ? "set here" : kind === "overview" ? "default" : "inherited";

  const copy = async () => {
    if (!state.token) return;
    await navigator.clipboard.writeText(shareUrl(state.token));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => toggle.mutate(state.effective ? "private" : "public")}
        aria-pressed={state.effective}
        title={`${state.effective ? "Public" : "Private"} (${origin}). Click to make this ${what} ${state.effective ? "private" : "public"}.`}
        className={`${BUTTON} ${state.effective ? "border-accent/50 bg-accent/10 text-accent" : "border-line bg-raised text-muted hover:border-line-strong hover:text-body"}`}
      >
        <Icon d={state.effective ? EYE : EYE_OFF} />
        {state.effective ? "Public" : "Private"}
      </button>
      {state.visibility != null && kind !== "overview" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => toggle.mutate(null)}
          title="Stop overriding: follow the portfolio or overview setting again"
          aria-label="reset to inherited visibility"
          className={`${BUTTON} border-line bg-raised text-muted hover:border-line-strong hover:text-body`}
        >
          <Icon d={INHERIT} />
        </button>
      )}
      {state.effective && state.token && (
        <>
          <button
            type="button"
            onClick={() => void copy()}
            title="Copy the public link"
            aria-label="copy public link"
            className={`${BUTTON} border-line bg-raised ${copied ? "text-up" : "text-muted hover:border-line-strong hover:text-body"}`}
          >
            <Icon d={copied ? CHECK : COPY} />
            {copied && "Copied"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Replace the link? Anyone holding the current one loses access.")) rotate.mutate();
            }}
            title="Regenerate the link: the current one stops working"
            aria-label="regenerate public link"
            className={`${BUTTON} border-line bg-raised text-muted hover:border-line-strong hover:text-body`}
          >
            <Icon d={ROTATE} />
          </button>
        </>
      )}
    </div>
  );
}
