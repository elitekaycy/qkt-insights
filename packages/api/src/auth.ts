import "@fastify/cookie";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import argon2 from "argon2";
import { SESSION_ABSOLUTE_MS, type Sessions } from "@qkt-insights/store";
import { Concurrency, LoginGuard } from "./limits.js";
import type { TotpVerifier } from "./totp.js";

export type AuthEventKind = "login" | "failure" | "lockout" | "logout-all";

export interface AuthEvent { kind: AuthEventKind; ip: string; userAgent?: string; lock?: "ip" | "global" }

export interface AuthDeps {
  username: string;
  passwordHash: string;
  sessions: Sessions;
  /** When set, a login also needs the current authenticator code. */
  totp?: TotpVerifier;
  guard?: LoginGuard;
  /** Every login outcome, for the audit log and alerts. Must not throw. */
  onEvent?: (e: AuthEvent) => void;
}

export const SESSION_COOKIE = "qkt_insights_session";

/** argon2 is deliberately expensive; bounding concurrent verifications keeps login from being a DoS lever. */
const MAX_CONCURRENT_VERIFICATIONS = 2;
const MAX_FIELD_LENGTH = 256;

const LoginBody = {
  type: "object",
  required: ["username", "password"],
  additionalProperties: false,
  properties: {
    username: { type: "string", maxLength: MAX_FIELD_LENGTH },
    password: { type: "string", maxLength: MAX_FIELD_LENGTH },
    code: { type: "string", maxLength: 16 },
  },
} as const;

let activeSessions: Sessions | null = null;

/**
 * A browser always sends Origin on a cross-site POST or WebSocket upgrade. Requests without
 * one come from non-browser clients, which cannot ride the operator's cookie.
 */
export function isSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function userAgent(req: FastifyRequest): string | undefined {
  return req.headers["user-agent"]?.slice(0, 256);
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  activeSessions = deps.sessions;
  const guard = deps.guard ?? new LoginGuard();
  const verifications = new Concurrency(MAX_CONCURRENT_VERIFICATIONS);
  const emit = (e: AuthEvent) => {
    try {
      deps.onEvent?.(e);
    } catch (err) {
      app.log.error({ err }, "auth event handler failed");
    }
  };
  const sweep = setInterval(() => guard.sweep(), 60_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  app.get("/auth/methods", async () => ({ totp: deps.totp != null }));

  app.post<{ Body: { username: string; password: string; code?: string } }>(
    "/auth/login",
    { bodyLimit: 4096, schema: { body: LoginBody } },
    async (req, reply) => {
      if (!isSameOrigin(req)) return reply.code(403).send({ error: "cross-origin request refused" });
      const lockedMs = guard.lockedFor(req.ip, Date.now(), { trusted: deps.sessions.hasLiveSessionFrom(req.ip) });
      if (lockedMs > 0) {
        return reply.code(429).header("retry-after", Math.ceil(lockedMs / 1000)).send({ error: "too many failed sign-ins, try later" });
      }
      if (!verifications.tryAcquire()) {
        return reply.code(429).header("retry-after", 2).send({ error: "busy, try again" });
      }
      let ok: boolean;
      try {
        // The password is verified even for a wrong username so both failures take the same time.
        const passwordOk = await argon2.verify(deps.passwordHash, req.body.password).catch(() => false);
        ok = passwordOk && req.body.username === deps.username && (deps.totp == null || deps.totp.verify(req.body.code));
      } finally {
        verifications.release();
      }
      if (!ok) {
        const lock = guard.recordFailure(req.ip);
        emit({ kind: "failure", ip: req.ip, userAgent: userAgent(req) });
        if (lock) emit({ kind: "lockout", ip: req.ip, userAgent: userAgent(req), lock });
        return reply.code(401).send({ error: "invalid credentials" });
      }
      guard.recordSuccess(req.ip);
      deps.sessions.prune();
      const token = deps.sessions.create({ ip: req.ip, userAgent: userAgent(req) });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: req.protocol === "https",
        maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
      });
      emit({ kind: "login", ip: req.ip, userAgent: userAgent(req) });
      return reply.send({ ok: true });
    },
  );

  app.post("/auth/logout", async (req, reply) => {
    if (!isSameOrigin(req)) return reply.code(403).send({ error: "cross-origin request refused" });
    deps.sessions.revoke(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.post("/auth/logout-all", { preHandler: requireSession }, async (req, reply) => {
    if (!isSameOrigin(req)) return reply.code(403).send({ error: "cross-origin request refused" });
    const ended = deps.sessions.revokeAll();
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    emit({ kind: "logout-all", ip: req.ip, userAgent: userAgent(req) });
    return reply.send({ ok: true, ended });
  });
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!hasSession(req)) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}

export function hasSession(req: { cookies?: Record<string, string | undefined> }): boolean {
  return activeSessions != null && activeSessions.validate(req.cookies?.[SESSION_COOKIE]);
}
