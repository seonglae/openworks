import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { useCachedQuery, useInfiniteScroll } from "../src/shared/hooks";

// happy-dom ships an IntersectionObserver that never fires, so the test
// installs one it can drive by hand and keeps every instance for assertions.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  readonly callback: IntersectionObserverCallback;
  readonly options?: IntersectionObserverInit;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  unobserve(el: Element) {
    this.observed = this.observed.filter((seen) => seen !== el);
  }

  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(isIntersecting: boolean) {
    const entries = [{ isIntersecting }] as IntersectionObserverEntry[];
    act(() => this.callback(entries, this as unknown as IntersectionObserver));
  }
}

const observers = () => FakeIntersectionObserver.instances;
const lastObserver = () => observers()[observers().length - 1];

type ScrollListProps = { status: string; loadMore: (n: number) => void; batch?: number };

function ScrollList({ status, loadMore, batch = 20 }: ScrollListProps) {
  const sentinelRef = useInfiniteScroll(status, loadMore, batch);
  return <div data-testid="sentinel" ref={sentinelRef} />;
}

describe("useInfiniteScroll", () => {
  let loadMore: Mock<(n: number) => void>;

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    loadMore = vi.fn<(n: number) => void>();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("watches the sentinel a screenful before it reaches the viewport", () => {
    render(<ScrollList status="CanLoadMore" loadMore={loadMore} />);
    expect(observers()).toHaveLength(1);
    expect(lastObserver().observed).toEqual([screen.getByTestId("sentinel")]);
    expect(lastObserver().options?.rootMargin).toBe("600px 0px");
  });

  it("watches nothing while a page is still in flight or the list is exhausted", () => {
    for (const status of ["LoadingFirstPage", "LoadingMore", "Exhausted"]) {
      render(<ScrollList status={status} loadMore={loadMore} />);
    }
    expect(observers()).toHaveLength(0);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("pulls one batch when the sentinel scrolls into view", () => {
    render(<ScrollList status="CanLoadMore" loadMore={loadMore} batch={25} />);
    lastObserver().fire(true);
    expect(loadMore).toHaveBeenCalledExactlyOnceWith(25);
  });

  it("pulls nothing when the sentinel scrolls back out of view", () => {
    render(<ScrollList status="CanLoadMore" loadMore={loadMore} />);
    lastObserver().fire(false);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("pulls a batch per crossing, so a fast scroll keeps filling the list", () => {
    render(<ScrollList status="CanLoadMore" loadMore={loadMore} batch={10} />);
    lastObserver().fire(true);
    lastObserver().fire(false);
    lastObserver().fire(true);
    expect(loadMore.mock.calls).toEqual([[10], [10]]);
  });

  it("starts watching once a stalled list can load again", () => {
    const { rerender } = render(<ScrollList status="LoadingFirstPage" loadMore={loadMore} />);
    expect(observers()).toHaveLength(0);
    rerender(<ScrollList status="CanLoadMore" loadMore={loadMore} />);
    expect(observers()).toHaveLength(1);
    expect(lastObserver().observed).toEqual([screen.getByTestId("sentinel")]);
  });

  it("stops watching once the list runs out", () => {
    const { rerender } = render(<ScrollList status="CanLoadMore" loadMore={loadMore} />);
    const first = lastObserver();
    rerender(<ScrollList status="Exhausted" loadMore={loadMore} />);
    expect(first.disconnected).toBe(true);
    expect(observers()).toHaveLength(1);
  });

  it("stops watching when the list unmounts", () => {
    const { unmount } = render(<ScrollList status="CanLoadMore" loadMore={loadMore} />);
    const observer = lastObserver();
    expect(observer.disconnected).toBe(false);
    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it("re-subscribes when the caller passes a fresh callback identity", () => {
    // App.tsx hands over an inline arrow, so every parent render lands here.
    const { rerender } = render(<ScrollList status="CanLoadMore" loadMore={loadMore} />);
    const first = lastObserver();
    rerender(<ScrollList status="CanLoadMore" loadMore={vi.fn<(n: number) => void>()} />);
    expect(first.disconnected).toBe(true);
    expect(observers()).toHaveLength(2);
  });
});

describe("useCachedQuery", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the live value and remembers it for the next visit", () => {
    const { result } = renderHook(() => useCachedQuery("cache:plans", [{ slug: "a" }]));
    expect(result.current).toEqual([{ slug: "a" }]);
    expect(localStorage.getItem("cache:plans")).toBe(JSON.stringify([{ slug: "a" }]));
  });

  it("shows the last known value while the query is still loading", () => {
    localStorage.setItem("cache:plans", JSON.stringify([{ slug: "cached" }]));
    const { result } = renderHook(() => useCachedQuery<{ slug: string }[]>("cache:plans", undefined));
    expect(result.current).toEqual([{ slug: "cached" }]);
  });

  it("replaces the cache once the query resolves", () => {
    localStorage.setItem("cache:plans", JSON.stringify([{ slug: "stale" }]));
    const { result, rerender } = renderHook(({ value }) => useCachedQuery("cache:plans", value), {
      initialProps: { value: undefined as { slug: string }[] | undefined },
    });
    expect(result.current).toEqual([{ slug: "stale" }]);
    rerender({ value: [{ slug: "fresh" }] });
    expect(result.current).toEqual([{ slug: "fresh" }]);
    expect(localStorage.getItem("cache:plans")).toBe(JSON.stringify([{ slug: "fresh" }]));
  });

  it("returns nothing on a cold start and writes nothing", () => {
    const { result } = renderHook(() => useCachedQuery<string[]>("cache:cold", undefined));
    expect(result.current).toBeUndefined();
    expect(localStorage.getItem("cache:cold")).toBeNull();
  });

  it("survives a cache entry that is not valid JSON", () => {
    localStorage.setItem("cache:plans", "{not json");
    const { result } = renderHook(() => useCachedQuery<string[]>("cache:plans", undefined));
    expect(result.current).toBeUndefined();
  });

  it("survives storage that refuses to read or write, as in private browsing", () => {
    const denied = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: denied, setItem: denied, removeItem: denied, clear: denied });
    expect(() => renderHook(() => useCachedQuery("cache:plans", ["written"]))).not.toThrow();
    expect(() => renderHook(() => useCachedQuery<string[]>("cache:plans", undefined))).not.toThrow();
  });

  it("keeps caches apart by key", () => {
    renderHook(() => useCachedQuery("cache:a", 1));
    renderHook(() => useCachedQuery("cache:b", 2));
    const { result } = renderHook(() => useCachedQuery<number>("cache:a", undefined));
    expect(result.current).toBe(1);
  });

  it("hands back a fresh object on every render while serving the cache", () => {
    // Current behaviour, not a guarantee: the fallback re-parses each render,
    // so consumers must not use the result as a memo or effect dependency.
    localStorage.setItem("cache:plans", JSON.stringify([{ slug: "cached" }]));
    const { result, rerender } = renderHook(() => useCachedQuery<{ slug: string }[]>("cache:plans", undefined));
    const first = result.current;
    rerender();
    expect(result.current).toEqual(first);
    expect(result.current).not.toBe(first);
  });
});
