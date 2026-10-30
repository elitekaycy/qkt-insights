/*
 * What a shared link does where the signed-in dashboard would differ. A visitor never lands on a private path,
 * and never reads a failure: a strategy the link does not carry looks the same whether it is too new for the link's
 * delay, private or unknown, so the page says nothing about which.
 */

export type ShareKind = "overview" | "portfolio" | "strategy";

const PRIVATE_TAB = /^\/s\/([^/]+)\/(?:code|logs)(?:\/.*)?$/;

/** Where a shared link's private path belongs, or null when [path] is fine as it is. */
export function sharedLandingPath(path: string, kind: ShareKind): string | null {
  if (path === "/code" || path === "/logs") return "/";
  const tab = PRIVATE_TAB.exec(path);
  if (!tab) return null;
  return kind === "strategy" ? "/" : `/s/${tab[1]}`;
}

export type SharedStrategyState = "wait" | "show" | "not-on-link";

/** Whether a shared link shows [strategyId]: only one in its roster. An unread roster leaves it to the page's own reads. */
export function sharedStrategyState(roster: ReadonlyArray<{ strategyId: string }> | undefined, pending: boolean, strategyId: string): SharedStrategyState {
  if (pending) return "wait";
  if (!roster) return "show";
  return roster.some((s) => s.strategyId === strategyId) ? "show" : "not-on-link";
}

export const SHARED_LOAD_FAILURE = "These figures are not available right now.";
