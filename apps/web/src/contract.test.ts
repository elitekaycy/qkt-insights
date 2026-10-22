import { describe, expect, it } from "vitest";
import { contractLabel, contractTitle } from "./contract";

describe("contract display", () => {
  it("names the contract version and the envelope majors /ingest reads", () => {
    expect(contractLabel({ contractVersion: "1.0.0", majors: [1] })).toBe("contract 1.0.0 · envelope v1");
    expect(contractLabel({ contractVersion: "2.1.0", majors: [1, 2] })).toBe("contract 2.1.0 · envelope v1, v2");
  });

  it("says what happens to an envelope outside the contract", () => {
    expect(contractTitle({ contractVersion: "1.0.0", majors: [1] })).toBe(
      "The collector reads contract 1.0.0. An envelope of another major or of a type this contract does not list is kept raw as quarantined and counted per instance.",
    );
  });
});
