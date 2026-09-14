import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { WindowCounter } from "./limits.js";

export interface SecurityOptions {
  /** Per client IP, across every route except ingest and the health probe. */
  requestsPerMinute: number;
}

export const REQUESTS_PER_MINUTE = 600;

const HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const HSTS_MAX_AGE_S = 31_536_000;

function exempt(req: FastifyRequest): boolean {
  const path = req.url.split("?")[0];
  return (req.method === "POST" && path === "/ingest") || path === "/healthz";
}

function contentSecurityPolicy(host: string | undefined): string {
  const socket = host && HOST_PATTERN.test(host) ? ` wss://${host} ws://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React and ECharts write style attributes; Google Fonts serves the stylesheet.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    // The service worker fetches Google Fonts for its runtime cache under this same policy.
    `connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com${socket}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers, per-IP request budget and scrubbed 5xx bodies for a collector that faces the internet. */
export function registerSecurity(app: FastifyInstance, opts: SecurityOptions): void {
  const budget = new WindowCounter(opts.requestsPerMinute, 60_000);
  const sweep = setInterval(() => budget.sweep(), 60_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  app.addHook("onRequest", async (req, reply) => {
    if (exempt(req)) return;
    if (!budget.hit(req.ip)) {
      await reply.code(429).header("retry-after", Math.max(1, Math.ceil(budget.retryAfterMs(req.ip) / 1000))).send({ error: "too many requests" });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("content-security-policy", contentSecurityPolicy(req.headers.host));
    reply.header("x-frame-options", "DENY");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (req.protocol === "https") reply.header("strict-transport-security", `max-age=${HSTS_MAX_AGE_S}`);
    // Shared links are for the people they are sent to, not for search engines.
    if (req.url.startsWith("/p/") || req.url.startsWith("/public/")) reply.header("x-robots-tag", "noindex, nofollow");
    const type = String(reply.getHeader("content-type") ?? "");
    if (type.startsWith("application/json") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(status).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });
}
