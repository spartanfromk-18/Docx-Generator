import { useEffect, useRef, useState, useCallback } from "react";
import { sseUrl } from "../lib/api.js";

/**
 * SSE hook for GET /v1/runs/:id/events.
 * - EventSource with native Last-Event-ID tracking (browser sends it on reconnect)
 * - manual reconnect with backoff + banner signal via onReconnect
 * - elapsed timer, live stage/section state, pause toggle
 */
export function useRunStream(runId, { enabled = true, onEvent } = {}) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const sourceRef = useRef(null);
  const retryRef = useRef(0);
  const pausedRef = useRef(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  pausedRef.current = paused;

  const push = useCallback((ev) => {
    setEvents((prev) => [...prev.slice(-499), ev]);
    if (!pausedRef.current) onEventRef.current?.(ev);
  }, []);

  useEffect(() => {
    if (!runId || !enabled) return undefined;
    let disposed = false;
    let reconnectTimer = null;
    let startedAt = Date.now();
    const start = Math.floor(Date.now() / 1000);

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(sseUrl(`/v1/runs/${runId}/events`));
      sourceRef.current = es;

      es.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        retryRef.current = 0;
      };

      const handle = (event) => {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          data = { raw: event.data };
        }
        push({
          id: event.lastEventId ? Number(event.lastEventId) : undefined,
          type: event.type || "message",
          data,
          ts: Date.now(),
          start,
        });
      };
      ["stage", "section", "run", "error", "done", "message"].forEach((type) => es.addEventListener(type, handle));
      es.addEventListener("elapsed", (e) => {
        const secs = Number(e.data);
        if (Number.isFinite(secs)) setElapsedMs((Date.now() - startedAt) || secs * 1000);
      });
      es.onmessage = handle;

      es.onerror = () => {
        setConnected(false);
        if (disposed) return;
        // The server closes cleanly on terminal states; only reconnect on errors.
        setReconnecting(true);
        retryRef.current += 1;
        const delay = Math.min(10_000, 800 * 2 ** Math.min(3, retryRef.current));
        es.close();
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    const tick = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);

    return () => {
      disposed = true;
      clearInterval(tick);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sourceRef.current?.close();
      setConnected(false);
      setReconnecting(false);
    };
  }, [runId, enabled, push]);

  return { connected, reconnecting, events, paused, setPaused, elapsedMs, clearEvents: () => setEvents([]) };
}
