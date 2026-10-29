import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, rotateShareLink, setShareVisibility, shareUrl, type ShareKind, type ShareState, type SharesView } from "../api";
import { useView } from "../view";
import { Popover } from "./ui";

const GLOBE = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18";
const LOCK = "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4";

/** The delay a collector applies to shared links when it does not state one (PUBLIC_DELAY_MINUTES' default). */
const DEFAULT_DELAY_MINUTES = 15;

function stateOf(view: SharesView | undefined, kind: ShareKind, subject: string): ShareState | null {
  if (!view) return null;
  if (kind === "overview") return view.overview;
  const list = kind === "portfolio" ? view.portfolios : view.strategies;
  return list.find((s) => s.id === subject) ?? null;
}

function Icon({ d, className = "h-4 w-4" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

const SMALL = "inline-flex h-8 items-center justify-center rounded-lg border px-3 text-xs font-semibold transition disabled:opacity-50";
const QUIET = `${SMALL} border-ctl bg-raised text-bright hover:bg-well`;

/** What a public link of this subject shows, in the words of the confirm. */
function subjectWords(kind: ShareKind): string {
  return kind === "overview" ? "this dashboard's P&L" : kind === "portfolio" ? "this portfolio's P&L" : "this strategy's P&L";
}

/**
 * "Share…": the overview's, a portfolio's or a strategy's sharing in one small panel. It says the state first
 * (private, or public with its link), and going public takes an explicit confirm that says what a stranger will
 * see and how far behind. Making it private, copying and replacing the link are one click from there. Absent on
 * shared links.
 */
export function ShareControl({ instanceId, kind, subject = "" }: { instanceId: string; kind: ShareKind; subject?: string }) {
  const view = useView();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const shares = useQuery({
    queryKey: ["shares", instanceId],
    queryFn: () => get<SharesView>(`/shares?instance=${encodeURIComponent(instanceId)}`),
    enabled: !view.public,
    staleTime: 10_000,
  });
  const update = (next: SharesView) => qc.setQueryData(["shares", instanceId], next);
  const toggle = useMutation({
    mutationFn: (visibility: "public" | "private" | null) => setShareVisibility(instanceId, kind, subject, visibility),
    onSuccess: (next) => { update(next); setConfirming(false); },
  });
  const rotate = useMutation({ mutationFn: () => rotateShareLink(instanceId, kind, subject), onSuccess: update });

  if (view.public) return null;
  const state = stateOf(shares.data, kind, subject);
  if (!state) return null;
  const busy = toggle.isPending || rotate.isPending;
  const delay = shares.data?.delayMinutes ?? DEFAULT_DELAY_MINUTES;
  const inherited = state.visibility == null && kind !== "overview";
  const url = state.token ? shareUrl(state.token) : null;

  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const trigger = (
    <span
      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition ${
        state.effective ? "border-accent/50 bg-accent/10 text-accent-ink" : "border-ctl bg-raised text-body hover:border-line-strong hover:text-bright"
      }`}
    >
      <Icon d={state.effective ? GLOBE : LOCK} />
      {state.effective ? "Public…" : "Share…"}
    </span>
  );

  return (
    <div className="flex items-center gap-1.5">
      {state.views > 0 && (
        <span className="px-1 text-xs text-muted" title="views of this link in the last 90 days, details on Viewership">
          {state.views} {state.views === 1 ? "view" : "views"}
        </span>
      )}
      <Popover label={state.effective ? "Sharing: public" : "Sharing: private"} align="right" trigger={trigger}>
        <div className="grid w-[min(18rem,calc(100vw-2.5rem))] gap-2.5">
          <p className="flex items-center gap-1.5 font-semibold text-bright">
            <Icon d={state.effective ? GLOBE : LOCK} className="h-3.5 w-3.5" />
            {state.effective ? "Public" : "Private"}
            {inherited && <span className="font-normal text-muted">· from the overview</span>}
          </p>
          {state.effective ? (
            <>
              <p className="text-muted">Anyone with the link sees it, {delay} minutes behind.</p>
              {url && (
                <div className="flex items-center gap-1.5">
                  <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Public link" className="h-8 min-w-0 flex-1 rounded-lg border border-ctl bg-panel px-2 font-mono text-[11px] text-body" />
                  <button type="button" onClick={() => void copy()} className={QUIET}>{copied ? "Copied" : "Copy"}</button>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={busy} onClick={() => toggle.mutate("private")} className={QUIET}>Make private</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { if (window.confirm("Replace the link? Anyone holding the current one loses access.")) rotate.mutate(); }}
                  className={QUIET}
                  title="The current link stops working"
                >
                  New link
                </button>
                {state.visibility != null && kind !== "overview" && (
                  <button type="button" disabled={busy} onClick={() => toggle.mutate(null)} className={QUIET} title="Stop overriding: follow the portfolio or overview setting again">
                    Follow above
                  </button>
                )}
              </div>
            </>
          ) : confirming ? (
            <>
              <p className="text-body">Anyone with the link sees {subjectWords(kind)}, {delay} minutes behind.</p>
              <div className="flex gap-1.5">
                <button type="button" disabled={busy} onClick={() => toggle.mutate("public")} className={`${SMALL} border-transparent bg-accent text-on-accent hover:bg-accent-hi`}>
                  Make public
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={QUIET}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-muted">Only you can see it.</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => setConfirming(true)} className={QUIET}>Create a public link…</button>
                {state.visibility != null && kind !== "overview" && (
                  <button type="button" disabled={busy} onClick={() => toggle.mutate(null)} className={QUIET} title="Stop overriding: follow the portfolio or overview setting again">
                    Follow above
                  </button>
                )}
              </div>
            </>
          )}
          {toggle.isError && <p className="text-loss">The change did not save. Try again.</p>}
        </div>
      </Popover>
    </div>
  );
}
