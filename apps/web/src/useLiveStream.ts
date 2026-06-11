import { useEffect, useRef, useState } from "react";

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
 * delay if the socket drops.
 */
export function useLiveStream(instanceId: string | null, cap = 500): LiveEnvelope[] {
  const [events, setEvents] = useState<LiveEnvelope[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setEvents([]);
    if (!instanceId) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/live?instance=${encodeURIComponent(instanceId)}`);
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
  }, [instanceId, cap]);

  return events;
}
