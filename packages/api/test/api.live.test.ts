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
