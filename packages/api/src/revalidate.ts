import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { dataVersion, type Db, type VersionScope } from "@qkt-insights/store";
import { TtlCache } from "./cache.js";

/** Versions restart at zero on every boot; this keeps an old process's tags from matching. */
const BOOT = randomBytes(6).toString("base64url");

function urlTag(url: string): string {
  return createHash("sha256").update(url).digest("base64url").slice(0, 12);
}

/** True when an If-None-Match header lists the tag (weak comparison, as GET revalidation uses). */
export function matchesTag(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const bare = tag.replace(/^W\//u, "");
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//u, "") === bare;
  });
}

/**
 * Responses that change only when the rows they read change. The tag is the data version of the
 * scopes the response reads (see versions.ts), so an unchanged poll answers 304 without running
 * the query, and a changed one is built once per version and shared until the next write.
 * e.g. the strategy page polling /performance every 30 s gets 304 until that strategy trades.
 */
export class Revalidated {
  private readonly cache: TtlCache;

  constructor(private readonly db: Db, ttlMs = 60_000) {
    this.cache = new TtlCache(ttlMs, 200);
  }

  async send<T>(req: FastifyRequest, reply: FastifyReply, scopes: VersionScope[], loader: () => T): Promise<T | undefined> {
    const version = dataVersion(this.db, scopes);
    const tag = `W/"${BOOT}.${urlTag(req.url)}.${version}"`;
    // private: the body is one operator's data; no-cache: store it, but ask before every reuse.
    reply.header("etag", tag).header("cache-control", "private, no-cache");
    if (matchesTag(req.headers["if-none-match"], tag)) {
      await reply.code(304).send();
      return undefined;
    }
    return this.cache.get(`${req.url}#${version}`, loader);
  }
}
