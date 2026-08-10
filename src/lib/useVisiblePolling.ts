"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `callback` on an interval, but only while the tab is actually visible.
 *
 * Panels are typically left open in a background tab all day. Polling through
 * that idle time is pure waste — it burns database egress without anyone
 * looking at the screen. Pausing on `visibilitychange` cuts the vast majority
 * of requests, and we fire once immediately on re-focus so the operator sees
 * fresh data the moment they come back.
 */
export function useVisiblePolling(callback: () => void, intervalMs: number) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => savedCallback.current(), intervalMs);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        savedCallback.current(); // catch up right away
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
}
