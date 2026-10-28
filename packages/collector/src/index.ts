import type { FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  BatchSchema, CONTRACT_VERSION, SUPPORTED_MAJORS, classifyEnvelope, eventTypeMeta, isLiveStateType,
  type EnvelopeClass, type EventType, type EventTypeMeta,
} from "@qkt-insights/contract";
import {
  ingestAck, ingestEnvelopes, persistStateEvent, quarantineEnvelopes, touchInstance, upsertRoster,
  withoutAccountCredentials, withoutIgnoredHoldings, type Db, type IngestStatus, type LiveBus, type LiveStateStore,
} from "@qkt-insights/store";

export interface CollectorDeps { db: Db; bus: LiveBus; liveState: LiveStateStore; ingestToken: string }

/** Bad-token attempts allowed per IP per minute before ingest refuses that IP outright. */
export const INGEST_AUTH_FAILURES_PER_MINUTE = 20;

/** What `GET /ingest/capabilities` answers: the contract this collector speaks and the limits `/ingest` enforces. */
export interface IngestCapabilities {
  contractVersion: string;
  /** Envelope `v` values accepted; any other is quarantined. */
  majors: number[];
  types: Array<{ type: EventType } & EventTypeMeta>;
  /** Envelopes per batch; null when only the body size bounds a batch. */
  maxBatch: number | null;
  /** Largest request body `/ingest` reads; a larger one is refused with 413. */
  maxBodyBytes: number;
}

export function ingestCapabilities(maxBodyBytes: number): IngestCapabilities {
  return {
    contractVersion: CONTRACT_VERSION,
    majors: [...SUPPORTED_MAJORS],
    types: (Object.keys(eventTypeMeta) as EventType[]).sort().map((type) => ({ type, ...eventTypeMeta[type] })),
    maxBatch: null,
    maxBodyBytes,
  };
}

/** Per-envelope outcome in the ingest response. */
export interface EnvelopeStatus { id: string; status: IngestStatus | "quarantined"; reason?: string }

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Key for an envelope that carries no id: its JSON, so a redelivery maps to the same row. */
function contentId(raw: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(raw) ?? "null").digest("hex")}`;
}

/**
 * The envelope with its account credentials replaced before anything keeps or pushes it: account
 * ids opaque, logins masked, servers dropped (contract accountIdentity.ts).
 */
function withoutCredentials(c: EnvelopeClass): EnvelopeClass {
  if (c.ok) {
    const payload = withoutAccountCredentials(c.value.payload);
    return payload === c.value.payload ? c : { ok: true, value: { ...c.value, payload } as typeof c.value };
  }
  const raw = withoutAccountCredentials(c.quarantined.raw);
  return raw === c.quarantined.raw ? c : { ok: false, quarantined: { ...c.quarantined, raw } };
}

export function registerCollector(app: FastifyInstance, deps: CollectorDeps): void {
  // Digests have equal length, so the comparison is constant-time whatever the header holds.
  const expected = digest(`Bearer ${deps.ingestToken}`);
  const failures = new Map<string, { start: number; count: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of failures) if (now - w.start >= 60_000) failures.delete(ip);
  }, 60_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  /** The ingest token check, with its per-IP failure budget; false once it has sent the refusal. */
  const authorized = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const now = Date.now();
    const window = failures.get(req.ip);
    if (window && now - window.start < 60_000 && window.count >= INGEST_AUTH_FAILURES_PER_MINUTE) {
      reply.code(429).header("retry-after", 60).send({ error: "too many failed attempts" });
      return false;
    }
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) {
      if (!window || now - window.start >= 60_000) failures.set(req.ip, { start: now, count: 1 });
      else window.count++;
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  // Fixed for the process. /ingest declares no bodyLimit of its own, so the server's applies to it; Fastify
  // fills in its default when the server sets none.
  const capabilities = JSON.stringify(ingestCapabilities(app.initialConfig.bodyLimit!));
  const capabilitiesTag = `"${createHash("sha256").update(capabilities).digest("base64url").slice(0, 22)}"`;
  app.get("/ingest/capabilities", async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    reply.header("etag", capabilitiesTag).header("cache-control", "private, no-cache");
    if (req.headers["if-none-match"] === capabilitiesTag) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(capabilities);
  });

  app.post("/ingest", async (req, reply) => {
    if (!authorized(req, reply)) return reply;

    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid batch", detail: parsed.error.message });

    const { instanceId } = parsed.data;
    const classes = parsed.data.events.map((raw) => withoutCredentials(classifyEnvelope(raw)));
    for (const c of classes) {
      const envelopeInstance = c.ok ? c.value.instanceId : c.quarantined.instanceId;
      if (envelopeInstance != null && envelopeInstance !== instanceId) {
        const id = c.ok ? c.value.id : c.quarantined.id;
        return reply.code(400).send({
          error: "instance mismatch",
          detail: `batch instanceId ${instanceId} does not match envelope ${id} instanceId ${envelopeInstance}`,
        });
      }
    }
    // One envelope the contract cannot read must never cost the rest of the batch: qkt's journal
    // retries a rejected head batch forever. It is kept raw, acknowledged, and counted on Health.
    // Holdings in a magic range the instance ignores (store ignoredMagics.ts) never reach the live state or the bus.
    const events = classes.flatMap((c) => (c.ok ? [withoutIgnoredHoldings(deps.db, instanceId, c.value)] : []));
    const quarantined = classes.flatMap((c) => (c.ok ? [] : [{ ...c.quarantined, id: c.quarantined.id ?? contentId(c.quarantined.raw) }]));
    if (quarantined.length > 0) quarantineEnvelopes(deps.db, instanceId, quarantined);

    // Last-value state lives in memory only; the roster replaces a table; the rest
    // is durable events. None of state.account/positions/orders or instance.roster writes an event row.
    const stateEvents = events.filter((e) => isLiveStateType(e.type));
    const rosterEvents = events.filter((e) => e.type === "instance.roster");
    const rest = events.filter((e) => !isLiveStateType(e.type) && e.type !== "instance.roster");
    const outcome = ingestEnvelopes(deps.db, instanceId, rest);
    for (const e of stateEvents) {
      deps.liveState.upsert(instanceId, e);
      persistStateEvent(deps.db, instanceId, e);
    }
    // Each session announces only its own ids; upsert them all so sessions union
    // instead of overwriting, and each bump refreshes that id's freshness.
    for (const e of rosterEvents) upsertRoster(deps.db, instanceId, e.payload.strategies, e.ts);
    // state.* and instance.roster write no durable row, but the poll cycle that emits
    // them is the freshest proof the instance is alive — bump the heartbeat so Health
    // doesn't read it as stale. A quarantined envelope proves the same.
    const heartbeats = [...stateEvents, ...rosterEvents, ...quarantined.filter((q) => q.ts != null).map((q) => ({ ts: q.ts as number, seq: 0 }))];
    if (heartbeats.length > 0)
      touchInstance(deps.db, instanceId,
        Math.max(...heartbeats.map((e) => e.ts)),
        Math.max(...heartbeats.map((e) => e.seq)));
    for (const e of events) deps.bus.publish(e);

    const restStatus = new Map(rest.map((e, i) => [e, outcome.statuses[i]!]));
    let q = 0;
    const statuses: EnvelopeStatus[] = classes.map((c) => {
      if (!c.ok) {
        const { id, reason } = quarantined[q++]!;
        return { id, status: "quarantined", reason };
      }
      return { id: c.value.id, status: restStatus.get(c.value) ?? "accepted" };
    });
    return reply.code(200).send({
      accepted: outcome.accepted + stateEvents.length,
      quarantined: quarantined.length,
      envelopes: statuses,
      ack: {
        ...ingestAck(deps.db, instanceId),
        received: classes.length,
        acknowledgedIds: statuses.map((s) => s.id),
      },
    });
  });
}
