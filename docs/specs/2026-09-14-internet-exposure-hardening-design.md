# Internet exposure hardening

The dashboard is reached from anywhere over its public HTTPS hostname, so the
collector must be safe to face the internet on its own: a reverse proxy supplies
TLS, and everything else is enforced by the application.

## Threats this addresses

| Threat | Before | After |
|---|---|---|
| Stolen or forged session | Cookie was `HMAC("admin")`: identical for every login, never expired, survived logout, and `SESSION_SECRET` fell back to `INGEST_TOKEN` (anyone holding the ingest token could mint an admin cookie) | Random 256-bit session ids, stored hashed, absolute and idle expiry, revoked on logout, "sign out everywhere" |
| Password guessing | Unlimited attempts | Per-IP lockout plus a global failure budget |
| Login used as a CPU/memory DoS | Every attempt ran argon2 unbounded | At most two argon2 verifications in flight; the rest are refused before hashing |
| Password alone | Only factor | Optional TOTP second factor (`ADMIN_TOTP_SECRET`) |
| Request floods | Unlimited | Per-IP request budget, 429 with `Retry-After` |
| Cookie over plain HTTP | `secure: false` always | `Secure` whenever the request arrived over HTTPS |
| Clickjacking, XSS blast radius, sniffing | No headers | CSP, `frame-ancestors 'none'`, nosniff, no-referrer, COOP/CORP, HSTS on HTTPS |
| Private data cached by an intermediary | API JSON cacheable | `cache-control: no-store` on every API response |
| Cross-site WebSocket hijack | Cookie check only | Origin must match Host; session re-checked every minute; per-IP socket cap |
| Ingest token timing / guessing | String compare, unlimited | Constant-time compare, per-IP failure budget |
| Internal errors leaking SQL or paths | Fastify echoes 5xx messages | 5xx bodies are a generic message; detail goes to the log only |
| Wrong client IP behind a proxy | `req.ip` was the proxy | `TRUST_PROXY` (default `loopback,172.16.0.0/12`) so limits key on the real client |
| Silent account takeover | No signal | Log line for every login outcome; Telegram/webhook alert on sign-in and on lockout |
| Weak secrets | Accepted | Boot refuses `ADMIN_PASSWORD` under 12 or `INGEST_TOKEN` under 24 characters |

## Out of scope for the application

- Volumetric DDoS. Only an edge network absorbs it; put Cloudflare (proxied DNS)
  in front of the hostname and firewall the origin to Cloudflare's ranges.
- Publishing ports. The container port binds to `127.0.0.1`; only the proxy is
  public. The proxy refuses `POST /ingest` because qkt reaches the collector over
  the Docker network, never the public hostname.

See `docs/operations/internet-exposure.md` for the deployment checklist.

## Sessions

`sessions(id_hash, created_at, last_seen, expires_at, ip, user_agent)`. The cookie
holds the raw token; only its SHA-256 is stored, so a leaked database cannot be
replayed. Absolute lifetime 14 days, idle lifetime 3 days, `last_seen` written at
most once a minute. Expired rows are pruned on login. Existing HMAC cookies stop
working on upgrade; the operator signs in once.

## Login throttling

- Per IP: 5 failures in 15 minutes locks that IP for 15 minutes.
- Global: 50 failures in 15 minutes locks login for 15 minutes for every IP that
  holds no live session. This caps a distributed guessing run at about 200 guesses
  an hour. The exemption exists because anyone can spend the global budget: without
  it a stranger could keep the operator out indefinitely. An operator whose address
  changed and who has no live session is still locked until the window passes; the
  lockout alert says so.
- A locked request is refused with 429 before argon2 runs.
- TOTP codes: 30-second step, one step of drift, a code is accepted once. The secret
  must decode to at least 16 bytes.

## Request budget

600 requests a minute per client IP for everything except `POST /ingest` (which
has its own failure budget). A dashboard page load is about 40 requests.
WebSocket: 20 open sockets per IP.
