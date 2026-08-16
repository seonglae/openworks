import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";

// Infinite scroll: attach the returned ref to a sentinel element below the
// list and it pulls the next batch whenever that element scrolls into view.
// rootMargin starts the fetch a screenful early so the list rarely shows a
// gap. Returns a ref rather than rendering anything so each list keeps its
// own footer markup.
export function useInfiniteScroll(status: string, loadMore: (n: number) => void, batch: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const canLoad = status === "CanLoadMore";
  useEffect(() => {
    const el = ref.current;
    if (!el || !canLoad) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(batch), {
      rootMargin: "600px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, loadMore, batch]);
  return ref;
}

export function useCachedQuery<T>(key: string, value: T | undefined): T | undefined {
  useEffect(() => {
    if (value !== undefined) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    }
  }, [key, value]);
  if (value !== undefined) return value;
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached) as T;
  } catch {}
  return undefined;
}

// Measures the active item (matched by data-tabkey) inside a relative nav
// and returns left/width for the sliding droplet indicator. Re-measures on
// active change, item reorder, and window resize.
export function useDropletRect(navRef: React.RefObject<HTMLElement | null>, activeKey: string | null, deps: unknown[]) {
  const [rect, setRect] = useState<{ left: number; width: number; top: number; height: number } | null>(null);
  const measure = useCallback(() => {
    if (!activeKey) {
      setRect(null);
      return;
    }
    const el = navRef.current?.querySelector<HTMLElement>(`[data-tabkey="${activeKey}"]`);
    if (el) setRect({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop, height: el.offsetHeight });
    else setRect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, navRef, ...deps]);
  useLayoutEffect(() => {
    measure();
  }, [measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  return rect;
}
