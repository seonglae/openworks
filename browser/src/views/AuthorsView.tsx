import { useState } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ChevronRight } from "lucide-react";
import type { Mode } from "../shared/types";
import { useInfiniteScroll } from "../shared/hooks";
import { OFFSCREEN_SKIP, PaginationFooter, isModifiedClick } from "../shared/ui";

type LeaderPosition = "first" | "last" | "all";
type LeaderMetric = "score" | "count";

const LEADER_POSITIONS: { key: LeaderPosition; label: string; hint: string }[] = [
  { key: "first", label: "1st author", hint: "papers where this researcher is first author" },
  { key: "last", label: "corresponding", hint: "papers where this researcher is last author" },
  { key: "all", label: "any author", hint: "every paper the researcher appears on" },
];

const LEADER_METRICS: { key: LeaderMetric; label: string; hint: string }[] = [
  { key: "score", label: "score", hint: "shrunk mean of the paper scores, so one lucky paper cannot top the list" },
  { key: "count", label: "count", hint: "number of distinct papers" },
];

const AUTHORS_PAGE = 25;

// Papers and Authors are two views of the same corpus, so Authors lives under
// the Paper tab rather than taking a sidebar slot of its own. Both are URL
// states, which keeps deep links and modifier-clicks working.
export function PaperSubNav({ active, hrefFor }: { active: "paper" | "authors"; hrefFor: (m: Mode) => string }) {
  return (
    <div className="flex items-center gap-1 mb-3">
      {(["paper", "authors"] as const).map((k) => (
        <a
          key={k}
          href={hrefFor(k)}
          onClick={(e) => {
            if (isModifiedClick(e)) return;
            e.preventDefault();
            window.history.pushState(null, "", hrefFor(k));
            window.dispatchEvent(new PopStateEvent("popstate"));
          }}
          className={`mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors ${
            active === k ? "droplet text-rust" : "text-ink-4 hover:text-ink-3"
          }`}
        >
          {k === "paper" ? "papers" : "authors"}
        </a>
      ))}
    </div>
  );
}

// Papers behind one leaderboard row. Mounted only once the row is unfolded, so
// the leaderboard itself never carries them.
function AuthorPapers({ authorId }: { authorId: string }) {
  const {
    results: papers,
    status,
    loadMore,
  } = usePaginatedQuery(api.authors.papersByAuthor, { authorId }, { initialNumItems: 10 });
  const ref = useInfiniteScroll(status, loadMore, 10);
  return (
    <div className="pl-6 pb-3 space-y-1">
      {papers.map((p) => (
        <div key={p.jobId} className="flex items-baseline gap-2 text-[12px]">
          <span className="mono text-[9px] uppercase tracking-wider text-ink-4 w-12 shrink-0">{p.position}</span>
          {p.url ? (
            <a href={p.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 text-rust hover:underline">
              {p.title}
            </a>
          ) : (
            <span className="flex-1 min-w-0 text-ink-2">{p.title}</span>
          )}
          {p.archived && <span className="mono text-[9px] uppercase tracking-wider text-ink-4">archived</span>}
          {p.overall !== undefined && <span className="mono text-[10px] text-rust shrink-0">{p.overall}</span>}
        </div>
      ))}
      <div ref={ref} className="mono text-[9px] uppercase tracking-wider text-ink-4 pt-1">
        {status === "LoadingFirstPage" || status === "LoadingMore" ? "loading…" : ""}
      </div>
    </div>
  );
}

export function AuthorsView({ subNav }: { subNav?: React.ReactNode }) {
  const [position, setPosition] = useState<LeaderPosition>("first");
  const [metric, setMetric] = useState<LeaderMetric>("score");
  const [openId, setOpenId] = useState<string | null>(null);
  const {
    results: rows,
    status,
    loadMore,
  } = usePaginatedQuery(api.authors.leaderboard, { position, metric }, { initialNumItems: AUTHORS_PAGE });
  const sentinelRef = useInfiniteScroll(status, loadMore, AUTHORS_PAGE);
  const progress = useQuery(api.authors.resolveProgress, {});
  const startSweep = useMutation(api.authors.startResolveSweep);

  // The displayed number always matches the axis being ranked.
  const value = (r: (typeof rows)[number]) => {
    if (metric === "count") {
      return position === "first" ? r.firstCount : position === "last" ? r.lastCount : r.paperCount;
    }
    return position === "first" ? r.scoreFirst : position === "last" ? r.scoreLast : r.scoreAll;
  };
  const scoredOf = (r: (typeof rows)[number]) =>
    position === "first" ? r.scoredFirst : position === "last" ? r.scoredLast : r.scoredAll;
  const rawOf = (r: (typeof rows)[number]) =>
    position === "first" ? r.rawFirst : position === "last" ? r.rawLast : r.rawAll;

  // Two rows can carry the same name and still be different OpenAlex entities
  // (either genuine namesakes or one researcher OpenAlex has not merged). Tag
  // them with their entity id so a repeated name never reads as a bug.
  const nameCounts = new Map<string, number>();
  for (const r of rows) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);

  return (
    <div className="panel anim d2">
      {subNav}
      <div className="flex flex-wrap items-center gap-1 mb-3">
        {LEADER_POSITIONS.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setPosition(m.key);
              setOpenId(null);
            }}
            title={m.hint}
            className={`mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors ${
              position === m.key ? "droplet text-rust" : "text-ink-4 hover:text-ink-3"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="mx-1 text-ink-4">·</span>
        {LEADER_METRICS.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setMetric(m.key);
              setOpenId(null);
            }}
            title={m.hint}
            className={`mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors ${
              metric === m.key ? "droplet text-rust" : "text-ink-4 hover:text-ink-3"
            }`}
          >
            {m.label}
          </button>
        ))}
        {progress && progress.pending > 0 && (
          <button
            onClick={() => void startSweep({})}
            className="mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust ml-auto"
          >
            resolve {progress.pending} pending
          </button>
        )}
      </div>

      <div className="flex flex-col divide-y divide-rule-light">
        {rows.map((r, i) => {
          const open = openId === r.authorId;
          return (
            <div key={r.authorId} className={open ? undefined : OFFSCREEN_SKIP}>
              <button
                onClick={() => setOpenId(open ? null : r.authorId)}
                className="w-full flex items-center gap-2 text-left py-2"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 text-ink-4 transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span className="mono text-[10px] text-ink-4 w-6 shrink-0 text-right">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate text-[13px] text-ink">
                  {r.name}
                  {(nameCounts.get(r.name) ?? 0) > 1 && (
                    <span className="mono text-[9px] text-ink-4 ml-1.5" title="a different OpenAlex author entity">
                      {r.authorId}
                    </span>
                  )}
                </span>
                {r.institution && (
                  <span className="mono text-[9px] text-ink-4 truncate max-w-[28%] hidden sm:inline">
                    {r.institution}
                  </span>
                )}
                <span className="mono text-xs text-rust shrink-0 w-10 text-right">
                  {metric === "score" ? value(r).toFixed(2) : value(r)}
                </span>
              </button>
              {open && (
                <>
                  <div className="pl-6 pb-1 mono text-[10px] text-ink-4 flex flex-wrap gap-x-3">
                    <span>1st {r.firstCount}</span>
                    <span>corresponding {r.lastCount}</span>
                    <span>total {r.paperCount}</span>
                    {scoredOf(r) > 0 && (
                      <span>
                        score{" "}
                        {(position === "first" ? r.scoreFirst : position === "last" ? r.scoreLast : r.scoreAll).toFixed(
                          2,
                        )}{" "}
                        (mean {rawOf(r).toFixed(2)} of {scoredOf(r)})
                      </span>
                    )}
                    {r.orcid && (
                      <a href={r.orcid} target="_blank" rel="noreferrer" className="text-rust hover:underline">
                        ORCID
                      </a>
                    )}
                  </div>
                  <AuthorPapers authorId={r.authorId} />
                </>
              )}
            </div>
          );
        })}
        {rows.length === 0 && status !== "LoadingFirstPage" && (
          <div className="mono text-[12px] text-ink-4 py-10 text-center">
            No authors yet — process a paper and they resolve automatically.
          </div>
        )}
      </div>

      <PaginationFooter status={status} count={rows.length} sentinelRef={sentinelRef} />
      <p className="mono text-[9px] text-ink-4 leading-relaxed">
        Identities are OpenAlex author entities, not names, so researchers who share a name stay separate. Authors
        OpenAlex has no entity for are left off these rankings rather than merged by name.
      </p>
    </div>
  );
}
