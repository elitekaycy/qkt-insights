# Install on your phone

The dashboard is a PWA. Open it in a mobile browser and use **Install app** — on the
login screen, or at the bottom of the sidebar once you're in. Chrome and Edge show the
native install prompt; iOS Safari has no such prompt, so the button explains the
**Share → Add to Home Screen** route instead. Installed, it launches standalone with no
browser chrome, its own icon, and the notch/home-indicator insets respected.

> **It must be served over HTTPS.** Browsers only expose service workers and
> installability on a secure origin (`https://`, or `localhost` for development). Over
> plain `http://` to a LAN or Tailscale address the dashboard still works, but
> `navigator.serviceWorker` is absent and no install option appears. If you reach your
> instance over Tailscale, `tailscale serve https / http://localhost:8420` gives it a
> real certificate on your tailnet — that URL is installable.

Live trading figures are never cached: the service worker precaches the app shell only,
so a screen you open is always talking to the collector, never replaying a stale number.

**Running several dashboards?** Set `INSIGHTS_NAME` on each (`-e INSIGHTS_NAME=hypergrowth`).
It becomes the home-screen label and app name for that install, the browser-tab title,
and a tag on the login card and sidebar — so three installed dashboards are not three
identical `qkt-insights` icons. Keep it short; home screens truncate past ~12 characters.
