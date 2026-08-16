import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { Md, MdNotion } from "../components/markdown";
import { AgentIcon } from "../AgentIcons";
import { SummaryView } from "../shared/summary";
import { isTerminalJobStatus } from "@openworks/domain";
import { truncateSafe } from "@openworks/core";
import { useDropletRect } from "../shared/hooks";
import { BlockSkeleton } from "../shared/ui";
import {
  Send,
  ImagePlus,
  FileText,
  Lightbulb,
  Rocket,
  Check,
  X,
  CheckCheck,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Minus,
  Archive,
  ArchiveRestore,
  RefreshCw,
  Rss,
  Trash2,
} from "lucide-react";

// ── Steps ──────────────────────────────────────────────────────────────

type Step = "summary" | "suggestion" | "execution";

const STEPS: { key: Step; label: string; icon: typeof FileText }[] = [
  { key: "summary", label: "Summary", icon: FileText },
  { key: "suggestion", label: "Suggestion", icon: Lightbulb },
  { key: "execution", label: "Update", icon: Rocket },
];

function stepFromStatus(status: Doc<"jobs">["status"] | undefined): Step {
  if (!status) return "summary";
  switch (status) {
    case "pending":
    case "summarizing":
      return "summary";
    case "suggesting":
    case "suggested":
      return "suggestion";
    case "executing":
    case "done":
    case "error":
      return "execution";
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "pending",
    summarizing: "summarizing",
    suggesting: "suggesting",
    suggested: "suggested",
    executing: "executing",
    done: "settled",
    error: "error",
    approved: "approved",
    rejected: "rejected",
    executed: "executed",
  };
  return labels[status] ?? status;
}

// ── Input ──────────────────────────────────────────────────────────────

export function UniversalInput({
  placeholder,
  onSubmit,
  loading,
  allowImage,
}: {
  placeholder: string;
  onSubmit: (input: string, images?: File[]) => void | Promise<void>;
  loading?: boolean;
  // Paper/Article tabs accept clipboard-pasted screenshots — the worker
  // identifies the source from the image(s) and pulls the full text. Multiple
  // images can be attached (paste several, or pick files) and process together.
  allowImage?: boolean;
}) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous re-entry guard: `submitting` state updates async, so mashing
  // Enter fires handleSubmit several times before the first re-render. A ref
  // blocks the duplicates immediately so an attached image uploads only once.
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isMultiline = input.includes("\n") || input.length > 120;

  const addFiles = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    setImages((prev) => [...prev, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  const removeImage = (idx: number) => {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const gone = prev[idx];
      if (gone) URL.revokeObjectURL(gone.url);
      return next;
    });
  };

  const clearImages = () => {
    setImages((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allowImage) return;
    const pasted: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
    }
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(pasted);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const trimmed = input.trim();
    if (!trimmed && images.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, images.length > 0 ? images.map((i) => i.file) : undefined);
      setInput("");
      clearImages();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
      return;
    }
    // Empty input + Backspace removes the last attached image, one per press.
    if (e.key === "Backspace" && input === "" && images.length > 0) {
      e.preventDefault();
      removeImage(images.length - 1);
    }
  };

  if (loading) {
    return (
      <div className="panel anim d2 mb-6 flex gap-2 items-start" aria-busy="true">
        <div className="flex-1 h-6 bg-paper-warm/60 animate-pulse rounded" />
        <div className="shrink-0 h-7 w-[100px] bg-paper-warm/60 animate-pulse rounded" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="panel anim d2 mb-6 space-y-2">
      <div className="flex gap-2 items-start">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={allowImage ? `${placeholder} (or paste a screenshot)` : placeholder}
          rows={isMultiline ? Math.min(input.split("\n").length + 1, 30) : 1}
          className="block flex-1 bg-transparent outline-none text-ink placeholder:text-ink-4 mono resize-y self-center"
        />
        {allowImage && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images"
              className="p-1.5 text-ink-4 hover:text-rust transition-colors shrink-0 self-center"
            >
              <ImagePlus size={14} />
            </button>
          </>
        )}
        <button
          type="submit"
          disabled={(!input.trim() && images.length === 0) || submitting}
          className="droplet flex items-center gap-1.5 px-3 py-1.5 text-rust mono text-xs uppercase tracking-wider disabled:opacity-30 hover:brightness-105 transition-all shrink-0 rounded-full"
        >
          <Send size={12} />
          {submitting ? "Uploading" : "Process"}
        </button>
      </div>
      {images.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex gap-2 overflow-x-auto py-1">
            {images.map((img, i) => (
              <div key={img.url} className="relative shrink-0 group/img">
                <img
                  src={img.url}
                  alt={`attachment ${i + 1}`}
                  className="h-16 rounded border border-rule object-contain"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 bg-paper border border-rule rounded-full p-0.5 text-ink-4 hover:text-rust opacity-0 group-hover/img:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
          <span className="mono text-[10px] text-ink-4 shrink-0">
            {images.length} image{images.length === 1 ? "" : "s"} attached
          </span>
        </div>
      )}
    </form>
  );
}

// ── Score distribution (Paper / Article tabs) ─────────────────────────
// Reads summaries:scoreStats (one reactive query) and renders a compact KDE
// density figure over the 1-10 overall score with quartile markers.

type ScoreStats = {
  count: number;
  min: number;
  max: number;
  avg: number;
  histogram: { bin: number; count: number }[];
};

// Reactive: a single Convex query, so archiving / rescoring updates the chart
// live (no module cache, no one-shot fetch). Returns undefined while loading.
function useScoreStats(kind: "paper" | "article", archived = false): ScoreStats | null | undefined {
  const raw = useQuery(api.summaries.scoreStats, { archived });
  if (raw === undefined) return undefined;
  const a = raw[kind];
  if (!a || a.count === 0) return null;
  return {
    count: a.count,
    min: a.min ?? 0,
    max: a.max ?? 0,
    avg: a.sum / a.count,
    histogram: Object.entries(a.buckets)
      .map(([bin, count]) => ({ bin: Number(bin), count: count as number }))
      .sort((x, y) => x.bin - y.bin),
  };
}

// Newsletter distribution data from jobs:newsletterStats (one reactive query):
// per issue-date counts + summarized-item counts split by source.
type NlStats = {
  count: number;
  done: number;
  elements: number;
  bySource: Record<string, number>;
  byDate: { date: string; total: number; done: number; elements: number; srcElements: Record<string, number> }[];
};
// Stacking order + fill color (hex, for SVG) per newsletter source.
const NL_SRC_ORDER = ["tldr", "alphasignal", "alphaxiv", "paste", "other"] as const;
const NL_SRC_FILL: Record<string, string> = {
  tldr: "var(--color-ochre)",
  alphasignal: "var(--color-rust)",
  alphaxiv: "#5a7a5a",
  paste: "#8a8a8a",
  other: "#b8b8b8",
};
// Newsletter source display label + accent color for the non-archived counts
// shown left of the Detail button.
const NL_SRC_LABEL: Record<string, string> = {
  tldr: "TLDR",
  alphasignal: "AlphaSignal",
  alphaxiv: "alphaXiv",
  paste: "Paste",
  other: "Other",
};
// Reactive: a single Convex query so archiving / adding a newsletter updates the
// chart and the per-source counts live.
function useNewsletterStats(archived = false): NlStats | null | undefined {
  return useQuery(api.jobs.newsletterStats, { archived });
}

export function NewsletterDistribution({
  selected,
  onSelect,
  selectedSource,
  onSelectSource,
  archived,
}: {
  selected: string | null;
  onSelect: (key: string | null) => void;
  selectedSource: string | null;
  onSelectSource: (src: string | null) => void;
  archived: boolean;
}) {
  const stats = useNewsletterStats(archived);
  if (!stats || stats.byDate.length < 2) return null;
  const W = 640;
  const H = 84;
  const PB = 14;
  const plotH = H - PB - 4;
  const n = stats.byDate.length;

  // Per issue-date, the summarized-item count stacked by source color, so each
  // bar's height is that date's total items and its segments show the source mix.
  const bw = W / n;
  const barW = Math.max(1, bw * 0.7);
  const maxV = Math.max(...stats.byDate.map((d) => d.elements), 1);
  const scale = (v: number) => (v / maxV) * plotH;
  // Sources actually present, in canonical stack order, for the legend.
  const present = NL_SRC_ORDER.filter((s) => (stats.bySource[s] ?? 0) > 0);

  return (
    <div className="panel mb-3 anim d2">
      <div className="flex items-center justify-between mb-1">
        <span className="mono text-[9px] uppercase tracking-wider text-ink-4">Newsletter distribution</span>
        <span className="mono text-[9px] text-ink-4">
          {selected ? (
            <button onClick={() => onSelect(null)} className="text-rust hover:underline">
              {selected} ✕
            </button>
          ) : (
            <>
              {/* Letters first, then the larger count they contain. `elements` is
                  what the backend calls a summarized entry, so the UI says it too. */}
              {stats.count} letters · <span className="text-rust">{stats.elements}</span> elements · {n} days
            </>
          )}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-label="newsletter distribution">
        {stats.byDate.map((d, i) => {
          const x = i * bw + (bw - barW) / 2;
          const dim = selected != null && selected !== d.date;
          // Stack segments from the baseline up, in canonical source order.
          let yTop = 4 + plotH;
          return (
            <g key={d.date} opacity={dim ? 0.25 : 1}>
              {NL_SRC_ORDER.map((src) => {
                const v = d.srcElements[src] ?? 0;
                if (v <= 0) return null;
                const h = scale(v);
                yTop -= h;
                const dimSrc = selectedSource != null && selectedSource !== src;
                return (
                  <rect
                    key={src}
                    x={x}
                    y={yTop}
                    width={barW}
                    height={h}
                    fill={NL_SRC_FILL[src]}
                    opacity={dimSrc ? 0.2 : 1}
                  />
                );
              })}
              {/* Full-height invisible hit area so even tiny bars are clickable. */}
              <rect
                x={i * bw}
                y={0}
                width={bw}
                height={H}
                fill="transparent"
                className="cursor-pointer"
                onClick={() => onSelect(selected === d.date ? null : d.date)}
              >
                <title>{`${d.date}: ${d.total} letters, ${d.elements} elements`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center justify-between mt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {present.map((src) => {
            const active = selectedSource === src;
            const muted = selectedSource != null && !active;
            return (
              <button
                key={src}
                onClick={() => onSelectSource(active ? null : src)}
                title={`${NL_SRC_LABEL[src] ?? src}: ${stats.bySource[src]} letters — click to show only these`}
                className={`flex items-center gap-1 mono text-[8px] transition-opacity hover:opacity-100 ${
                  active ? "text-ink-2" : "text-ink-3"
                } ${muted ? "opacity-40" : "opacity-100"}`}
              >
                <span className="inline-block w-2 h-2 rounded-[1px]" style={{ background: NL_SRC_FILL[src] }} />
                {NL_SRC_LABEL[src] ?? src}
                <span className="text-ink-4">{stats.bySource[src]}</span>
              </button>
            );
          })}
        </div>
        <span className="mono text-[8px] text-ink-4">
          {stats.byDate[0].date} to {stats.byDate[n - 1].date}
        </span>
      </div>
    </div>
  );
}

// Per-date job-count bars for article / paper, with a clickable bar per date
// (toggles a filter on the list). Papers add a basis toggle: uploaded-to-Openworks
// date vs the paper's published month (parsed from the arXiv id).
// Reactive: a single Convex query so archiving / adding a paper or article
// updates the date bars live.
function useJobDateStats(
  type: "paper" | "article",
  archived = false,
): {
  created: { date: string; count: number }[];
  published: { date: string; count: number }[];
} | null {
  return useQuery(api.jobs.jobDateStats, { type, archived }) ?? null;
}

export function DateDistribution({
  kind,
  basis,
  onBasisChange,
  selected,
  onSelect,
  archived,
}: {
  kind: "paper" | "article";
  basis: "created" | "published";
  onBasisChange: (b: "created" | "published") => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  archived: boolean;
}) {
  const stats = useJobDateStats(kind, archived);
  if (!stats) return null;
  const series = basis === "published" ? stats.published : stats.created;
  if (series.length < 2) return null;
  const W = 640;
  const H = 76;
  const plotH = H - 18;
  const n = series.length;
  const bw = W / n;
  const barW = Math.max(1, bw * 0.7);
  const maxV = Math.max(...series.map((d) => d.count), 1);
  const total = series.reduce((s, d) => s + d.count, 0);

  return (
    <div className="panel mb-3 anim d2">
      <div className="flex items-center justify-between mb-1">
        <span className="mono text-[9px] uppercase tracking-wider text-ink-4">Date distribution</span>
        <div className="flex items-center gap-2">
          {kind === "paper" && (
            <div className="flex items-center gap-0.5 mono text-[8px]">
              {(["created", "published"] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => onBasisChange(b)}
                  className={`px-1.5 py-0.5 rounded uppercase tracking-wider transition-colors ${
                    basis === b ? "bg-rust/15 text-rust" : "text-ink-4 hover:text-ink-3"
                  }`}
                >
                  {b === "created" ? "uploaded" : "published"}
                </button>
              ))}
            </div>
          )}
          <span className="mono text-[9px] text-ink-4">
            {selected ? (
              <button onClick={() => onSelect(null)} className="text-rust hover:underline">
                {selected} ✕
              </button>
            ) : (
              <>
                <span className="text-rust">{total}</span> · {n} dates
              </>
            )}
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-label="date distribution">
        {series.map((d, i) => {
          const x = i * bw + (bw - barW) / 2;
          const h = (d.count / maxV) * plotH;
          const dim = selected != null && selected !== d.date;
          return (
            <g key={d.date} opacity={dim ? 0.25 : 1}>
              <rect x={x} y={4 + plotH - h} width={barW} height={h} fill="var(--color-rust)" />
              <rect
                x={i * bw}
                y={0}
                width={bw}
                height={H}
                fill="transparent"
                className="cursor-pointer"
                onClick={() => onSelect(selected === d.date ? null : d.date)}
              >
                <title>{`${d.date}: ${d.count}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between mono text-[8px] text-ink-4">
        <span>{series[0].date}</span>
        <span>{series[n - 1].date}</span>
      </div>
    </div>
  );
}

// Square checkbox-style toggle used in the feeds manager (subscribe-backfill +
// per-feed enable).
function Checker({ on, onClick, title }: { on: boolean; onClick?: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`shrink-0 w-[18px] h-[18px] rounded flex items-center justify-center border transition-colors ${
        on ? "bg-sage border-sage text-paper" : "bg-transparent border-ink-3 text-transparent hover:border-ink-2"
      }`}
    >
      <Check size={12} strokeWidth={3} />
    </button>
  );
}

// Article-tab RSS feed subscriptions. The button opens a modal to add / toggle
// / remove feeds; a daily Convex cron polls enabled feeds and auto-registers new
// items as Article jobs. "Poll now" triggers that pass on demand.
export function FeedsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mb-3 flex justify-end">
        <button
          onClick={() => setOpen(true)}
          className="mono inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-3 hover:text-ink border border-ink/10 hover:border-ink/30 rounded-full px-2.5 py-1 transition-colors"
        >
          <Rss size={11} /> Feeds
        </button>
      </div>
      {open && <FeedsModal onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedsModal({ onClose }: { onClose: () => void }) {
  const feeds = useQuery(api.feeds.list, {});
  const addFeed = useMutation(api.feeds.add);
  const setEnabled = useMutation(api.feeds.setEnabled);
  const removeFeed = useMutation(api.feeds.remove);
  const pollNow = useAction(api.feeds.pollNow);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const submit = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    setMsg("");
    try {
      await addFeed({ url: u, title: title.trim() || undefined, backfill });
      setUrl("");
      setTitle("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const poll = async () => {
    setBusy(true);
    setMsg("polling...");
    try {
      const r = await pollNow({});
      setMsg(
        `polled ${r.feeds} feed(s) · registered ${r.created} new article(s)${r.errors ? ` · ${r.errors} error(s)` : ""}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-ink/45" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-auto rounded-2xl border border-ink/15 bg-paper shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="mono text-xs uppercase tracking-wider text-ink flex items-center gap-1.5">
            <Rss size={13} /> RSS Feeds
          </h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <X size={15} />
          </button>
        </div>
        <p className="text-[11px] text-ink-3 mb-3">Polled daily; new items auto-register as Article jobs.</p>

        <div className="flex flex-col gap-2 mb-4">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="https://example.com/feed.xml"
            className="text-[12px] text-ink bg-paper-warm border border-ink/20 rounded-md px-2.5 py-1.5 outline-none focus:border-ink/50 placeholder:text-ink-4"
          />
          <div className="flex gap-1.5">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="title (optional)"
              className="flex-1 text-[12px] text-ink bg-paper-warm border border-ink/20 rounded-md px-2.5 py-1.5 outline-none focus:border-ink/50 placeholder:text-ink-4"
            />
            <button
              onClick={submit}
              disabled={busy || !url.trim()}
              className="mono text-[10px] uppercase tracking-wider text-paper bg-ink hover:bg-ink-2 rounded-md px-4 disabled:opacity-30 transition-colors"
            >
              Add
            </button>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-ink-2 cursor-pointer select-none mt-0.5">
            <Checker on={backfill} onClick={() => setBackfill(!backfill)} />
            register all current items now
            <span className="text-ink-3">(default: only future ones)</span>
          </label>
        </div>

        <div className="flex flex-col">
          {feeds === undefined ? (
            <div className="text-[11px] text-ink-3 py-2">loading...</div>
          ) : feeds.length === 0 ? (
            <div className="text-[11px] text-ink-3 py-2">No feeds yet. Add an RSS / Atom URL above.</div>
          ) : (
            feeds.map((f) => (
              <div key={f._id} className="flex items-center gap-2.5 border-t border-ink/10 py-2 first:border-t-0">
                <Checker
                  on={f.enabled}
                  onClick={() => setEnabled({ id: f._id, enabled: !f.enabled })}
                  title={f.enabled ? "enabled, click to pause" : "paused, click to enable"}
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-[12px] truncate ${f.enabled ? "text-ink" : "text-ink-3"}`}>{f.title}</div>
                  <div className="text-[10px] text-ink-3 truncate">{f.url}</div>
                  {f.lastError && <div className="text-[10px] text-rust truncate">error: {f.lastError}</div>}
                </div>
                <span className="text-[10px] text-ink-3 shrink-0 mono" title="items seen last poll">
                  {f.itemCount ?? 0}
                </span>
                <button onClick={() => removeFeed({ id: f._id })} className="text-ink-3 hover:text-rust" title="remove">
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between mt-4 gap-3">
          <span className="text-[10px] text-ink-2 truncate">{msg}</span>
          <button
            onClick={poll}
            disabled={busy}
            className="mono text-[10px] uppercase tracking-wider text-ink hover:text-paper hover:bg-ink border border-ink/30 rounded-full px-3 py-1 disabled:opacity-30 transition-colors shrink-0"
          >
            Poll now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Cumulative-area quantiles of a sampled density curve: the x at which the area
// under the curve reaches each fraction. Placing p25/p50/p75 here splits the
// RENDERED area into equal quarters (what the eye reads), not just the raw data.
type Pt = { x: number; y: number };

// Cumulative trapezoidal area up to each sample point (cum[0] = 0).
function cumulativeArea(curve: Pt[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < curve.length; i++) {
    const segment = ((curve[i].y + curve[i - 1].y) / 2) * (curve[i].x - curve[i - 1].x);
    cum.push(cum[i - 1] + segment);
  }
  return cum;
}

// The x at which the cumulative area first reaches each fraction of the total,
// linearly interpolated inside the crossing segment. Placing p25/p50/p75 here
// splits the RENDERED area into equal quarters (what the eye reads).
function areaQuantiles(curve: Pt[], fracs: number[]): number[] {
  const cum = cumulativeArea(curve);
  const total = cum[cum.length - 1] || 1;
  return fracs.map((f) => {
    const target = f * total;
    const hi = cum.findIndex((c) => c >= target);
    if (hi < 0) return curve[curve.length - 1].x;
    if (hi === 0) return curve[0].x;
    const frac = (target - cum[hi - 1]) / (cum[hi] - cum[hi - 1] || 1);
    return curve[hi - 1].x + frac * (curve[hi].x - curve[hi - 1].x);
  });
}

// Linear-interpolated curve height at an arbitrary x, so a percentile marker's
// vertical line stops at the curve instead of the frame top.
function densityAt(curve: Pt[], x: number): number {
  const hi = curve.findIndex((p) => p.x >= x);
  if (hi < 0) return curve[curve.length - 1].y;
  if (hi === 0) return curve[0].y;
  const a = curve[hi - 1];
  const b = curve[hi];
  const frac = (x - a.x) / (b.x - a.x || 1);
  return a.y + frac * (b.y - a.y);
}

export function ScoreDistribution({ kind, archived }: { kind: "paper" | "article"; archived: boolean }) {
  const stats = useScoreStats(kind, archived);
  if (!stats || stats.count < 3) return null;

  // KDE over the score domain, weighted points from bucket centers.
  const pts: number[] = [];
  for (const b of stats.histogram) for (let i = 0; i < b.count; i++) pts.push(b.bin + 0.25);
  const lo = Math.max(0, Math.floor(stats.min) - 0.5);
  const hi = Math.min(10, Math.ceil(stats.max) + 0.5);
  const range = hi - lo || 1;
  const bw = 0.35;
  const STEPS = 100;
  const kde: { x: number; y: number }[] = [];
  let maxD = 0;
  for (let i = 0; i <= STEPS; i++) {
    const x = lo + (i / STEPS) * range;
    let d = 0;
    for (const p of pts) {
      const z = (x - p) / bw;
      d += Math.exp(-0.5 * z * z);
    }
    d /= pts.length * bw * Math.sqrt(2 * Math.PI);
    kde.push({ x, y: d });
    if (d > maxD) maxD = d;
  }
  if (maxD === 0) maxD = 1;
  // Markers split the rendered curve into equal-area quarters.
  const [q25, q50, q75] = areaQuantiles(kde, [0.25, 0.5, 0.75]);

  const W = 640;
  const H = 84;
  const PB = 14;
  const plotH = H - PB - 4;
  const xS = (v: number) => ((v - lo) / range) * W;
  const yS = (d: number) => 4 + plotH - (d / (maxD * 1.1)) * plotH;
  const path = kde.map((p, i) => `${i === 0 ? "M" : "L"} ${xS(p.x).toFixed(1)} ${yS(p.y).toFixed(1)}`).join(" ");
  const area = `${path} L ${xS(hi).toFixed(1)} ${yS(0).toFixed(1)} L ${xS(lo).toFixed(1)} ${yS(0).toFixed(1)} Z`;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo); t <= Math.floor(hi); t++) ticks.push(t);

  return (
    <div className="panel mb-3 anim d2">
      <div className="flex items-center justify-between mb-1">
        <span className="mono text-[9px] uppercase tracking-wider text-ink-4">Score distribution</span>
        <span className="mono text-[9px] text-ink-4">
          n {stats.count} · avg <span className="text-rust">{stats.avg.toFixed(1)}</span> · p50{" "}
          <span className="text-rust">{q50.toFixed(1)}</span> · {stats.min.toFixed(1)} to {stats.max.toFixed(1)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-label="score distribution">
        <path d={area} fill="currentColor" fillOpacity={0.15} className="text-rust" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.2} className="text-rust" />
        {(() => {
          // Each marker's line runs from the baseline up to the curve height at
          // that x, and its label sits just above that point (so the label y
          // follows the curve). Drop a label only when it would collide with the
          // previous one horizontally.
          const marks = [
            { v: q25, label: "p25" },
            { v: q50, label: "p50" },
            { v: q75, label: "p75" },
          ];
          const xs = marks.map((m) => xS(m.v));
          // Hide a label only when it would overlap its neighbour horizontally.
          const showLabel = xs.map((x, i) => i === 0 || x - xs[i - 1] >= 22);
          return marks.map(({ v, label }, i) => {
            const x = xs[i];
            const yTop = yS(densityAt(kde, v));
            return (
              <g key={label}>
                <line
                  x1={x}
                  y1={yTop}
                  x2={x}
                  y2={4 + plotH}
                  stroke="currentColor"
                  strokeWidth={0.7}
                  strokeDasharray="2,3"
                  className="text-ink-3"
                />
                {showLabel[i] && (
                  <text x={x} y={Math.max(yTop - 3, 9)} fontSize={7} textAnchor="middle" className="fill-ink-3 mono">
                    {label}
                  </text>
                )}
              </g>
            );
          });
        })()}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={xS(t)}
              y1={4 + plotH}
              x2={xS(t)}
              y2={7 + plotH}
              stroke="currentColor"
              strokeWidth={0.5}
              className="text-ink-4"
            />
            <text x={xS(t)} y={H - 4} fontSize={7} textAnchor="middle" className="fill-ink-4 mono opacity-70">
              {t}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function JobListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-0" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="ruled py-3 px-2 flex items-center gap-3">
          <div className="w-20 h-3 bg-paper-warm/60 animate-pulse rounded" />
          <div className="flex-1 h-3 bg-paper-warm/60 animate-pulse rounded" />
          <div className="w-16 h-3 bg-paper-warm/60 animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}

// ── Step Nav ───────────────────────────────────────────────────────────

function StepNav({
  active,
  onSelect,
  jobStatus,
  provider,
}: {
  active: Step;
  onSelect: (s: Step) => void;
  jobStatus: Doc<"jobs">["status"] | undefined;
  provider?: string;
}) {
  const stepOrder: Step[] = ["summary", "suggestion", "execution"];
  const activeIdx = stepOrder.indexOf(stepFromStatus(jobStatus));
  const navRef = useRef<HTMLElement | null>(null);
  const droplet = useDropletRect(navRef, active, []);
  const isEdge = active === stepOrder[0] || active === stepOrder[stepOrder.length - 1];

  return (
    <nav ref={navRef} className="glass rounded-full flex w-full gap-1 px-2 py-1 mb-6 anim d2 relative">
      {droplet && (
        <span
          aria-hidden
          className={`droplet ${isEdge ? "droplet-edge" : ""} absolute top-1 bottom-1 rounded-full pointer-events-none z-0`}
          style={{ left: droplet.left, width: droplet.width }}
        />
      )}
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const isActive = active === s.key;
        const isReachable = i <= activeIdx;
        return (
          <button
            key={s.key}
            data-tabkey={s.key}
            onClick={() => isReachable && onSelect(s.key)}
            className={`flex flex-1 items-center justify-center gap-1.5 px-4 py-2 mono text-xs uppercase tracking-wider transition-colors relative z-10 rounded-full whitespace-nowrap
              ${isActive ? "text-rust" : isReachable ? "text-ink-2 hover:text-ink" : "text-ink-4 cursor-default"}
            `}
          >
            <Icon size={14} />
            {s.label}
            {provider && i <= activeIdx && (s.key === "summary" || s.key === "suggestion") && (
              <span title={`processed by ${provider}`} className="ml-0.5">
                <AgentIcon provider={provider} size={11} />
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ── Status Badge ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "text-ochre bg-ochre-dim border border-ochre/60",
    summarizing: "text-slate bg-slate-dim border border-slate/60",
    suggesting: "text-slate bg-slate-dim border border-slate/60",
    suggested: "text-slate bg-slate-dim border border-slate/60",
    executing: "text-rust bg-rust-dim border border-rust/60",
    done: "text-ink-2 border border-rule",
    error: "text-rust bg-rust-dim border border-rust/60",
    approved: "text-slate bg-slate-dim border border-slate/60",
    rejected: "text-ink-3 border border-rule",
    executed: "text-ink-2 border border-rule",
  };

  const spinning = status === "summarizing" || status === "suggesting" || status === "executing";

  return (
    <span
      className={`mono text-[10px] uppercase tracking-wider px-2 py-0.5 ${colors[status] ?? "text-ink-3"} rounded-full`}
    >
      {spinning ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" />
          {statusLabel(status)}
        </span>
      ) : (
        statusLabel(status)
      )}
    </span>
  );
}

// ── Content Modal ─────────────────────────────────────────────────────

// The list payload omits `content`, so the modal fetches the full text for the
// one row the user opened.
export function ContentModal({ jobId, onClose }: { jobId: Id<"jobs">; onClose: () => void }) {
  const content = useQuery(api.jobs.getContent, { jobId });
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/15" onClick={onClose}>
      <div
        className="glass-strong rounded-2xl max-w-3xl w-full max-h-[80vh] overflow-y-auto mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end mb-3">
          <button onClick={onClose} className="p-1 text-ink-3 hover:text-ink transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="prose prose-sm max-w-none text-ink-2 [&_a]:text-rust [&_h1]:serif [&_h2]:serif [&_h3]:serif">
          {content === undefined ? <span className="mono text-xs text-ink-4">loading…</span> : <Md>{content ?? ""}</Md>}
        </div>
      </div>
    </div>
  );
}

// ── Diff Block ─────────────────────────────────────────────────────────

function DiffSection({ text, variant }: { text: string | undefined; variant: "context" | "add" }) {
  if (!text?.trim()) {
    return (
      <div className="px-3 py-1 bg-paper-warm/30">
        <span className="mono text-[10px] text-ink-4">···</span>
      </div>
    );
  }
  const bg = variant === "add" ? "bg-sage-dim" : "bg-paper-warm/30";
  const border = variant === "add" ? "border-l-2 border-sage" : "";
  const prefix = variant === "add" ? "+" : " ";
  const prefixColor = variant === "add" ? "text-sage" : "text-ink-4";
  const textColor =
    variant === "add"
      ? "[&_a]:text-rust [&_h1]:serif [&_h2]:serif [&_h3]:serif"
      : "text-ink-3 [&_a]:text-ink-3 [&_h1]:text-ink-3 [&_h2]:text-ink-3 [&_h3]:text-ink-3 [&_p]:text-ink-3";
  return (
    <div className={`flex ${bg} ${border}`}>
      <span className={`shrink-0 w-6 text-center mono text-xs leading-6 select-none ${prefixColor}`}>{prefix}</span>
      <div className={`flex-1 min-w-0 px-2 py-1 prose prose-sm max-w-none break-words ${textColor}`}>
        <MdNotion>{text}</MdNotion>
      </div>
    </div>
  );
}

function DiffBlock({
  contextBefore,
  content,
  contextAfter,
}: {
  contextBefore?: string;
  content: string;
  contextAfter?: string;
}) {
  return (
    <div className="mt-2 border border-rule overflow-hidden text-sm">
      <DiffSection text={contextBefore} variant="context" />
      <DiffSection text={content} variant="add" />
      <DiffSection text={contextAfter} variant="context" />
    </div>
  );
}

// ── Suggestion View ────────────────────────────────────────────────────

function scorePct(score: number) {
  return `${Math.round(score * 100)}%`;
}

// Paper tab suggestion step: agent-judged "Related research" (paper worth
// referencing in one of your projects) + vector-only "Related papers". Replaces
// the Notion-suggestion flow, which does not apply to paper jobs.
function PaperSuggestionView({ jobId }: { jobId: Id<"jobs"> }) {
  const summaries = useQuery(api.summaries.listByJob, { jobId });
  const links = useQuery(api.paperLinks.listByJob, { jobId });
  const relatedPapersFn = useAction(api.paperLinks.relatedPapers);
  const setStatus = useMutation(api.paperLinks.setStatus);
  const [related, setRelated] = useState<
    { summaryId: string; jobId: string; title: string; url: string; type?: string; score: number }[] | null
  >(null);

  const summaryId = summaries && summaries.length > 0 ? (summaries[0]._id as Id<"summaries">) : null;
  useEffect(() => {
    if (!summaryId) return;
    let alive = true;
    setRelated(null);
    relatedPapersFn({ summaryId })
      .then((r) => alive && setRelated(r))
      .catch(() => alive && setRelated([]));
    return () => {
      alive = false;
    };
  }, [summaryId]);

  return (
    <div className="space-y-8 py-2">
      <section>
        <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-3">Related research</div>
        {links === undefined ? (
          <BlockSkeleton rows={2} />
        ) : links.length === 0 ? (
          <div className="text-ink-4 mono text-xs italic">No related research (nothing worth forcing a link to).</div>
        ) : (
          <div className="space-y-0">
            {links.map((l, i) => (
              <div key={l._id} className={`ruled py-3 anim d${Math.min(i + 1, 6)}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <a
                      href={`/?research=${l.researchSlug}`}
                      className="serif text-base text-rust hover:underline break-words"
                    >
                      {l.researchTitle}
                    </a>
                    <div className="text-[13px] text-ink-2 mt-1 leading-relaxed">{l.reason}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="mono text-[10px] text-ink-4">{scorePct(l.score)}</span>
                    {l.status === "linked" ? (
                      <span className="mono text-[9px] uppercase tracking-wider text-sage px-1.5 py-0.5">linked</span>
                    ) : (
                      <>
                        <button
                          onClick={() => setStatus({ linkId: l._id, status: "linked" })}
                          className="p-1.5 text-slate hover:bg-slate-dim transition-colors rounded"
                          title="Link this paper to the project"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setStatus({ linkId: l._id, status: "rejected" })}
                          className="p-1.5 text-ink-3 hover:bg-paper-warm transition-colors rounded"
                          title="Dismiss"
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-3">Related papers</div>
        {related === null ? (
          <BlockSkeleton rows={3} />
        ) : related.length === 0 ? (
          <div className="text-ink-4 mono text-xs italic">No related papers found.</div>
        ) : (
          <div className="space-y-0">
            {related.map((p, i) => (
              <div
                key={p.summaryId}
                className={`ruled py-2.5 flex items-center justify-between gap-2 anim d${Math.min(i + 1, 6)}`}
              >
                <div className="min-w-0">
                  {p.url ? (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[14px] text-ink hover:text-rust hover:underline break-words"
                    >
                      {p.title}
                    </a>
                  ) : (
                    <span className="text-[14px] text-ink break-words">{p.title}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {p.type && <span className="mono text-[9px] uppercase tracking-wider text-ink-4">{p.type}</span>}
                  <span className="mono text-[10px] text-ink-4">{scorePct(p.score)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SuggestionView({ jobId }: { jobId: Id<"jobs"> }) {
  const suggestions = useQuery(api.suggestions.listByJob, { jobId });
  const job = useQuery(api.jobs.getById, { jobId });
  const updateStatus = useMutation(api.suggestions.updateStatus);
  const rejectAll = useMutation(api.suggestions.rejectAll);
  const approveAndExecuteAction = useAction(api.notion.approveAndExecute);
  const approveAllAndExecuteAction = useAction(api.notion.approveAllAndExecute);
  const [error, setError] = useState<string | null>(null);

  const approveAndExecute = async (args: { suggestionId: Id<"suggestions"> }) => {
    try {
      setError(null);
      await approveAndExecuteAction(args);
    } catch (e: any) {
      setError(e.message || "Notion update failed");
    }
  };
  const approveAllAndExecute = async (args: { jobId: Id<"jobs"> }) => {
    try {
      setError(null);
      await approveAllAndExecuteAction(args);
    } catch (e: any) {
      setError(e.message || "Notion update failed");
    }
  };

  if (!suggestions) {
    return <BlockSkeleton rows={4} className="py-4" />;
  }

  if (job?.type === "paper") return <PaperSuggestionView jobId={jobId} />;

  if (suggestions.length === 0) {
    if (job && (job.type === "article" || job.type === "pr-fix")) {
      return (
        <div className="text-ink-4 mono text-xs py-8 italic text-center">
          Notion suggestions are skipped for {job.type === "pr-fix" ? "PR" : job.type} jobs.
        </div>
      );
    }
    return <div className="text-ink-3 mono py-8">Waiting for Notion suggestions from Claude Code...</div>;
  }

  const hasPending = suggestions.some((s) => s.status === "pending");

  return (
    <div>
      {error && (
        <div className="mb-3 px-3 py-2 bg-rust-dim text-rust mono text-xs">
          {error}
          <button onClick={() => setError(null)} className="ml-2 hover:underline">
            dismiss
          </button>
        </div>
      )}
      {hasPending && (
        <div className="flex gap-2 mb-4 anim">
          <button
            onClick={() => approveAllAndExecute({ jobId })}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate text-paper mono text-xs uppercase tracking-wider hover:opacity-90 transition-opacity rounded-full"
          >
            <CheckCheck size={12} />
            Approve All
          </button>
          <button
            onClick={() => rejectAll({ jobId })}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-paper-warm text-ink-2 mono text-xs uppercase tracking-wider hover:bg-rule-light transition-colors rounded-full"
          >
            <XCircle size={12} />
            Reject All
          </button>
        </div>
      )}
      <div className="space-y-0">
        {suggestions.map((s, i) => (
          <div key={s._id} className={`ruled py-4 anim d${Math.min(i + 1, 6)}`}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="serif text-base truncate min-w-0">
                  {s.topic} &rarr;{" "}
                  <a href={s.pageUrl} target="_blank" rel="noopener noreferrer" className="text-rust hover:underline">
                    {s.pageName}
                  </a>
                </span>
                <StatusBadge status={s.status} />
              </div>
              {s.status === "pending" && (
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => approveAndExecute({ suggestionId: s._id })}
                    className="p-1.5 text-slate hover:bg-slate-dim transition-colors"
                    title="Approve"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() =>
                      updateStatus({
                        suggestionId: s._id,
                        status: "rejected",
                      })
                    }
                    className="p-1.5 text-ink-3 hover:bg-paper-warm transition-colors"
                    title="Reject"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
            <DiffBlock contextBefore={s.contextBefore} content={s.content} contextAfter={s.contextAfter} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Execution View ─────────────────────────────────────────────────────

function ExecutionView({ jobId }: { jobId: Id<"jobs"> }) {
  const suggestions = useQuery(api.suggestions.listByJob, { jobId });

  if (!suggestions) {
    return (
      <div className="flex items-center gap-2 text-ink-3 mono py-8">
        <Loader2 size={14} className="animate-spin" />
        Loading...
      </div>
    );
  }

  const approved = suggestions.filter((s) => s.status === "approved" || s.status === "executed");
  const rejected = suggestions.filter((s) => s.status === "rejected");

  if (approved.length === 0 && rejected.length === 0) {
    return (
      <div className="text-ink-3 mono py-8">No suggestions have been reviewed yet. Go back to approve or reject.</div>
    );
  }

  return (
    <div className="space-y-0">
      {approved.map((s, i) => (
        <div key={s._id} className={`ruled py-3 flex items-center justify-between anim d${Math.min(i + 1, 6)}`}>
          <div className="flex items-center gap-2">
            {s.status === "executed" ? (
              <Check size={14} className="text-slate" />
            ) : (
              <Loader2 size={14} className="text-ochre animate-spin" />
            )}
            <span className="text-ink-2">
              {s.topic} &rarr; {s.pageName}
            </span>
          </div>
          <StatusBadge status={s.status} />
        </div>
      ))}
      {rejected.length > 0 && (
        <div className="pt-4">
          <p className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2">Rejected</p>
          {rejected.map((s) => (
            <div key={s._id} className="py-2 flex items-center gap-2 text-ink-4">
              <Minus size={12} />
              <span className="line-through">
                {s.topic} &rarr; {s.pageName}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Job Row (self-contained, expands in place) ────────────────────────

// Module-level single-open guard for tldr popovers. When a new tooltip
// opens, the previously open one closes immediately (no delay) so two
// popovers can never be visible at once.
let activeTldrCloser: (() => void) | null = null;

export function JobRow({
  job,
  onContentClick,
  onDelete,
  onArchive,
  onUnarchive,
  onRetry,
  onActiveChange,
  defaultExpanded = false,
}: {
  job: Doc<"jobs">;
  onContentClick: (jobId: Id<"jobs">) => void;
  onDelete?: (jobId: Id<"jobs">) => void;
  onArchive?: (jobId: Id<"jobs">) => void;
  onUnarchive?: (jobId: Id<"jobs">) => void;
  onRetry?: (jobId: Id<"jobs">) => void;
  onActiveChange?: (open: boolean) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rowRef = useRef<HTMLDivElement>(null);
  // Toggle the inline detail, telling the parent which row is now the "current"
  // article so a keyboard shortcut can act on it.
  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    onActiveChange?.(next);
  };
  // Deep-linked (?item=) row: register as active and scroll it into view once.
  useEffect(() => {
    if (!defaultExpanded) return;
    onActiveChange?.(true);
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [viewStep, setViewStep] = useState<Step>("summary");
  const [tldrOpen, setTldrOpen] = useState(false);
  const [tldrPos, setTldrPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const tldrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Lists ship only a preview; the full text arrives from jobs:getContent
  // when the row is opened.
  const rowText = job.content ?? (job as { contentPreview?: string }).contentPreview;
  // The ellipsis is a claim that something was cut, so it only goes on when the
  // text was actually longer than the window.
  const preview = rowText ? truncateSafe(rowText, 60).replace(/\n/g, " ") + (rowText.length > 60 ? "…" : "") : "";
  const label = job.title || job.url || preview || "pasted image";
  // Short-lived URLs of the pasted screenshot(s), so the user can see what they
  // uploaded (thumbnail(s) in the row + full images, laid out horizontally, when
  // expanded).
  const imageUrls = useQuery(api.jobs.imageUrls, job.imageId ? { jobId: job._id } : "skip");
  const firstImage = imageUrls?.[0];
  const imageCount = imageUrls?.length ?? 0;

  const hasTldr =
    !job.archived &&
    (job.type === "newsletter" || job.type === "paper" || job.type === "article") &&
    Array.isArray(job.tldr) &&
    job.tldr.length > 0;
  // Paper/article-only: lazily fetch the summary row when the popover is
  // open so the tooltip can append the worker-assigned scores (paper:
  // overall + research level; article: overall + verdict + per-criterion
  // breakdown). Skipped for other rows / when the popover is closed so the
  // page-load bandwidth across the queue doesn't grow per row.
  const hoverSummaries = useQuery(
    api.summaries.listByJob,
    tldrOpen && (job.type === "paper" || job.type === "article") ? { jobId: job._id } : "skip",
  );
  const paperBadge = (() => {
    if (job.type !== "paper") return null;
    const row = hoverSummaries?.[0];
    if (!row) return null;
    const overall = row.scores?.overall;
    if (overall == null && !row.researchLevel) return null;
    return { overall, level: row.researchLevel };
  })();
  const articleBadge = (() => {
    if (job.type !== "article") return null;
    const a = hoverSummaries?.[0]?.articleScores;
    if (!a) return null;
    return a;
  })();

  const closeTldrSelf = () => {
    if (tldrTimerRef.current) {
      clearTimeout(tldrTimerRef.current);
      tldrTimerRef.current = null;
    }
    setTldrOpen(false);
  };
  const openTldr = () => {
    if (tldrTimerRef.current) {
      clearTimeout(tldrTimerRef.current);
      tldrTimerRef.current = null;
    }
    if (activeTldrCloser && activeTldrCloser !== closeTldrSelf) activeTldrCloser();
    activeTldrCloser = closeTldrSelf;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const POPOVER_ESTIMATE = 140;
      const spaceBelow = window.innerHeight - rect.bottom;
      const placeAbove = spaceBelow < POPOVER_ESTIMATE && rect.top > POPOVER_ESTIMATE;
      const left = rect.left + 24;
      const width = Math.max(200, rect.width - 80);
      if (placeAbove) {
        setTldrPos({ bottom: window.innerHeight - rect.top + 4, left, width });
      } else {
        setTldrPos({ top: rect.bottom + 4, left, width });
      }
    }
    setTldrOpen(true);
  };
  const scheduleCloseTldr = () => {
    if (tldrTimerRef.current) clearTimeout(tldrTimerRef.current);
    tldrTimerRef.current = setTimeout(() => {
      setTldrOpen(false);
      tldrTimerRef.current = null;
      if (activeTldrCloser === closeTldrSelf) activeTldrCloser = null;
    }, 120);
  };
  return (
    <div ref={rowRef} className="ruled group relative">
      {hasTldr &&
        tldrOpen &&
        tldrPos &&
        createPortal(
          <div
            className="fixed z-50 glass rounded-xl px-3 py-2"
            style={{ ...tldrPos }}
            onMouseEnter={openTldr}
            onMouseLeave={scheduleCloseTldr}
          >
            <div className="mono text-[9px] uppercase tracking-wider text-ink-4 mb-1">TL;DR</div>
            {(job.tldr ?? []).slice(0, 3).map((line, i) => {
              const newsletterLabels = ["research", "industry", "science"];
              const labelText = job.type === "newsletter" ? newsletterLabels[i] : null;
              return (
                <div key={i} className="text-xs text-ink-2 leading-relaxed flex gap-1.5">
                  {labelText ? (
                    <span className="mono text-[9px] uppercase tracking-wider text-ink-4 shrink-0 w-14 mt-0.5">
                      {labelText}
                    </span>
                  ) : (
                    <span className="text-ink-4 shrink-0">•</span>
                  )}
                  <span>{line}</span>
                </div>
              );
            })}
            {paperBadge && (
              <div className="mt-2 pt-2 border-t border-rule-light flex items-center gap-3 mono text-[10px]">
                {paperBadge.overall != null && (
                  <span className="text-ink-3">
                    <span className="text-ink-4">overall</span>{" "}
                    <span className="text-rust font-bold">{paperBadge.overall}</span>
                    <span className="text-ink-4">/10</span>
                  </span>
                )}
                {paperBadge.level && <span className="text-rust truncate">{paperBadge.level}</span>}
              </div>
            )}
            {articleBadge && (
              <div className="mt-2 pt-2 border-t border-rule-light space-y-1 mono text-[10px]">
                <div className="flex items-center gap-3">
                  <span className="text-ink-3">
                    <span className="text-ink-4">overall</span>{" "}
                    <span className="text-rust font-bold">{articleBadge.overall}</span>
                    <span className="text-ink-4">/10</span>
                  </span>
                  {articleBadge.verdict && <span className="text-rust truncate">{articleBadge.verdict}</span>}
                </div>
                <div className="text-ink-3 flex flex-wrap gap-x-2.5 gap-y-0.5">
                  <span>
                    <span className="text-ink-4">evid</span> {articleBadge.evidence}
                  </span>
                  <span>
                    <span className="text-ink-4">logic</span> {articleBadge.logic}
                  </span>
                  <span>
                    <span className="text-ink-4">obj</span> {articleBadge.objectivity}
                  </span>
                  <span>
                    <span className="text-ink-4">nov</span> {articleBadge.novelty}
                  </span>
                  <span>
                    <span className="text-ink-4">clr</span> {articleBadge.clarity}
                  </span>
                  <span>
                    <span className="text-ink-4">imp</span> {articleBadge.impact}
                  </span>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
      <button
        ref={buttonRef}
        onClick={toggleExpanded}
        className="w-full text-left flex items-center gap-2 px-2 py-2 hover:bg-paper-warm/30 transition-colors min-w-0"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-ink-4 shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-ink-4 shrink-0" />
        )}
        {job.imageId && firstImage && (
          <span className="relative shrink-0">
            <img src={firstImage} alt="" className="h-7 w-7 object-cover rounded border border-rule" />
            {imageCount > 1 && (
              <span className="absolute -bottom-1 -right-1 bg-charcoal text-paper mono text-[8px] leading-none px-1 py-0.5 rounded-full">
                +{imageCount - 1}
              </span>
            )}
          </span>
        )}
        {/* The label sits in a flex-1 truncate wrapper with NO click handler, so
            the empty space to the right of the text falls through to the row
            button (toggles the fold). Only the text itself opens the link /
            content modal. */}
        <span className="flex-1 min-w-0 truncate">
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={hasTldr ? openTldr : undefined}
              onMouseLeave={hasTldr ? scheduleCloseTldr : undefined}
              className="mono text-xs text-rust hover:underline"
            >
              {label}
            </a>
          ) : rowText ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                onContentClick(job._id);
              }}
              onMouseEnter={hasTldr ? openTldr : undefined}
              onMouseLeave={hasTldr ? scheduleCloseTldr : undefined}
              className="mono text-xs text-rust hover:underline cursor-pointer"
            >
              {label}
            </span>
          ) : (
            <span
              onMouseEnter={hasTldr ? openTldr : undefined}
              onMouseLeave={hasTldr ? scheduleCloseTldr : undefined}
              className="mono text-xs text-ink-2"
            >
              {label}
            </span>
          )}
        </span>
        {job.source && (
          <span
            className="mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 text-sage bg-sage/10 shrink-0 rounded-full max-w-[28%] truncate flex items-center gap-1"
            title={`source: ${job.source}`}
          >
            <Rss size={8} />
            {job.source}
          </span>
        )}
        {job.provider && (
          <span className="shrink-0 flex items-center" title={`processed by ${job.provider}`}>
            <AgentIcon provider={job.provider} size={11} />
          </span>
        )}
        <span className="mono text-[9px] text-ink-4 shrink-0">
          {new Date(job.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}
        </span>
        <StatusBadge status={job.status} />
        {job.tldrPending && (
          <span className="mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 text-ochre bg-ochre-dim shrink-0 flex items-center gap-1 rounded-full">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-ochre animate-pulse" />
            TL;DR
          </span>
        )}
        {job.error && <span className="mono text-xs text-rust truncate max-w-[30%]">{job.error}</span>}
      </button>
      <div className="absolute -right-24 top-2 flex gap-0 opacity-0 group-hover:opacity-100 transition-all">
        {onRetry && isTerminalJobStatus(job.status) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetry(job._id);
            }}
            className="p-1 text-ink-4 hover:text-ochre transition-colors"
            title="Re-process"
          >
            <RefreshCw size={12} />
          </button>
        )}
        {onArchive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive(job._id);
            }}
            className="p-1 text-ink-4 hover:text-slate transition-colors"
            title="Archive"
          >
            <Archive size={12} />
          </button>
        )}
        {onUnarchive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUnarchive(job._id);
            }}
            className="p-1 text-ink-4 hover:text-slate transition-colors"
            title="Unarchive"
          >
            <ArchiveRestore size={12} />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(job._id);
            }}
            className="p-1 text-ink-4 hover:text-rust transition-colors"
            title="Delete"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-2 pb-4">
          {job.imageId &&
            (imageUrls === undefined ? (
              <div className="mb-3 h-40 rounded-lg bg-paper-warm/60 animate-pulse" />
            ) : (
              imageCount > 0 && (
                <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                  {imageUrls.map((u, i) => (
                    <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block shrink-0">
                      <img
                        src={u}
                        alt={`screenshot ${i + 1}`}
                        className="max-h-[28rem] w-auto rounded-lg border border-rule"
                      />
                    </a>
                  ))}
                </div>
              )
            ))}
          <StepNav active={viewStep} onSelect={setViewStep} jobStatus={job.status} provider={job.provider} />
          {viewStep === "summary" && <SummaryView jobId={job._id} jobType={job.type} />}
          {viewStep === "suggestion" && <SuggestionView jobId={job._id} />}
          {viewStep === "execution" && <ExecutionView jobId={job._id} />}
        </div>
      )}
    </div>
  );
}
