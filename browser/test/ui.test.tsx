import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BlockSkeleton, isModifiedClick, OFFSCREEN_SKIP, PaginationFooter } from "../src/shared/ui";
import { MODE_KEYS } from "../src/shared/types";

const click = (over: Partial<React.MouseEvent> = {}) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, ...over }) as React.MouseEvent;

describe("isModifiedClick", () => {
  it("lets the browser handle a click that asks for a new tab or window", () => {
    expect(isModifiedClick(click({ metaKey: true }))).toBe(true);
    expect(isModifiedClick(click({ ctrlKey: true }))).toBe(true);
    expect(isModifiedClick(click({ shiftKey: true }))).toBe(true);
    expect(isModifiedClick(click({ altKey: true }))).toBe(true);
  });

  it("lets the browser handle a middle click", () => {
    expect(isModifiedClick(click({ button: 1 }))).toBe(true);
    expect(isModifiedClick(click({ button: 2 }))).toBe(true);
  });

  it("claims a plain left click for client-side routing", () => {
    expect(isModifiedClick(click())).toBe(false);
  });
});

describe("PaginationFooter", () => {
  it("says it is fetching while the first page is on the way", () => {
    render(<PaginationFooter status="LoadingFirstPage" count={0} sentinelRef={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("says it is fetching while a later page is on the way", () => {
    render(<PaginationFooter status="LoadingMore" count={40} sentinelRef={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("reports the total only once the whole list has arrived", () => {
    const { container } = render(<PaginationFooter status="Exhausted" count={12} sentinelRef={null} />);
    expect(container).toHaveTextContent("12 shown");
  });

  it("stays silent about a total that is still growing", () => {
    const { container } = render(<PaginationFooter status="CanLoadMore" count={20} sentinelRef={null} />);
    expect(container.textContent).toBe("");
  });

  it("stays silent when the list turned out to be empty", () => {
    // The views word their own empty state, so the footer must not add "0 shown".
    const { container } = render(<PaginationFooter status="Exhausted" count={0} sentinelRef={null} />);
    expect(container.textContent).toBe("");
  });

  it("exposes its own node as the scroll sentinel", () => {
    const sentinelRef = createRef<HTMLDivElement>();
    const { container } = render(<PaginationFooter status="Exhausted" count={7} sentinelRef={sentinelRef} />);
    expect(sentinelRef.current).toBe(container.firstElementChild);
    expect(sentinelRef.current).toHaveTextContent("7 shown");
  });

  it("keeps the sentinel node mounted while it is empty, so scrolling can still trigger", () => {
    const sentinelRef = createRef<HTMLDivElement>();
    render(<PaginationFooter status="CanLoadMore" count={20} sentinelRef={sentinelRef} />);
    expect(sentinelRef.current).toBeInTheDocument();
  });
});

describe("BlockSkeleton", () => {
  it("draws three bars unless told otherwise", () => {
    const { container } = render(<BlockSkeleton />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
  });

  it("draws as many bars as asked for", () => {
    const { container } = render(<BlockSkeleton rows={6} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(6);
  });

  it("tapers the bars so the block reads as text rather than a table", () => {
    const { container } = render(<BlockSkeleton rows={3} />);
    const widths = [...container.querySelectorAll<HTMLElement>(".animate-pulse")].map((bar) => bar.style.width);
    expect(widths).toEqual(["100%", "88%", "76%"]);
  });

  it("tells assistive tech the region is still loading", () => {
    const { container } = render(<BlockSkeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
  });

  it("keeps the caller's layout classes alongside its own", () => {
    const { container } = render(<BlockSkeleton className="mt-4" />);
    expect(container.firstElementChild).toHaveClass("space-y-1.5", "mt-4");
  });
});

describe("OFFSCREEN_SKIP", () => {
  it("is a single class token, since it is interpolated into className strings", () => {
    expect(OFFSCREEN_SKIP).toBe("content-visibility-auto");
    expect(OFFSCREEN_SKIP.trim()).toBe(OFFSCREEN_SKIP);
    expect(OFFSCREEN_SKIP.split(/\s+/)).toHaveLength(1);
  });
});

describe("MODE_KEYS", () => {
  it("lists every tab once", () => {
    expect(new Set(MODE_KEYS).size).toBe(MODE_KEYS.length);
  });

  it("includes the tab the router falls back to when `?tab=` is missing or unknown", () => {
    expect(MODE_KEYS).toContain("newsletter");
  });

  it("names tabs that survive a round trip through a query string", () => {
    for (const key of MODE_KEYS) {
      expect(encodeURIComponent(key)).toBe(key);
    }
  });
});
