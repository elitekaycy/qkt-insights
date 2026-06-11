import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@qkt-insights/contract": pkg("contract"),
      "@qkt-insights/store": pkg("store"),
      "@qkt-insights/collector": pkg("collector"),
      "@qkt-insights/api": pkg("api"),
    },
  },
  test: { environment: "node", include: ["**/*.test.ts"], exclude: ["**/node_modules/**", "**/dist/**"] },
});
