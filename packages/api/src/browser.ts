import type { FastifyInstance } from "fastify";

/**
 * API roots that share a name with what a person might type for a page, and the page each one means
 * (apps/web/src/routes.ts PAGE_PATHS). The search page gave way to Logs, where text search lives.
 */
export const BROWSER_PAGES: Readonly<Record<string, string>> = {
  "/trades": "/t",
  "/strategies": "/s",
  "/health": "/status",
  "/logs": "/log",
  "/search": "/log",
};

/** The q-weight an Accept header gives `type` (exact, then its `group/*`, then the any-type range); 0 when nothing covers it. */
function weight(accept: string, type: string): { q: number; exact: boolean } {
  const [group] = type.split("/");
  let best = { q: 0, exact: false, rank: -1 };
  for (const part of accept.split(",")) {
    const [range = "", ...params] = part.trim().toLowerCase().split(";");
    const rank = range === type ? 2 : range === `${group}/*` ? 1 : range === "*/*" ? 0 : -1;
    if (rank < best.rank || rank < 0) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qp ? Number(qp.slice(2)) : 1;
    best = { q: Number.isFinite(q) ? q : 0, exact: rank === 2, rank };
  }
  return { q: best.q, exact: best.exact };
}

/**
 * True for a browser navigation: the Accept header names text/html itself and ranks it above JSON. A fetch with
 * no Accept, the any-type range or `application/json` is an API client.
 */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  const html = weight(accept, "text/html");
  return html.exact && html.q > 0 && html.q > weight(accept, "application/json").q;
}

/**
 * A person who types an API root into the address bar (http://host/trades) gets the page it names with a 302,
 * not `{"error":"instance required"}`. Only a GET whose Accept prefers HTML is redirected; API clients are
 * unchanged. Runs before the session guard, so a signed-out browser lands on the app's sign-in.
 */
export function registerBrowserRedirects(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET") return;
    const page = BROWSER_PAGES[req.url.split("?")[0]!.replace(/\/+$/u, "") || "/"];
    if (page && prefersHtml(req.headers.accept)) return reply.redirect(page, 302);
  });
}
