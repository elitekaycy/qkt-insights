import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { LiveBus } from "@qkt-insights/store";
import { registerLive } from "../src/live.js";
import type { Envelope } from "@qkt-insights/contract";
import { once } from "node:events";
import { WebSocket } from "ws";

let app: FastifyInstance; let bus: LiveBus; let url: string;
beforeEach(async () => {
  bus = new LiveBus();
  app = Fastify();
  await app.register(websocket);
  registerLive(app, { bus });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  url = `ws://127.0.0.1:${port}/live`;
});
afterEach(async () => { await app.close(); });

describe("WS /live", () => {
  it("streams matching events to a subscribed client", async () => {
    const ws = new WebSocket(`${url}?instance=qkt-prod`);
    await once(ws, "open");
    const msg = once(ws, "message");
    const e = { v: 1, instanceId: "qkt-prod", id: "1", seq: 1, ts: 1, type: "trade",
      payload: { orderId: "o", symbol: "X", side: "BUY", price: 1, qty: 1, ts: 1 } } as Envelope;
    bus.publish(e);
    const [data] = await msg;
    expect(JSON.parse(String(data))).toMatchObject({ id: "1", type: "trade" });
    ws.close();
  });

  it("filters out events from other instances", async () => {
    const ws = new WebSocket(`${url}?instance=qkt-prod`);
    await once(ws, "open");
    let received = 0;
    ws.on("message", () => { received++; });
    bus.publish({ v: 1, instanceId: "other", id: "2", seq: 1, ts: 1, type: "trade",
      payload: { orderId: "o", symbol: "X", side: "BUY", price: 1, qty: 1, ts: 1 } } as Envelope);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(0);
    ws.close();
  });
});

describe("WS /live hardening", () => {
  async function server(deps: Partial<Parameters<typeof registerLive>[1]>) {
    const a = Fastify();
    await a.register(websocket);
    registerLive(a, { bus: new LiveBus(), ...deps });
    await a.listen({ port: 0, host: "127.0.0.1" });
    const addr = a.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { a, url: `ws://127.0.0.1:${port}/live` };
  }

  function closeCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  it("closes a socket whose Origin is another site", async () => {
    const { a, url: u } = await server({});
    const ws = new WebSocket(u, { headers: { origin: "https://evil.example" } });
    expect(await closeCode(ws)).toBe(1008);
    await a.close();
  });

  it("closes an unauthenticated socket", async () => {
    const { a, url: u } = await server({ authenticate: () => false });
    expect(await closeCode(new WebSocket(u))).toBe(1008);
    await a.close();
  });

  it("caps open sockets per IP", async () => {
    const { a, url: u } = await server({ maxSocketsPerIp: 2 });
    const first = new WebSocket(u);
    const second = new WebSocket(u);
    await Promise.all([once(first, "open"), once(second, "open")]);
    expect(await closeCode(new WebSocket(u))).toBe(1013);
    first.close();
    second.close();
    await a.close();
  });

  it("closes a socket once its session stops validating", async () => {
    let valid = true;
    const { a, url: u } = await server({ authenticate: () => valid, revalidateMs: 50 });
    const ws = new WebSocket(u);
    await once(ws, "open");
    valid = false;
    expect(await closeCode(ws)).toBe(1008);
    await a.close();
  });
});
