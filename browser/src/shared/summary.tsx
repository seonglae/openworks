import { useState, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { X, BookOpen, ScrollText, ExternalLink, Loader2, Send } from "lucide-react";
import { Md } from "../components/markdown";
import { AgentIcon } from "../AgentIcons";
import { BlockSkeleton } from "./ui";

// ── Summary View ───────────────────────────────────────────────────────

// Pull an arxiv (or alphaxiv) abs/pdf URL out of a summary so newsletter
// readers can promote a paper into the paper queue with one click. Matches
// the canonical paper-id forms; ignores forum/category landing pages.
const ARXIV_URL_RE = /(https?:\/\/(?:www\.)?(?:arxiv|alphaxiv)\.org\/(?:abs|pdf)\/[\w.\-]+(?:v\d+)?)/i;

function extractArxivUrl(s: { url?: string; summary?: string }): string | null {
  const candidate = s.url?.match(ARXIV_URL_RE) ?? s.summary?.match(ARXIV_URL_RE);
  if (!candidate) return null;
  return candidate[1].replace(/\/pdf\//, "/abs/").replace(/\.pdf$/i, "");
}

// Loose heuristic for non-arxiv research artefacts (lab project pages,
// openreview forums, conference proceedings). The Paper-tab worker
// resolves these to a PDF before summarizing; non-matches fall through
// to the Article promotion.
const PAPER_HOST_RE =
  /^https?:\/\/[^/]*(?:openreview\.net|aclanthology\.org|proceedings\.(?:mlr|neurips|icml|iclr|cvpr|eccv|iccv)\.|papers\.nips\.cc|papers\.cool|semanticscholar\.org|paperswithcode\.com|biorxiv\.org|medrxiv\.org|nature\.com\/articles|science\.org\/doi)/i;
const PAPER_SUBDOMAIN_RE = /^https?:\/\/(?:research|ai|labs?|sites?)\.[^/]+\//i;
const PAPER_PATH_RE = /^https?:\/\/[^/]+\/(?:labs?\/|research\/|publications?\/|papers?\/|projects?\/)/i;

function isPaperUrl(url: string): boolean {
  return PAPER_HOST_RE.test(url) || PAPER_SUBDOMAIN_RE.test(url) || PAPER_PATH_RE.test(url);
}

export function SummaryView({ jobId, jobType }: { jobId: Id<"jobs">; jobType?: string }) {
  const summaries = useQuery(api.summaries.listByJob, { jobId });
  const removeSummary = useMutation(api.summaries.remove);
  const createPaperJob = useMutation(api.jobs.create);
  const [pushedPapers, setPushedPapers] = useState<Set<string>>(new Set());
  const [pushedArticles, setPushedArticles] = useState<Set<string>>(new Set());

  if (!summaries) {
    return <BlockSkeleton rows={5} className="py-4" />;
  }

  if (summaries.length === 0) {
    return <div className="text-ink-3 mono py-8">Waiting for summaries from Claude Code...</div>;
  }

  return (
    <div className="space-y-0">
      {summaries.map((s, i) => (
        <div
          key={s._id}
          className={`${i < summaries.length - 1 ? "ruled" : ""} py-4 anim d${Math.min(i + 1, 6)} group/summary relative`}
        >
          <button
            onClick={() => removeSummary({ summaryId: s._id })}
            className="absolute -right-14 top-4 p-1 text-ink-4 hover:text-rust opacity-0 group-hover/summary:opacity-100 transition-all"
            title="Delete summary"
          >
            <X size={12} />
          </button>
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="mono text-ink-3 text-xs">#{s.index + 1}</span>
            <h3 className="serif text-lg leading-snug flex-1">{s.title}</h3>
            {(() => {
              // Promotion is valid from any job type to any OTHER type;
              // promoting into the queue the item already lives in is not.
              const arxivUrl = extractArxivUrl({ url: s.url, summary: s.summary });
              // Paper promotion priority: arxiv id (canonical) > raw URL
              // that looks like a research / lab / openreview page. The
              // worker resolves the latter to a PDF before summarizing,
              // so a NVIDIA project page or an openreview forum lands in
              // the Paper tab instead of leaking to Article.
              const paperUrl: string | null = arxivUrl ?? (s.url && isPaperUrl(s.url) ? s.url : null);
              if (paperUrl && jobType !== "paper") {
                const pushed = pushedPapers.has(paperUrl);
                return (
                  <button
                    disabled={pushed}
                    onClick={async () => {
                      setPushedPapers((p) => new Set(p).add(paperUrl));
                      try {
                        await createPaperJob({ url: paperUrl, title: s.title, type: "paper" });
                      } catch (err) {
                        setPushedPapers((p) => {
                          const n = new Set(p);
                          n.delete(paperUrl);
                          return n;
                        });
                        throw err;
                      }
                    }}
                    className={`shrink-0 self-center mono text-[10px] tracking-wider px-2 py-0.5 transition-colors flex items-center gap-1 ${
                      pushed ? "text-ink-4 cursor-default" : "text-rust hover:bg-rust-dim"
                    } rounded-full`}
                    title={pushed ? "Queued in Paper tab" : "Queue as paper job (downloads PDF + extracts full text)"}
                  >
                    <BookOpen size={10} />
                    {pushed ? "Queued" : "→ Paper"}
                  </button>
                );
              }
              // Non-paper newsletter items with a canonical URL get promoted
              // into the Article tab — useful for blog posts, release notes,
              // company write-ups that aren't on arxiv. Skip when there's no
              // URL to queue (the URL is the article's content source).
              if (jobType === "article") return null;
              if (!s.url || !/^https?:\/\//i.test(s.url)) return null;
              const pushed = pushedArticles.has(s.url);
              return (
                <button
                  disabled={pushed}
                  onClick={async () => {
                    setPushedArticles((p) => new Set(p).add(s.url));
                    try {
                      await createPaperJob({ url: s.url, title: s.title, type: "article" });
                    } catch (err) {
                      setPushedArticles((p) => {
                        const n = new Set(p);
                        n.delete(s.url);
                        return n;
                      });
                      throw err;
                    }
                  }}
                  className={`shrink-0 self-center mono text-[10px] tracking-wider px-2 py-0.5 transition-colors flex items-center gap-1 ${
                    pushed ? "text-ink-4 cursor-default" : "text-slate hover:bg-slate-dim"
                  } rounded-full`}
                  title={
                    pushed
                      ? "Queued in Article tab"
                      : "Queue as article job (fetches the URL + summarizes the full body)"
                  }
                >
                  <ScrollText size={10} />
                  {pushed ? "Queued" : "→ Article"}
                </button>
              );
            })()}
            {s.provider && (
              <span className="shrink-0 self-center" title={`written by ${s.provider}`}>
                <AgentIcon provider={s.provider} size={12} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="chip text-slate">{s.category}</span>
            {s.keywords.map((kw) => (
              <span key={kw} className="chip">
                {kw}
              </span>
            ))}
          </div>
          <div className="text-ink-2 leading-relaxed mb-2 prose prose-sm max-w-none [&_a]:text-rust [&_h1]:serif [&_h2]:serif [&_h3]:serif">
            <Md>{s.summary}</Md>
          </div>
          <PeerReviewBlock s={s} />
          {s.url && (
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mono text-xs text-rust hover:underline inline-flex items-center gap-1 max-w-full min-w-0 break-all"
            >
              <ExternalLink size={10} className="shrink-0" />
              {s.url.length > 60 ? s.url.slice(0, 60) + "..." : s.url}
            </a>
          )}
        </div>
      ))}
      <FollowupChat jobId={jobId} />
    </div>
  );
}

// ── Peer-review structured block (paper jobs) ─────────────────────────

function ScoreRadar({ axes }: { axes: { label: string; value: number }[] }) {
  // N axes around a regular polygon; score normalized to /10. Pure SVG,
  // no chart lib. Compact so it sits next to the score grid.
  const SIZE = 130;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const R = 44;
  const angleFor = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
  const pointAt = (i: number, r: number) => {
    const a = angleFor(i);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const polyPath = (rs: number[]) => rs.map((r, i) => pointAt(i, r).join(",")).join(" ");
  const grid = [0.25, 0.5, 0.75, 1];
  const scorePoly = polyPath(axes.map((a) => (a.value / 10) * R));
  return (
    <svg width={SIZE} height={SIZE} className="shrink-0" aria-label="score radar">
      {grid.map((g) => (
        <polygon
          key={g}
          points={polyPath(axes.map(() => R * g))}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.5}
          className="text-ink-4 opacity-40"
        />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pointAt(i, R);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-ink-4 opacity-30"
          />
        );
      })}
      <polygon
        points={scorePoly}
        fill="currentColor"
        fillOpacity={0.18}
        stroke="currentColor"
        strokeWidth={1.2}
        className="text-rust"
      />
      {axes.map((a, i) => {
        const [x, y] = pointAt(i, R + 10);
        return (
          <text
            key={a.label}
            x={x}
            y={y}
            fontSize={8}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-ink-3 mono"
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}

function PeerReviewBlock({ s }: { s: Doc<"summaries"> }) {
  if (!s.researchLevel && !s.scores && !s.articleScores && !s.priorWork && !s.reasoning) return null;
  const scores = s.scores;
  const aScores = s.articleScores;
  return (
    <div className="mt-2 mb-3 border-t border-rule-light pt-2 space-y-2">
      {s.researchLevel && (
        <div className="flex items-baseline gap-2">
          <span className="mono text-[10px] tracking-wider text-ink-4">Research Level</span>
          <span className="mono text-xs text-rust">{s.researchLevel}</span>
        </div>
      )}
      {aScores?.verdict && (
        <div className="flex items-baseline gap-2">
          <span className="mono text-[10px] tracking-wider text-ink-4">Verdict</span>
          <span className="mono text-xs text-rust">{aScores.verdict}</span>
        </div>
      )}
      {scores && (
        <div className="flex items-start gap-3">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[11px] text-ink-3 flex-1">
            <span>
              <span className="text-ink-4">Soundness</span> {scores.soundness}
            </span>
            <span>
              <span className="text-ink-4">Originality</span> {scores.originality}
            </span>
            <span>
              <span className="text-ink-4">Experiments</span> {scores.experiments}
            </span>
            <span>
              <span className="text-ink-4">Clarity</span> {scores.clarity}
            </span>
            <span>
              <span className="text-ink-4">Impact</span> {scores.impact}
            </span>
            <span>
              <span className="text-ink-4">Significance</span> {scores.significance}
            </span>
            <span className="text-ink-2">
              <span className="text-ink-4">Overall</span> <b>{scores.overall}</b>
            </span>
            {typeof scores.confidence === "number" && (
              <span>
                <span className="text-ink-4">Conf</span> {scores.confidence}
              </span>
            )}
          </div>
          <ScoreRadar
            axes={[
              { label: "Sound", value: scores.soundness },
              { label: "Orig", value: scores.originality },
              { label: "Exp", value: scores.experiments },
              { label: "Clr", value: scores.clarity },
              { label: "Imp", value: scores.impact },
              { label: "Sig", value: scores.significance },
            ]}
          />
        </div>
      )}
      {aScores && (
        <div className="flex items-start gap-3">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[11px] text-ink-3 flex-1">
            <span>
              <span className="text-ink-4">Evidence</span> {aScores.evidence}
            </span>
            <span>
              <span className="text-ink-4">Logic</span> {aScores.logic}
            </span>
            <span>
              <span className="text-ink-4">Objectivity</span> {aScores.objectivity}
            </span>
            <span>
              <span className="text-ink-4">Novelty</span> {aScores.novelty}
            </span>
            <span>
              <span className="text-ink-4">Clarity</span> {aScores.clarity}
            </span>
            <span>
              <span className="text-ink-4">Impact</span> {aScores.impact}
            </span>
            <span className="text-ink-2">
              <span className="text-ink-4">Overall</span> <b>{aScores.overall}</b>
            </span>
          </div>
          <ScoreRadar
            axes={[
              { label: "Evid", value: aScores.evidence },
              { label: "Logic", value: aScores.logic },
              { label: "Obj", value: aScores.objectivity },
              { label: "Nov", value: aScores.novelty },
              { label: "Clr", value: aScores.clarity },
              { label: "Imp", value: aScores.impact },
            ]}
          />
        </div>
      )}
      {s.priorWork && s.priorWork.length > 0 && (
        <div>
          <div className="mono text-[10px] tracking-wider text-ink-4 mb-1">Prior work</div>
          <ul className="space-y-0.5">
            {s.priorWork.map((p, i) => (
              <li key={i} className="text-xs text-ink-2">
                <span className="text-ink-2">{p.citation}</span>
                <span className="text-ink-4"> — {p.relation}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.reasoning && (
        <div>
          <div className="mono text-[10px] tracking-wider text-ink-4 mb-1">Reasoning</div>
          <div className="text-xs text-ink-2 leading-relaxed">{s.reasoning}</div>
        </div>
      )}
    </div>
  );
}

// ── Followup Chat ─────────────────────────────────────────────────────

export function FollowupChat({ jobId }: { jobId: Id<"jobs"> }) {
  const chats = useQuery(api.chats.listByJob, { jobId });
  const sendChat = useMutation(api.chats.send);
  const [input, setInput] = useState("");
  const [showAll, setShowAll] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Intentionally no auto-scroll on new chat message. User said the
  // page jump on every new question / async agent reply was disruptive
  // when they were reading the paper unfold above. They can scroll
  // manually if they want to see the latest message.

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    sendChat({ jobId, content: trimmed });
    setInput("");
  };

  const waiting = chats && chats.length > 0 && chats[chats.length - 1].role === "user";
  const VISIBLE_COUNT = 4;
  const hasHidden = chats && chats.length > VISIBLE_COUNT && !showAll;
  const visibleChats = hasHidden ? chats.slice(-VISIBLE_COUNT) : chats;

  return (
    <div className="mt-4 pt-4 ruled-top">
      {chats && chats.length > 0 && (
        <div className="space-y-3 mb-4">
          {hasHidden && (
            <button
              onClick={() => setShowAll(true)}
              className="mono text-[10px] text-ink-4 hover:text-ink-3 transition-colors"
            >
              Show {chats.length - VISIBLE_COUNT} earlier messages
            </button>
          )}
          {(visibleChats || []).map((c) => (
            <div
              key={c._id}
              className={`flex ${c.role === "user" ? "justify-end" : "justify-start"} items-start gap-1.5`}
            >
              {c.role === "assistant" && c.provider && (
                <span className="shrink-0 mt-2.5" title={`reply by ${c.provider}`}>
                  <AgentIcon provider={c.provider} size={12} />
                </span>
              )}
              <div
                className={`max-w-[85%] px-3 py-2 text-sm ${
                  c.role === "user"
                    ? "bg-paper-warm text-ink-2 mono"
                    : "prose prose-sm max-w-none text-ink-2 [&_a]:text-rust"
                }`}
              >
                {c.role === "assistant" ? <Md>{c.content}</Md> : c.content}
              </div>
            </div>
          ))}
          {waiting && (
            <div className="flex items-center gap-2 text-ink-3 mono text-xs">
              <Loader2 size={12} className="animate-spin" />
              thinking...
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
      <form onSubmit={handleSend} className="flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend(e);
            }
          }}
          rows={1}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 120) + "px";
          }}
          placeholder={waiting ? "Waiting for response..." : "Ask a followup question... (Shift+Enter for newline)"}
          className="flex-1 bg-transparent outline-none text-ink placeholder:text-ink-4 mono text-xs py-1.5 border-b border-rule-light focus:border-rust transition-colors resize-none overflow-hidden"
        />
        <button
          type="submit"
          disabled={!input.trim() || waiting === true}
          className="p-1.5 text-ink-3 hover:text-rust disabled:opacity-30 transition-colors"
        >
          <Send size={12} />
        </button>
      </form>
    </div>
  );
}
