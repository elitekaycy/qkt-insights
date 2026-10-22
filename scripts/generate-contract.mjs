// Writes the contract artifacts under packages/contract/generated from the built contract package:
// the JSON Schema of every envelope type and the type list qkt pins in its build. Run `pnpm contract:generate`.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractJsonSchemaText, contractTypesText } from "@qkt-insights/contract/schema";

const out = fileURLToPath(new URL("../packages/contract/generated/", import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}insights-contract.schema.json`, contractJsonSchemaText());
writeFileSync(`${out}insights-contract-types.txt`, contractTypesText());
console.log(`wrote ${out}insights-contract.schema.json and insights-contract-types.txt`);
