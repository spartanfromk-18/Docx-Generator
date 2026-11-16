import type { SSEEvent } from "../types.js";

/**
 * SSE hub with per-run ring buffers (TRD T4/D4): events are replayed for
 * Last-Event-ID resume. Production fans out through Valkey Streams; this
 * in-process hub is the local adapter with the same interface.
 */

const MAX_EVENTS_PER_RUN = 2000;
const RETAIN_AFTER_CLOSE_MS = 10 * 60 * 1000;

type Subscriber = (event: SSEEvent) => void;

interface RunStream {
  events: SSEEvent[];
  subs: Set<Subscriber>;
  closedAt: number | null;
}

export class EventHub {
  private streams = new Map<string, RunStream>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private seq = new Map<string, number>();

  startHeartbeat(intervalMs = 15_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [runId, stream] of this.streams) {
        if (stream.subs.size > 0) this.deliver(runId, "heartbeat", {});
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  publish(runId: string, event: string, data: unknown): SSEEvent {
    const nextId = (this.seq.get(runId) ?? 0) + 1;
    this.seq.set(runId, nextId);
    const evt: SSEEvent = { id: nextId, event, data, ts: Date.now() };
    this.deliver(runId, event, data, evt);
    return evt;
  }

  private deliver(runId: string, eventName: string, data: unknown, evt?: SSEEvent): void {
    const stream = this.streams.get(runId) ?? { events: [], subs: new Set(), closedAt: null };
    this.streams.set(runId, stream);
    const payload: SSEEvent = evt ?? { id: stream.events.at(-1)?.id ?? 0, event: eventName, data, ts: Date.now() };
    // Ring buffer
    if (eventName !== "heartbeat") {
      stream.events.push(payload);
      if (stream.events.length > MAX_EVENTS_PER_RUN) stream.events.splice(0, stream.events.length - MAX_EVENTS_PER_RUN);
    }
    for (const sub of stream.subs) {
      try {
        sub(payload);
      } catch {
        stream.subs.delete(sub);
      }
    }
  }

  /** Subscribe with replay of events after lastEventId (SSE resume). */
  subscribe(runId: string, lastEventId: number | null, onEvent: Subscriber): () => void {
    const stream = this.streams.get(runId) ?? { events: [], subs: new Set(), closedAt: null };
    this.streams.set(runId, stream);
    if (lastEventId !== null) {
      for (const evt of stream.events) {
        if (evt.id > lastEventId) onEvent(evt);
      }
    }
    stream.subs.add(onEvent);
    stream.closedAt = null;
    return () => {
      stream.subs.delete(onEvent);
      if (stream.subs.size === 0) {
        stream.closedAt = Date.now();
      }
    };
  }

  stats(): { streams: number; subscribers: number; bufferedEvents: number } {
    let subs = 0;
    let buffered = 0;
    for (const s of this.streams.values()) {
      subs += s.subs.size;
      buffered += s.events.length;
    }
    return { streams: this.streams.size, subscribers: subs, bufferedEvents: buffered };
  }

  /** Housekeeping: drop terminal-run buffers after the reconnect window. */
  gc(): void {
    const now = Date.now();
    for (const [runId, stream] of this.streams) {
      if (stream.subs.size === 0 && stream.closedAt && now - stream.closedAt > RETAIN_AFTER_CLOSE_MS) {
        this.streams.delete(runId);
        this.seq.delete(runId);
      }
    }
  }
}
