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

  /** The live value for a key, without loading it. */
  peek<T>(key: string): T | undefined {
    const hit = this.entries.get(key);
    return hit && hit.expiresAt > this.clock() ? (hit.value as T) : undefined;
  }

  /** The value for a key even after it expired, until it is evicted or cleared. */
  peekStale<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }

  /** Drops the entries whose key starts with the prefix. */
  deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drops every entry, so a change that alters many responses (a share turned private) takes effect at once. */
  clear(): void {
    this.entries.clear();
  }

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
