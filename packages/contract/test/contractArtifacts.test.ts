import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { CONTRACT_VERSION, SUPPORTED_MAJORS, classifyEnvelope, eventTypeMeta, payloadByType } from "../src/index.js";
import { contractJsonSchema, contractJsonSchemaText, contractTypes, contractTypesText, toJsonSchema } from "../src/schema.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parts = (v: string) => v.split(".").map(Number) as [number, number, number];
const atMost = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] <= y[2];
};

const generated = (name: string) => readFileSync(new URL(`../generated/${name}`, import.meta.url), "utf8");

describe("contract version", () => {
  it("is semver and its major is an envelope major the collector reads", () => {
    expect(CONTRACT_VERSION).toMatch(SEMVER);
    expect(SUPPORTED_MAJORS).toContain(parts(CONTRACT_VERSION)[0]);
  });

  it("quarantines every envelope major it does not list", () => {
    const env = { instanceId: "i", id: "e1", seq: 1, ts: 1, type: "log", payload: { level: "INFO", logger: "x", message: "m" } };
    for (const v of SUPPORTED_MAJORS) expect(classifyEnvelope({ ...env, v }).ok).toBe(true);
    const unsupported = Math.max(...SUPPORTED_MAJORS) + 1;
    expect(classifyEnvelope({ ...env, v: unsupported })).toMatchObject({ ok: false, quarantined: { reason: `unsupported major version ${unsupported}` } });
  });
});

describe("event type metadata", () => {
  it("has an entry for every contract type and none for a type the contract does not have", () => {
    expect(Object.keys(eventTypeMeta).sort()).toEqual(Object.keys(payloadByType).sort());
  });

  it("dates every type at or before the current contract version", () => {
    for (const [type, meta] of Object.entries(eventTypeMeta)) {
      expect(meta.since, type).toMatch(SEMVER);
      expect(atMost(meta.since, CONTRACT_VERSION), `${type} since ${meta.since}`).toBe(true);
      if (meta.deprecated !== undefined) expect(meta.deprecated.length, type).toBeGreaterThan(0);
    }
  });
});

describe("generated contract artifacts", () => {
  it("are current: run `pnpm contract:generate` after changing the contract", () => {
    expect(generated("insights-contract.schema.json")).toBe(contractJsonSchemaText());
    expect(generated("insights-contract-types.txt")).toBe(contractTypesText());
  });

  it("list every type once, sorted, after # header lines, as qkt's pinned copy reads them", () => {
    const lines = contractTypesText().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const header = lines.filter((l) => l.startsWith("#"));
    const types = lines.filter((l) => !l.startsWith("#"));
    expect(lines.slice(0, header.length)).toEqual(header);
    expect(header.join(" ")).toContain(`contract ${CONTRACT_VERSION}`);
    expect(types).toEqual([...Object.keys(payloadByType)].sort());
    expect(new Set(types).size).toBe(types.length);
  });

  it("describe every type's envelope and payload with its since", () => {
    const schema = contractJsonSchema();
    const defs = schema.$defs as Record<string, { required?: string[]; "x-since"?: string }>;
    expect(schema["x-contract-version"]).toBe(CONTRACT_VERSION);
    expect(schema["x-envelope-majors"]).toEqual([...SUPPORTED_MAJORS]);
    expect((schema.oneOf as unknown[]).length).toBe(contractTypes().length);
    for (const type of contractTypes()) {
      expect(defs[type]?.["x-since"], type).toBe(eventTypeMeta[type].since);
      const required = Object.entries((payloadByType[type] as z.AnyZodObject).shape as z.ZodRawShape)
        .filter(([, f]) => !f.isOptional()).map(([k]) => k);
      expect(defs[type]?.required ?? [], type).toEqual(required);
    }
  });

  it("refuses a zod construct it cannot describe instead of dropping it", () => {
    expect(() => toJsonSchema(z.string().email())).toThrow(/string check "email"/);
    expect(() => toJsonSchema(z.date())).toThrow(/ZodDate/);
  });

  it("maps nullable, optional, integer bounds and enums", () => {
    expect(toJsonSchema(z.object({ a: z.number().int().nonnegative(), b: z.string().nullable().optional(), c: z.enum(["BUY", "SELL"]) }))).toEqual({
      type: "object",
      properties: {
        a: { type: "integer", minimum: 0 },
        b: { anyOf: [{ type: "string" }, { type: "null" }] },
        c: { type: "string", enum: ["BUY", "SELL"] },
      },
      required: ["a", "c"],
    });
  });
});
