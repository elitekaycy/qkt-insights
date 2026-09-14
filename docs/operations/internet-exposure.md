# Exposing the dashboard to the internet

The collector is built to be reached from anywhere over HTTPS. The application enforces
sessions, sign-in throttling, an optional second factor, a per-IP request budget and
strict browser headers (see `docs/specs/2026-09-14-internet-exposure-hardening-design.md`).
The deployment has to supply the rest.

## Checklist

1. **Never publish the container port on a public interface.** Bind it to loopback
   (`127.0.0.1:8420:8420`) or leave it unpublished and let a proxy container reach it
   over the Docker network. Verify from outside the host:

   ```bash
   curl -m 5 http://<public-ip>:8420/healthz   # must time out or be refused
   ```

2. **Terminate TLS at a reverse proxy** and give the dashboard a hostname.
3. **Refuse `POST /ingest` on the public hostname.** qkt posts to
   `http://qkt-insights:8420/ingest` over the Docker network; nothing on the internet
   needs that path. Block only the exact path: the dashboard reads
   `/ingest/observations`.
4. **Turn on two-factor sign-in** (below).
5. **Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`** so every new sign-in and every
   lockout reaches your phone. An unexpected sign-in alert means rotate the password,
   then use **Sign out everywhere**.
6. **Recommended: proxy the hostname through Cloudflare** (orange-cloud DNS). It hides
   the host's address and absorbs floods the application cannot. Then allow ports 80
   and 443 only from Cloudflare's ranges. Leave `TRUST_PROXY` alone: the collector
   still talks only to your proxy. Instead, configure the proxy itself to trust
   Cloudflare's ranges and pass the visitor's address on. In Caddy that is the
   `trusted_proxies` server option with Cloudflare's IP list; in Traefik it is
   `forwardedHeaders.trustedIPs` on the entry point. Without that step every visitor
   looks like a Cloudflare address, so five bad sign-ins would lock everyone and the
   request budget would be shared by all visitors.

## Proxy examples

Caddy on the host:

```caddyfile
insights.example.com {
	@ingest path /ingest
	respond @ingest 404
	reverse_proxy 127.0.0.1:8420
}
```

Traefik file provider, proxy container on the collector's Docker network:

```yaml
http:
  routers:
    insights:
      rule: Host(`insights.example.com`) && !Path(`/ingest`)
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: insights
  services:
    insights:
      loadBalancer:
        servers: [{ url: "http://qkt-insights:8420" }]
```

Both send `X-Forwarded-For` and `X-Forwarded-Proto`. The default `TRUST_PROXY`
(`loopback,172.16.0.0/12`) covers both shapes. A host proxy reaches a published port
through the Docker bridge gateway, for example `172.19.0.1`. A proxy container sits on
the bridge network itself. Tailscale, LAN and public addresses are not trusted to set
forwarding headers. Every container on a Docker bridge network is trusted, so do not
attach untrusted containers to the collector's network. If your Docker networks use
another range, set `TRUST_PROXY` to it.

## Two-factor sign-in

```bash
docker compose run --rm --no-deps qkt-insights totp-setup <dashboard-name>
```

It prints `ADMIN_TOTP_SECRET=...` and an `otpauth://` URI. Add the URI to an
authenticator app first, then put the secret in the collector's environment and
recreate only the collector:

```bash
docker compose up -d --no-deps qkt-insights
```

The login page then asks for the six-digit code. The secret must decode to at least 16
bytes; `totp-setup` generates 20. Keep the secret with the admin
password: losing both the phone and the secret means removing `ADMIN_TOTP_SECRET` to
get back in.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `INGEST_TOKEN` | required, 24+ chars | Bearer token qkt sends to `/ingest` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | required, password 12+ chars | Dashboard sign-in |
| `ADMIN_TOTP_SECRET` | unset | Base32 secret; when set, sign-in needs an authenticator code |
| `TRUST_PROXY` | `loopback,172.16.0.0/12` | Peers allowed to set forwarding headers; `false` trusts none |

`SESSION_SECRET` is no longer read. Sessions are random tokens stored hashed in the
database, valid for 14 days and ended after 3 idle days. Upgrading signs every device
out once.

## Behaviour under attack

| Situation | Response |
|---|---|
| 5 failed sign-ins from one IP in 15 minutes | That IP gets 429 for 15 minutes, one alert |
| 50 failed sign-ins overall in 15 minutes | Sign-in paused for 15 minutes for every IP that holds no live session, one alert |
| More than 2 password checks at once | Extra attempts get 429 before any hashing |
| More than 600 requests a minute from one IP | 429 with `Retry-After` |
| 20 bad ingest tokens a minute from one IP | That IP gets 429 on ingest |
| More than 20 live sockets from one IP | New sockets closed with code 1013 |
| Cross-site sign-in or socket attempt | 403, or socket closed with code 1008 |
| Server error | Body says `internal error`; detail only in the log |
