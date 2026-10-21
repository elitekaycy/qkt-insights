import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // the subpath first: the bare package name would otherwise match it as a prefix
      "@qkt-insights/contract/query": fileURLToPath(new URL("packages/contract/src/query.ts", import.meta.url)),
      "@qkt-insights/contract/prices": fileURLToPath(new URL("packages/contract/src/prices.ts", import.meta.url)),
      "@qkt-insights/contract/money": fileURLToPath(new URL("packages/contract/src/money.ts", import.meta.url)),
      "@qkt-insights/contract": pkg("contract"),
      "@qkt-insights/store": pkg("store"),
      "@qkt-insights/collector": pkg("collector"),
      "@qkt-insights/api": pkg("api"),
    },
  },
  test: { environment: "node", include: ["**/*.test.ts"], exclude: ["**/node_modules/**", "**/dist/**"] },
});
