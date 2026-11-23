import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Archive, ArrowUpRight, Check, Link2, X } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Md } from "../components/markdown";

// The Feed: one item per screen, read from the top, moved through by
// scrolling. A page shows the whole summary, never clipped, with its pending
// Notion edits to apply or reject, and Open, Original and Archive below.

type Page = FunctionReturnType<typeof api.feed.list>;
type Row = Page["items"][number];

const PAGE = 12;

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function FeedView({ onOpen }: { onOpen: (tab: string, item?: string) => void }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [gone, setGone] = useState<Set<string>>(new Set());
  return (
    <div className="h-[calc(100dvh-8rem)] snap-y snap-mandatory overflow-y-auto">
      {cursors.map((cursor, i) => (
        <FeedPage
          key={cursor ?? "first"}
          cursor={cursor}
          gone={gone}
          onGone={(key) => setGone((prev) => new Set(prev).add(key))}
          onOpen={onOpen}
          onNext={i === cursors.length - 1 ? (next) => setCursors((prev) => [...prev, next]) : undefined}
        />
      ))}
    </div>
  );
}

function FeedPage({
  cursor,
  gone,
  onGone,
  onOpen,
  onNext,
}: {
  cursor: string | undefined;
  gone: Set<string>;
  onGone: (key: string) => void;
  onOpen: (tab: string, item?: string) => void;
  onNext?: (cursor: string) => void;
}) {
  const page = useQuery(api.feed.list, { limit: PAGE, ...(cursor ? { cursor } : {}) });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    const next = page?.cursor;
    if (!el || !next || !onNext) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && onNext(next), { rootMargin: "200% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [page?.cursor, onNext]);
  if (page === undefined) return cursor ? null : <p className="p-8 text-center text-ink-3">Loading…</p>;
  const rows = page.items.filter((r) => !gone.has(r.key));
  if (!cursor && rows.length === 0) return <p className="p-8 text-center text-ink-3">Nothing new yet</p>;
  return (
    <>
      {rows.map((row) => (
        <FeedItem key={row.key} row={row} onOpen={onOpen} onGone={() => onGone(row.key)} />
      ))}
      <div ref={end} />
    </>
  );
}

function FeedItem({
  row,
  onOpen,
  onGone,
}: {
  row: Row;
  onOpen: (tab: string, item?: string) => void;
  onGone: () => void;
}) {
  const archiveJob = useMutation(api.jobs.archive);
  const setInsightStatus = useMutation(api.insights.setStatus);
  const archive = () => {
    onGone();
    if (row.jobId) void archiveJob({ jobId: row.jobId });
    else if (row.insightId) void setInsightStatus({ id: row.insightId, status: "dismissed" });
  };
  const url = row.inputSource?.url;
  return (
    <section className="flex h-full snap-start flex-col px-4 py-3 sm:px-8" aria-label={row.title}>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5">
        <header className="text-center">
          <p className="mono text-[13px] text-ink-3">{[row.subtitle, ago(row.at)].filter(Boolean).join(" · ")}</p>
          <h2 className="serif mt-2 text-[30px] leading-tight text-ink">{row.title}</h2>
        </header>
        <div className="space-y-3 text-[18px] leading-relaxed text-ink">
          {(row.lines ?? []).map((line, i) => (
            <div key={i}>
              <Md>{line}</Md>
            </div>
          ))}
        </div>
        {row.jobId && (row.notion ?? 0) > 0 && (
          <Edits
            jobId={row.jobId}
            total={row.notion ?? 0}
            onOpen={() => row.open && onOpen(row.open.tab, row.open.item)}
          />
        )}
        {row.place && (
          <div className="rounded-xl border border-rule-light bg-paper/60 p-4">
            <p className="text-[15px] font-medium text-ink">{row.place.pageName}</p>
            <div className="mt-1 text-[15px] text-ink-2">
              <Md>{row.place.content}</Md>
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center justify-center gap-8 pt-2">
          {row.open && (
            <Action label="Open" onClick={() => onOpen(row.open!.tab, row.open!.item)}>
              <ArrowUpRight size={20} />
            </Action>
          )}
          {url && (
            <Action label="Original" onClick={() => window.open(url, "_blank", "noopener")}>
              <Link2 size={20} />
            </Action>
          )}
          {(row.jobId || row.insightId) && (
            <Action label={row.jobId ? "Archive" : "Dismiss"} onClick={archive}>
              {row.jobId ? <Archive size={20} /> : <X size={20} />}
            </Action>
          )}
        </div>
      </div>
    </section>
  );
}

// The first two pending Notion edits, decided here; the rest behind Open.
function Edits({ jobId, total, onOpen }: { jobId: Id<"jobs">; total: number; onOpen: () => void }) {
  const all = useQuery(api.suggestions.listByJob, { jobId });
  const decide = useMutation(api.suggestions.updateStatus);
  const pending = (all ?? []).filter((s) => s.status === "pending");
  return (
    <div className="flex flex-col gap-3">
      <p className="mono text-[13px] text-ink-3">Edits · {total}</p>
      {pending.slice(0, 2).map((s) => (
        <div key={s._id} className="rounded-xl border border-rule-light bg-paper/60 p-4">
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-[16px] font-medium text-ink">{s.pageName}</p>
            <button
              aria-label="Reject"
              onClick={() => void decide({ suggestionId: s._id, status: "rejected" })}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-decline text-paper"
            >
              <X size={16} />
            </button>
            <button
              aria-label="Apply"
              onClick={() => void decide({ suggestionId: s._id, status: "approved" })}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-accept text-paper"
            >
              <Check size={16} />
            </button>
          </div>
          <div className="mt-2 text-[15px] text-ink-2">
            <Md>{s.content}</Md>
          </div>
        </div>
      ))}
      {pending.length > 2 && (
        <button
          onClick={onOpen}
          className="self-start text-[14px] text-ink-3 underline underline-offset-2 hover:text-ink"
        >
          Open to see the other {pending.length - 2}
        </button>
      )}
    </div>
  );
}

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1 text-ink-2 hover:text-ink" title={label}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink/5">{children}</span>
      <span className="text-[13px]">{label}</span>
    </button>
  );
}
