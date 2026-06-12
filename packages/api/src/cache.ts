/**
 * Short-lived memo for hot read endpoints. The first call for a key runs
 * `loader`; calls with the same key inside the TTL return the stored value
 * without touching the database. Dashboards poll the same handful of URLs
 * every few seconds, so even a 5s window collapses most of that load.
 * e.g. two browsers polling GET /stats?instance=qkt-prod → one query per 5s.
 *
 * Bounded: past `maxEntries` the oldest-inserted entry is dropped (Map keeps
 * insertion order), so an attacker spraying unique querystrings cannot grow
 * memory without limit.
 */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 5000,
    private readonly maxEntries = 200,
    private readonly clock: () => number = Date.now,
  ) {}

  async get<T>(key: string, loader: () => T | Promise<T>): Promise<T> {
    const now = this.clock();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
    const value = await loader();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}
