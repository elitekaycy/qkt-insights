import { useEffect, useRef, useState } from "react";
import { useView } from "./view";

export interface LiveEnvelope {
  v: 1;
  instanceId: string;
  id: string;
  seq: number;
  ts: number;
  strategyId?: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Subscribes to the collector's WS /live feed for one instance and keeps the
 * most recent events in memory (newest first, capped). Reconnects with a short
 * delay if the socket drops. `types` narrows the subscription server-side
 * (e.g. ["log"] for the logs page), so unrelated envelopes never hit the wire.
 */
export function useLiveStream(instanceId: string | null, cap = 500, types?: string[]): LiveEnvelope[] {
  const view = useView();
  // Shared links poll delayed data; a live push would undo the delay.
  const target = view.public ? null : instanceId;
  const [events, setEvents] = useState<LiveEnvelope[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  // Joined once so an inline array literal does not re-open the socket every render.
  const typesKey = types?.join(",");

  useEffect(() => {
    setEvents([]);
    if (!target) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${location.host}/live?instance=${encodeURIComponent(target)}${typesKey ? `&types=${encodeURIComponent(typesKey)}` : ""}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        const env = JSON.parse(String(ev.data)) as LiveEnvelope;
        setEvents((prev) => [env, ...prev].slice(0, cap));
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [target, cap, typesKey]);

  return events;
}
