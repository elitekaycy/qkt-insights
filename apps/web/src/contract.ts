import type { ContractInfo } from "./api";

/** "contract 1.0.0 · envelope v1": the contract the collector's /ingest reads. */
export function contractLabel(c: ContractInfo): string {
  return `contract ${c.contractVersion} · envelope ${c.majors.map((m) => `v${m}`).join(", ")}`;
}

/** Why the version matters on Health: what does not fit it is quarantined, not lost. */
export function contractTitle(c: ContractInfo): string {
  return `The collector reads contract ${c.contractVersion}. An envelope of another major or of a type this contract does not list is kept raw as quarantined and counted per instance.`;
}
