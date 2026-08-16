import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";

// Client half of the usage tracking. Records which view is open, how long it
// was actually looked at, and what was clicked in it.
//
// Two ideas do the work:
//   - Engaged time, not wall clock. A tab left open overnight is not eight
//     hours of research. Time only accrues while the document is visible, and
//     any single gap longer than IDLE_MS is dropped rather than credited.
//   - The total, not a delta, on every flush. A flush that never lands then
//     costs the time since the previous one instead of corrupting the count,
//     and the backend can take the max of what it has and what arrives.

const FLUSH_MS = 20_000;
// Longer than a read of one summary, shorter than a coffee.
const IDLE_MS = 60_000;
const MAX_QUEUE = 200;

type Pending = {
  type: string;
  ts: number;
  tab: string;
  target?: string;
  value?: number | string;
};

// Survives tab close; distinguishes this browser from another one of yours.
// Nothing about it identifies a person, and it never leaves the deployment.
function visitorId(): string {
  try {
    const key = "ow-visitor";
    const found = localStorage.getItem(key);
    if (found) return found;
    const made = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, made);
    return made;
  } catch {
    // Private mode with storage denied. A per-load id still gives correct
    // per-visit numbers and only loses "same browser as yesterday".
    return "anon";
  }
}

// sessionStorage, not a fresh id per mount: it survives a reload and dies with
// the browser tab, which is exactly the boundary a "session" means here. Held
// in a ref alone, every refresh started a new journey, so the moves between
// views were only ever visible inside one uninterrupted page load.
function tabSessionId(): string {
  const made = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    const key = "ow-session";
    const found = sessionStorage.getItem(key);
    if (found) return found;
    const id = made();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return made();
  }
}

function device(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  if (/Android/.test(ua)) return "android";
  if (/Macintosh/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

type Tracker = {
  track: (type: string, target?: string, value?: number | string) => void;
};

// Module-level so a component anywhere can report an action without the
// tracker being threaded through props. One page has one tracker.
let current: Tracker | null = null;

export function trackAction(target: string, value?: number | string) {
  current?.track("action", target, value);
}

/**
 * Mount once, in the shell. `tab` is the view currently open; changing it ends
 * the previous visit and starts a new one.
 */
export function useUsageTracker(tab: string) {
  const ingest = useMutation(api.usage.ingest);
  const sessionId = useRef<string>("");
  const queue = useRef<Pending[]>([]);
  const activeMs = useRef(0);
  const lastTick = useRef(Date.now());
  const tabRef = useRef(tab);

  if (!sessionId.current) sessionId.current = tabSessionId();

  // One ref holding the current flush, so the unmount and pagehide handlers
  // below do not need it in their dependency lists and therefore do not
  // re-register on every render.
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Before anything is recorded. The cleanup above this ran with the old
    // value still in place, so the previous visit's flush was attributed
    // correctly; from here on everything belongs to the new view, starting
    // with a fresh time budget so one view's minutes cannot roll into the
    // next one.
    tabRef.current = tab;
    activeMs.current = 0;
    lastTick.current = Date.now();

    const push = (type: string, target?: string, value?: number | string) => {
      if (queue.current.length >= MAX_QUEUE) return;
      queue.current.push({ type, ts: Date.now(), tab: tabRef.current, target, value });
    };
    current = { track: push };

    // Credit the time since the last tick, unless it looks like the machine
    // was asleep or the tab was in the background.
    const settle = () => {
      const now = Date.now();
      const gap = now - lastTick.current;
      lastTick.current = now;
      if (document.visibilityState === "visible" && gap > 0 && gap < IDLE_MS) activeMs.current += gap;
    };

    const flush = () => {
      settle();
      const events = queue.current;
      // A visit with no events and no time is not a visit.
      if (events.length === 0 && activeMs.current === 0) return;
      queue.current = [];
      const payload = {
        sessionId: sessionId.current,
        visitorId: visitorId(),
        tab: tabRef.current,
        activeMs: Math.round(activeMs.current),
        device: device(),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        host: window.location.host,
        events,
      };
      // Usage data is never worth surfacing an error over: a failed flush
      // loses a number, and the events it carried are already gone from the
      // queue so a retry cannot double-count them.
      void ingest(payload).catch(() => {});
    };
    flushRef.current = flush;

    push("pageview", tab);

    const onVisibility = () => {
      // Settle before the state flips so the time up to now is credited under
      // the state it was earned in, then flush what is held: a tab hidden and
      // never returned to would otherwise report nothing.
      settle();
      if (document.visibilityState === "hidden") flush();
      else lastTick.current = Date.now();
    };
    const onActivity = () => settle();

    const timer = window.setInterval(() => flush(), FLUSH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("scroll", onActivity, { passive: true });
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      flush();
      if (current?.track === push) current = null;
    };
    // `tab` is the whole dependency: a new view is a new visit, which means a
    // new pageview and a fresh time budget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // pagehide fires on close and on the back/forward cache, where unmount does
  // not. Registered once, reading the flush through a ref.
  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
}
