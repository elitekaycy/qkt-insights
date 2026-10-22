import { z } from "zod";
import { payloadByType, type EventType } from "./payloads.js";

/** The envelope major the schemas below describe. */
const ENVELOPE_MAJOR = 1;

/** Envelope majors this collector reads. Any other `v` is quarantined, never rejected. */
export const SUPPORTED_MAJORS: readonly number[] = [ENVELOPE_MAJOR];

/** Last-value broker state: held in memory and `positions_current`, never written as an event row. */
export const LIVE_STATE_TYPES = ["state.account", "state.positions", "state.orders"] as const;

export function isLiveStateType(type: string): boolean {
  return (LIVE_STATE_TYPES as readonly string[]).includes(type);
}

const envelopeFields = { instanceId: z.string().min(1), id: z.string().min(1),
  seq: z.number().int().nonnegative(), ts: z.number().int(), strategyId: z.string().optional() };

/** The fields every envelope must carry whatever its type or major; checked before the payload. */
export const EnvelopeBaseSchema = z.object({ v: z.number().int(), ...envelopeFields, type: z.string().min(1), payload: z.unknown() });

const variants = (Object.entries(payloadByType) as [EventType, z.ZodTypeAny][]).map(([type, payload]) =>
  z.object({ v: z.literal(ENVELOPE_MAJOR), ...envelopeFields, type: z.literal(type), payload }),
);

export const EnvelopeSchema = z.discriminatedUnion("type", variants as [typeof variants[number], ...typeof variants]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseEnvelope(input: unknown): { ok: true; value: Envelope } | { ok: false; error: string } {
  const r = EnvelopeSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
}

/** A batch is checked only for its shape; each envelope in it is classified on its own. */
export const BatchSchema = z.object({ instanceId: z.string().min(1), events: z.array(z.unknown()) });
export type Batch = z.infer<typeof BatchSchema>;

/** An envelope the collector cannot project, kept raw so a later contract can replay it. */
export interface QuarantinedEnvelope {
  /** The envelope's own id; null when it has none (the collector then keys it by content). */
  id: string | null;
  instanceId: string | null;
  type: string | null;
  v: number | null;
  ts: number | null;
  reason: string;
  raw: unknown;
}

export type EnvelopeClass = { ok: true; value: Envelope } | { ok: false; quarantined: QuarantinedEnvelope };

const REASON_MAX = 500;

function issuesText(error: z.ZodError): string {
  const text = error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "envelope"}: ${i.message}`).join("; ");
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 3)}...` : text;
}

function field<T>(raw: unknown, key: string, guard: (v: unknown) => v is T): T | null {
  if (raw == null || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>)[key];
  return guard(v) ? v : null;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isInteger = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Sort one wire envelope into "project it" or "keep it raw": the envelope base first, then the
 * major version, then the payload schema of a known type.
 * e.g. `{v:1, type:"signal.future", ...}` → quarantined, reason `unknown type "signal.future"`.
 */
export function classifyEnvelope(raw: unknown): EnvelopeClass {
  const quarantine = (reason: string): EnvelopeClass => ({
    ok: false,
    quarantined: {
      id: field(raw, "id", isString),
      instanceId: field(raw, "instanceId", isString),
      type: field(raw, "type", isString),
      v: field(raw, "v", isInteger),
      ts: field(raw, "ts", isInteger),
      reason,
      raw,
    },
  });
  const base = EnvelopeBaseSchema.safeParse(raw);
  if (!base.success) return quarantine(issuesText(base.error));
  if (!SUPPORTED_MAJORS.includes(base.data.v)) return quarantine(`unsupported major version ${base.data.v}`);
  if (!Object.hasOwn(payloadByType, base.data.type)) return quarantine(`unknown type "${base.data.type}"`);
  const full = EnvelopeSchema.safeParse(raw);
  return full.success ? { ok: true, value: full.data } : quarantine(issuesText(full.error));
}
