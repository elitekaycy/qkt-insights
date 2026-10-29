/*
 * How an instance's reporting reads in the shell: nothing while it reports on time, then stale, then down. The
 * thresholds are the collector's: the 30 s heartbeat, and the heartbeat monitor's 150 s before it calls one down.
 */

/** A quiet instance: stale once it misses the 30 s pulse, down after the heartbeat monitor's 150 s. */
const INSTANCE_STALE_MS = 30_000;
const INSTANCE_DOWN_MS = 150_000;

/** The age of the instance's last report in words, "45s" or "12m"; null while it reports on time. */
export function instanceState(lastSeen: number | null | undefined, now: number): { state: "stale" | "down"; age: string } | null {
  if (lastSeen == null) return null;
  const ms = now - lastSeen;
  if (ms < INSTANCE_STALE_MS) return null;
  const s = Math.floor(ms / 1000);
  const age = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
  return { state: ms >= INSTANCE_DOWN_MS ? "down" : "stale", age };
}
