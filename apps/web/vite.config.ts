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
      includeAssets: ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "pwa-192.png", "pwa-512.png"],
      // The manifest is a static file in public/ and linked from index.html rather
      // than generated here: the plugin would precache anything it generates, and
      // the server rewrites the manifest per deployment (INSIGHTS_NAME) — a
      // precached copy would pin every install to the build-time name.
      manifest: false,
      workbox: {
        // Live trading data — never let the service worker serve a stale API response.
        navigateFallbackDenylist: [/^\/(auth|brand|instances|strategies|orders|trades|search|equity|health|live)(\/|$)/],
        // Fonts are the one third-party fetch on every cold start; keep them so the
        // shell (and the offline splash) renders in the real typeface without a trip.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-css", expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: "CacheFirst",
            options: { cacheName: "google-fonts-files", expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
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
