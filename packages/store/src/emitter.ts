import type { Envelope } from "@qkt-insights/contract";

export type LiveListener = (e: Envelope) => void;

export class LiveBus {
  private listeners = new Set<LiveListener>();
  subscribe(fn: LiveListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  publish(e: Envelope): void {
    for (const fn of this.listeners) fn(e);
  }
}
