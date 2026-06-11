import { z } from "zod";
import { payloadByType, type EventType } from "./payloads.js";

const envelopeBase = { v: z.literal(1), instanceId: z.string().min(1), id: z.string().min(1),
  seq: z.number().int().nonnegative(), ts: z.number().int(), strategyId: z.string().optional() };

const variants = (Object.entries(payloadByType) as [EventType, z.ZodTypeAny][]).map(([type, payload]) =>
  z.object({ ...envelopeBase, type: z.literal(type), payload }),
);

export const EnvelopeSchema = z.discriminatedUnion("type", variants as [typeof variants[number], ...typeof variants]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseEnvelope(input: unknown): { ok: true; value: Envelope } | { ok: false; error: string } {
  const r = EnvelopeSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
}

export const BatchSchema = z.object({ instanceId: z.string().min(1), events: z.array(EnvelopeSchema) });
export type Batch = z.infer<typeof BatchSchema>;
