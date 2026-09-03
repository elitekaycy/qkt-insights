import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const api = "http://localhost:8420";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "favicon.ico", "apple-touch-icon.png"],
      manifest: {
        name: "qkt-insights",
        short_name: "qkt-insights",
        description: "Real-time view into qkt strategies, fills, equity, and risk state.",
        // chrome matches the top bar; the splash behind it is the page ground
        theme_color: "#121518",
        background_color: "#0a0c0e",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Live trading data — never let the service worker serve a stale API response.
        navigateFallbackDenylist: [/^\/(auth|instances|strategies|orders|trades|search|equity|health|live)(\/|$)/],
      },
    }),
  ],
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
