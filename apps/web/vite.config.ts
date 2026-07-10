import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = "http://localhost:8420";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/@tanstack")) return "vendor";
        },
      },
    },
  },
  server: {
    proxy: {
      "/auth": api,
      "/instances": api,
      "/strategies": api,
      "/orders": api,
      "/trades": api,
      "/search": api,
      "/equity": api,
      "/health": api,
      "/live": { target: api, ws: true },
    },
  },
});
