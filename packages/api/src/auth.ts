import "@fastify/cookie";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export interface AuthDeps { passwordHash: string; sessionSecret: string }

const COOKIE = "qkt_insights_session";

function sign(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${mac}`;
}

function verify(signed: string | undefined, secret: string): boolean {
  if (!signed) return false;
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return false;
  const value = signed.slice(0, dot);
  const expected = createHmac("sha256", secret).update(value).digest("hex");
  const got = Buffer.from(signed.slice(dot + 1), "hex");
  const exp = Buffer.from(expected, "hex");
  return got.length === exp.length && timingSafeEqual(got, exp) && value === "admin";
}

let activeSecret = "";

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  activeSecret = deps.sessionSecret;
  app.post<{ Body: { password?: string } }>("/auth/login", async (req, reply) => {
    const password = req.body?.password ?? "";
    const ok = await argon2.verify(deps.passwordHash, password).catch(() => false);
    if (!ok) return reply.code(401).send({ error: "invalid credentials" });
    const token = sign("admin", deps.sessionSecret);
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/", secure: false });
    return reply.send({ ok: true });
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[COOKIE];
  if (!verify(token, activeSecret)) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}
