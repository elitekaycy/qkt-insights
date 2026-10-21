// Makes the built store's migrations exactly the source's: copies every .sql file and removes any
// .sql file the source no longer has, so a renamed or dropped migration never runs from dist.
// Usage: node scripts/copy-migrations.mjs [from] [to]
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [from = "packages/store/src/migrations", to = "packages/store/dist/migrations"] = process.argv.slice(2);
const sources = readdirSync(from).filter((f) => f.endsWith(".sql"));
mkdirSync(to, { recursive: true });
for (const f of readdirSync(to)) if (f.endsWith(".sql") && !sources.includes(f)) rmSync(join(to, f));
for (const f of sources) copyFileSync(join(from, f), join(to, f));
