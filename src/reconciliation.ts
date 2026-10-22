import type { FastifyBaseLogger } from "fastify";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { listInstances, reconcileSteps, type Db, type LiveStateStore, type VenuePositionsReport } from "@qkt-insights/store";

/*
 * When the venue reconciliation runs (store reconciliation.ts): once shortly after the server
 * listens, then every night at RECONCILE_HOUR_UTC. The first run waits FIRST_RUN_AFTER_MS so a
 * backlog of ingest goes first and the live state has heard the venue's positions again (it starts
 * empty at boot). A run is a series of short steps with the event loop free between them, so
 * requests and ingest are never held up for the whole run.
 */

/** Two hours after the UTC day closes: late deals and qkt's journal replays have landed. */
export const RECONCILE_HOUR_UTC = 2;
export const FIRST_RUN_AFTER_MS = 2 * 60_000;
const DAY = 86_400_000;

/** The next RECONCILE_HOUR_UTC strictly after `now`. */
export function nextNightlyRun(now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RECONCILE_HOUR_UTC);
  return today > now ? today : today + DAY;
}

/** The live state's position groups of one instance, as the positions check reads them. */
export function venuePositions(liveState: LiveStateStore, instanceId: string, now: number): VenuePositionsReport[] {
  return liveState.snapshot(now).positions
    .filter((g) => g.instanceId === instanceId)
    .map((g) => ({ broker: g.broker, at: g.at, list: g.list }));
}

export interface ReconciliationDeps {
  db: Db;
  liveState: LiveStateStore;
  log: FastifyBaseLogger;
}

/** Reconciles every instance once, yielding between steps; a failure is logged, never thrown. */
export async function reconcileAll(deps: ReconciliationDeps, now = Date.now()): Promise<void> {
  for (const instance of listInstances(deps.db)) {
    try {
      const started = performance.now();
      let longestStepMs = 0;
      const steps = reconcileSteps(deps.db, instance.id, { now, positions: venuePositions(deps.liveState, instance.id, now) });
      for (;;) {
        const stepStarted = performance.now();
        const r = steps.next();
        longestStepMs = Math.max(longestStepMs, performance.now() - stepStarted);
        if (r.done) {
          const fields = { instance: instance.id, ...r.value, ms: Math.round(performance.now() - started), longestStepMs: Math.round(longestStepMs) };
          if (r.value.diffs > 0) deps.log.warn(fields, "venue reconciliation found differences");
          else deps.log.info(fields, "venue reconciliation");
          break;
        }
        await yieldToEventLoop();
      }
    } catch (err) {
      deps.log.error({ err, instance: instance.id }, "venue reconciliation failed");
    }
  }
}

/** Schedules the runs; returns the stop. Timers are unref'd so they never hold the process open. */
export function startReconciliation(deps: ReconciliationDeps, firstAfterMs = FIRST_RUN_AFTER_MS): () => void {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileAll(deps);
    } finally {
      running = false;
    }
  };
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => void run().then(arm), nextNightlyRun(Date.now()) - Date.now());
    timer.unref();
  };
  const first = setTimeout(() => void run(), firstAfterMs);
  first.unref();
  arm();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearTimeout(timer);
  };
}
