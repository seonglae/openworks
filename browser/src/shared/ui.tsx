// Rows outside the viewport skip layout and paint, which is most of the win of
// a virtualized grid. Unlike virtualization the rows stay in the DOM, so
// find-in-page, expand state, and anchor links keep working.
export const OFFSCREEN_SKIP = "content-visibility-auto";

// Modifier / middle clicks fall through to the anchor so the browser opens a
// new tab; a plain click never reloads the page.
export function isModifiedClick(e: React.MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

// Footer under a paginated list. Doubles as the infinite-scroll sentinel, so
// it takes the ref `useInfiniteScroll` returns. The empty state stays with the
// list itself, since each one words it differently.
export function PaginationFooter({
  status,
  count,
  sentinelRef,
}: {
  status: string;
  count: number;
  sentinelRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={sentinelRef} className="py-6 text-center mono text-[10px] uppercase tracking-wider text-ink-4">
      {status === "LoadingFirstPage" || status === "LoadingMore"
        ? "loading…"
        : status === "Exhausted" && count > 0
          ? `${count} shown`
          : ""}
    </div>
  );
}

// Generic skeleton block — rows of pulsing bars. Used in place of text
// "Loading..." indicators across the app.
export function BlockSkeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className}`} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-3 bg-paper-warm/60 animate-pulse rounded" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}
