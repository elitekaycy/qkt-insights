import { z } from "zod";
import { EnvelopeBaseSchema, SUPPORTED_MAJORS } from "./envelope.js";
import { CONTRACT_VERSION, eventTypeMeta, payloadByType, type EventType } from "./payloads.js";

/** A JSON Schema (draft 2020-12) node. */
export type JsonSchema = { [key: string]: unknown };

/** Every contract type name, sorted the way the generated artifacts list them. */
export function contractTypes(): EventType[] {
  return (Object.keys(payloadByType) as EventType[]).sort();
}

function numberSchema(def: z.ZodNumberDef): JsonSchema {
  const out: JsonSchema = { type: def.checks.some((c) => c.kind === "int") ? "integer" : "number" };
  for (const c of def.checks) {
    if (c.kind === "min") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
    if (c.kind === "max") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
  }
  return out;
}

function stringSchema(def: z.ZodStringDef): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const c of def.checks) {
    if (c.kind === "min") out.minLength = c.value;
    else if (c.kind === "max") out.maxLength = c.value;
    else throw new Error(`no JSON Schema for string check "${c.kind}"`);
  }
  return out;
}

/**
 * JSON Schema for the zod constructs the contract uses. An unknown construct throws, so a schema the
 * generator cannot describe fails `pnpm contract:generate` and its staleness test instead of being dropped.
 */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind };
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return stringSchema(schema._def as z.ZodStringDef);
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return numberSchema(schema._def as z.ZodNumberDef);
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return {};
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: (schema as z.ZodLiteral<unknown>).value };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] };
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: toJsonSchema((schema as z.ZodArray<z.ZodTypeAny>).element) };
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { type: "object", additionalProperties: toJsonSchema((schema as z.ZodRecord).valueSchema) };
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return { anyOf: [toJsonSchema((schema as z.ZodNullable<z.ZodTypeAny>).unwrap()), { type: "null" }] };
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return toJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const object = schema as z.AnyZodObject;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(object.shape as z.ZodRawShape)) {
        properties[key] = toJsonSchema(field);
        if (!field.isOptional()) required.push(key);
      }
      // passthrough and strip both accept unknown keys on the wire; only strict refuses them.
      return {
        type: "object", properties, ...(required.length > 0 ? { required } : {}),
        ...(object._def.unknownKeys === "strict" ? { additionalProperties: false } : {}),
      };
    }
    default:
      throw new Error(`no JSON Schema for zod ${def.typeName}`);
  }
}

/** The `$defs` key of the fields every envelope carries; no contract type may take it. */
const ENVELOPE_DEF = "envelope";

/** The shared envelope fields with `v` limited to the majors the collector reads. */
function envelopeBase(): JsonSchema {
  const base = toJsonSchema(EnvelopeBaseSchema);
  return { ...base, properties: { ...(base.properties as Record<string, JsonSchema>), v: { type: "integer", enum: [...SUPPORTED_MAJORS] } } };
}

/** One type's envelope: the shared fields, `type` fixed to the name and the type's payload required. */
function envelopeOf(type: EventType): JsonSchema {
  return {
    allOf: [{ $ref: `#/$defs/${ENVELOPE_DEF}` }],
    properties: { type: { const: type }, payload: { $ref: `#/$defs/${type}` } },
    required: ["payload"],
  };
}

/**
 * The wire contract as one JSON Schema document: `oneOf` the envelope of every type, the shared envelope fields
 * and each type's payload under `$defs`, with `x-since` (and `deprecated` plus `x-deprecated` when set) from
 * `eventTypeMeta`.
 */
export function contractJsonSchema(): JsonSchema {
  const types = contractTypes();
  const defs: Record<string, JsonSchema> = { [ENVELOPE_DEF]: envelopeBase() };
  for (const type of types) {
    if (Object.hasOwn(defs, type)) throw new Error(`contract type "${type}" collides with a $defs key`);
    const meta = eventTypeMeta[type];
    defs[type] = {
      ...toJsonSchema(payloadByType[type]),
      "x-since": meta.since,
      ...(meta.deprecated ? { deprecated: true, "x-deprecated": meta.deprecated } : {}),
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:qkt-insights:contract:${CONTRACT_VERSION}`,
    title: `qkt-insights envelope contract ${CONTRACT_VERSION}`,
    "x-contract-version": CONTRACT_VERSION,
    "x-envelope-majors": [...SUPPORTED_MAJORS],
    oneOf: types.map(envelopeOf),
    $defs: defs,
  };
}

/** `insights-contract-schema.json` as written to disk. */
export function contractJsonSchemaText(): string {
  return `${JSON.stringify(contractJsonSchema(), null, 2)}\n`;
}

/**
 * The type list in the format of qkt's pinned `src/test/resources/insights-contract-types.txt`: `#` header
 * lines, then one type per line, sorted.
 */
export function contractTypesText(): string {
  return [
    "# Envelope types the qkt-insights contract accepts: the keys of payloadByType in",
    `# qkt-insights packages/contract/src/payloads.ts (contract ${CONTRACT_VERSION}). Regenerate when the contract changes.`,
    ...contractTypes(),
    "",
  ].join("\n");
}
