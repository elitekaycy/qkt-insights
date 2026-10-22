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
        navigateFallbackDenylist: [/^\/(auth|brand|instances|strategies|orders|trades|round-trips|search|equity|health|live|logs|public)(\/|$)/],
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
    // the charts chunk (ECharts core + the six chart types used) is ~630 kB raw, ~210 kB gzip,
    // and loads only with a chart page; the shell and vendor chunks stay far below this
    chunkSizeWarningLimit: 700,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/@tanstack")) return "vendor";
          // every chart page shares one charts chunk instead of each carrying a copy
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "charts";
        },
      },
    },
  },
  server: {
    proxy: {
      // Every API path goes to the collector, so a new endpoint never needs a line here. Vite's own
      // modules and the public files stay local, and a page load (an HTML request) gets the app.
      // Host passes through unchanged so the collector's same-origin check sees what production sees.
      "^/(?!@|src/|node_modules/|apple-touch-icon|favicon|manifest\\.webmanifest|pwa-|theme-boot\\.js).*": {
        target: api,
        changeOrigin: false,
        bypass: (req) => (req.headers.accept?.includes("text/html") ? "/index.html" : undefined),
      },
      // the live stream's websocket; Vite's own hot-reload socket on "/" must stay local
      "/live": { target: api, changeOrigin: false, ws: true },
    },
  },
});
