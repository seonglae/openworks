import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { BookOpen, ChevronDown, ChevronRight, X } from "lucide-react";
import { CommentsThread } from "../CommentsThread";
import { CitationsPanel, HostSetup } from "../CitationsPanel";
import { SummaryView, FollowupChat } from "../shared/summary";
import { type ResearchKind } from "@openworks/domain";
import { OWN_EDGES, OWN_NODES, REVIEW_EDGES, REVIEW_NODES, type FsmEdge, type FsmNode } from "../shared/fsmGraph";

export function ResearchView({ focusSlug }: { focusSlug?: string | null }) {
  const [kind, setKind] = useState<ResearchKind>("own");
  const projects = useQuery(api.research.listByKind, { kind });
  // A `?research=<slug>` link has to survive landing on the wrong board: a
  // review project is not in the `own` list at all, so the kind is read from
  // the project rather than assumed to be whichever board is showing.
  const focusInfo = useQuery(api.research.getStateInfo, focusSlug ? { slug: focusSlug } : "skip");
  useEffect(() => {
    if (focusInfo?.kind) setKind(focusInfo.kind as ResearchKind);
  }, [focusInfo?.kind]);
  const upsert = useMutation(api.research.upsert);
  const updatePhase = useMutation(api.research.updatePhase);
  const removeMutation = useMutation(api.research.remove);
  // The delete cascades and is bounded per call, so it reports `done` and the
  // caller loops. Confirm first: this hard-deletes the project's memos,
  // sections, tex, papers, experiments and comments, and there is no undo.
  const remove = async (id: Id<"researchProjects">, title: string) => {
    if (!window.confirm(`Delete "${title}" and everything in it? This cannot be undone.`)) return;
    // Bounded so one very large project cannot exceed a transaction; the guard
    // stops a bug in the mutation from spinning forever.
    for (let pass = 0; pass < 200; pass++) {
      const res = await removeMutation({ id });
      if (res.done) return;
    }
  };
  const requestPhaseInferAll = useMutation(api.researchPhaseInfer.requestAll);
  const [newSlug, setNewSlug] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newVenue, setNewVenue] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(focusSlug ?? null);
  useEffect(() => {
    if (focusSlug) setSelectedSlug(focusSlug);
  }, [focusSlug]);
  const selectedTimeline = useQuery(
    api.research.getTimeline,
    selectedSlug ? { slug: selectedSlug, limit: 200 } : "skip",
  );
  // Visited states in chronological order (oldest → newest). getTimeline
  // returns desc, so reverse.
  const visitedStates: string[] = selectedTimeline ? [...selectedTimeline].reverse().map((t) => t.state) : [];

  const nodes = kind === "own" ? OWN_NODES : REVIEW_NODES;
  const edges = kind === "own" ? OWN_EDGES : REVIEW_EDGES;

  const width = Math.max(...nodes.map((n) => n.x)) + 200;
  const height = Math.max(...nodes.map((n) => n.y)) + 80;

  const byPhase = new Map<string, typeof projects>();
  for (const p of projects ?? []) {
    const list = byPhase.get(p.phase) ?? [];
    list.push(p);
    byPhase.set(p.phase, list as typeof projects);
  }

  const addProject = async () => {
    if (!newSlug.trim() || !newTitle.trim()) return;
    await upsert({
      slug: newSlug.trim(),
      title: newTitle.trim(),
      kind,
      phase: nodes[0].id,
      venue: newVenue.trim() || undefined,
    });
    setNewSlug("");
    setNewTitle("");
    setNewVenue("");
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-rule-light">
        <button
          onClick={() => setKind("own")}
          className={`mono text-xs px-2 py-1 transition-colors ${kind === "own" ? "text-rust" : "text-ink-3 hover:text-ink"} rounded-full`}
        >
          My Research
        </button>
        <button
          onClick={() => setKind("review")}
          className={`mono text-xs px-2 py-1 transition-colors ${kind === "review" ? "text-rust" : "text-ink-3 hover:text-ink"} rounded-full`}
        >
          Reviews
        </button>
        <button
          onClick={async () => {
            const r = await requestPhaseInferAll({ kind });
            console.log(`queued ${r.queued} phase-infer runs`);
          }}
          className="ml-auto mono text-[10px] uppercase tracking-wider px-2 py-0.5 text-ink-4 hover:text-rust transition-colors rounded-full"
          title="Spawn one subagent per project: analyses folder + git log and rewrites phase + timeline"
        >
          infer phases all
        </button>
      </div>

      <div
        style={{ marginLeft: "calc(50% - 50vw)", marginRight: "calc(50% - 50vw)" }}
        className="mb-6 flex justify-center"
      >
        <div
          className="panel"
          style={{ width: "min(calc(100vw - 2rem - env(safe-area-inset-left) - env(safe-area-inset-right)), 60rem)" }}
        >
          <FsmGraph
            nodes={nodes}
            edges={edges}
            width={width}
            height={height}
            byPhase={byPhase}
            storageKey={`fsm-positions-${kind}-v2`}
            visitedStates={visitedStates}
            selectedSlug={selectedSlug}
            onNodeClick={(projectId, nodeId) => {
              if (projectId) updatePhase({ id: projectId, phase: nodeId });
            }}
          />
        </div>
      </div>

      <div className="panel anim d2">
        <div className="mb-4 p-3 border border-rule-light rounded bg-paper-warm/20">
          <div className="flex gap-2 items-center flex-wrap">
            <input
              type="text"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="slug"
              className="mono text-xs px-2 py-1 bg-transparent border-b border-rule-light outline-none focus:border-rust w-[120px]"
            />
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="title"
              className="mono text-xs px-2 py-1 bg-transparent border-b border-rule-light outline-none focus:border-rust flex-1 min-w-[200px]"
            />
            <input
              type="text"
              value={newVenue}
              onChange={(e) => setNewVenue(e.target.value)}
              placeholder="venue"
              className="mono text-xs px-2 py-1 bg-transparent border-b border-rule-light outline-none focus:border-rust w-[140px]"
            />
            <button
              onClick={addProject}
              disabled={!newSlug.trim() || !newTitle.trim()}
              className="droplet mono text-xs px-3 py-1 text-rust hover:brightness-105 disabled:opacity-30 transition-all rounded-full"
            >
              register
            </button>
          </div>
        </div>

        <div className="space-y-1">
          {(projects ?? []).map((p) => (
            <ResearchRow
              key={p._id}
              project={p}
              nodes={nodes}
              selected={selectedSlug === p.slug}
              focused={focusSlug === p.slug}
              onSelect={() => setSelectedSlug((cur) => (cur === p.slug ? null : p.slug))}
              updatePhase={(id, phase) => updatePhase({ id, phase })}
              remove={(id) => remove(id, p.title)}
              updateKeywords={(_id, keywords) =>
                upsert({
                  slug: p.slug,
                  title: p.title,
                  kind: p.kind,
                  phase: p.phase,
                  venue: p.venue,
                  deadline: p.deadline,
                  notes: p.notes,
                  keywords,
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ResearchRow({
  project,
  nodes,
  selected,
  focused,
  onSelect,
  updatePhase,
  remove,
  updateKeywords,
}: {
  project: Doc<"researchProjects">;
  nodes: FsmNode[];
  selected?: boolean;
  focused?: boolean;
  onSelect?: () => void;
  updatePhase: (id: Id<"researchProjects">, phase: string) => void;
  remove: (id: Id<"researchProjects">) => void;
  updateKeywords: (id: Id<"researchProjects">, keywords: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(Boolean(focused));
  // A link that only highlights a row the reader still has to find has not
  // arrived anywhere. The board runs past a screen, so the row is scrolled to
  // as well as opened.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  const [editingKeywords, setEditingKeywords] = useState(false);
  const [keywordInput, setKeywordInput] = useState((project.keywords ?? []).join(", "));
  const setVisibility = useMutation(api.research.setVisibility);
  const upsertResearch = useMutation(api.research.upsert);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(project.title);
  const commitTitle = async () => {
    const next = titleInput.trim();
    if (!next || next === project.title) {
      setEditingTitle(false);
      setTitleInput(project.title);
      return;
    }
    await upsertResearch({
      slug: project.slug,
      title: next,
      kind: project.kind,
      phase: project.phase,
      venue: project.venue,
      deadline: project.deadline,
      notes: project.notes,
      keywords: project.keywords,
    });
    setEditingTitle(false);
  };
  const [selectedJobId, setSelectedJobId] = useState<Id<"jobs"> | null>(null);
  const selectedJob = useQuery(api.jobs.getById, selectedJobId ? { jobId: selectedJobId } : "skip");
  useEffect(() => {
    if (!selectedJobId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedJobId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedJobId]);
  const findRelated = useAction(api.embeddings.findRelatedForResearch);
  // Derived from the action rather than restated here. The hand-written copy
  // had drifted: it was missing `type`, so the badge filter below could not
  // typecheck against a field the action has always returned.
  const [vectorResults, setVectorResults] = useState<FunctionReturnType<
    typeof api.embeddings.findRelatedForResearch
  > | null>(null);
  useEffect(() => {
    if (!expanded) return;
    findRelated({ researchId: project._id, limit: 10 })
      .then(setVectorResults)
      .catch(() => setVectorResults(null));
  }, [expanded, project._id, findRelated]);
  // Fallback: jaccard if no embedding yet
  const relatedJobsFallback = useQuery(
    api.research.getRelatedJobs,
    expanded && vectorResults && vectorResults.summaries.length === 0 ? { researchId: project._id, limit: 10 } : "skip",
  );
  const relatedPlansFallback = useQuery(
    api.research.getRelatedPlanItems,
    expanded && vectorResults && vectorResults.planItems.length === 0 ? { researchId: project._id, limit: 10 } : "skip",
  );
  const relatedJobs = vectorResults?.summaries.length ? vectorResults.summaries : relatedJobsFallback;
  const relatedPlans = vectorResults?.planItems.length ? vectorResults.planItems : relatedPlansFallback;
  const usingEmbedding = (vectorResults?.summaries.length ?? 0) > 0;
  const fileSummary = useQuery(api.researchFiles.summary, expanded ? { researchSlug: project.slug } : "skip");
  const arxivPapers = useQuery(api.researchPapers.listByResearch, expanded ? { researchSlug: project.slug } : "skip");
  // Map arxiv id -> registered paper job, so an arxiv paper that also lives in
  // the Paper tab opens the shared summary+chat modal on click.
  const paperRefs = useQuery(api.jobs.listPaperRefs, expanded ? {} : "skip");
  const paperJobByArxiv = useMemo(() => {
    const m = new Map<string, Id<"jobs">>();
    for (const p of paperRefs ?? []) {
      const hit = (p.url ?? "").match(/(\d{4}\.\d{4,5})/);
      if (hit) m.set(hit[1], p.jobId as Id<"jobs">);
    }
    return m;
  }, [paperRefs]);
  const timeline = useQuery(api.research.getTimeline, expanded ? { slug: project.slug, limit: 30 } : "skip");

  return (
    <div ref={rowRef} className="border-b border-rule-light last:border-b-0">
      <div
        className={`group flex items-center gap-3 py-1.5 px-2 rounded cursor-pointer transition-colors ${
          selected ? "bg-rust/10 ring-1 ring-rust/40" : "hover:bg-paper-warm/30"
        }`}
        onClick={(e) => {
          // Don't fire select on internal control clicks
          const target = e.target as HTMLElement;
          if (target.closest("button, select, input, textarea, a")) return;
          onSelect?.();
        }}
      >
        <button onClick={() => setExpanded(!expanded)} className="text-ink-4 hover:text-ink-2 transition-colors">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="mono text-xs text-ink-3 w-[120px] shrink-0">{project.slug}</span>
        {editingTitle ? (
          <input
            autoFocus
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              else if (e.key === "Escape") {
                setEditingTitle(false);
                setTitleInput(project.title);
              }
            }}
            className="text-sm text-ink flex-1 bg-paper-warm/40 border border-rust/40 px-1 outline-none"
          />
        ) : (
          <span
            className="text-sm text-ink flex-1 truncate cursor-text"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setTitleInput(project.title);
              setEditingTitle(true);
            }}
            title="Double-click to edit"
          >
            {project.title}
          </span>
        )}
        {project.venue && <span className="mono text-[10px] text-ink-4">{project.venue}</span>}
        <select
          value={project.phase}
          onChange={(e) => updatePhase(project._id, e.target.value)}
          className="mono text-[10px] text-ink-2 bg-paper-warm px-1.5 py-0.5 rounded border-0 outline-none"
        >
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void remove(project._id);
          }}
          className="text-ink-4 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
          title="Delete project"
        >
          <X size={10} />
        </button>
      </div>
      {expanded && (
        <div className="pl-8 pb-3 space-y-3">
          <div>
            <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5 flex items-center gap-2">
              <span>keywords</span>
              <button onClick={() => setEditingKeywords(!editingKeywords)} className="text-ink-4 hover:text-ink-2">
                {editingKeywords ? "cancel" : "edit"}
              </button>
            </div>
            {editingKeywords ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  placeholder="comma, separated, keywords"
                  className="mono text-xs flex-1 px-2 py-1 bg-transparent border-b border-rule-light outline-none focus:border-rust"
                />
                <button
                  onClick={() => {
                    updateKeywords(
                      project._id,
                      keywordInput
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    );
                    setEditingKeywords(false);
                  }}
                  className="droplet mono text-xs px-2 py-1 text-rust hover:brightness-105 rounded-full"
                >
                  save
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {(project.keywords ?? []).length === 0 ? (
                  <span className="mono text-[10px] text-ink-4 italic">none</span>
                ) : (
                  (project.keywords ?? []).map((k) => (
                    <span key={k} className="mono text-[10px] text-ink-3 bg-paper-warm px-1.5 py-0.5 rounded">
                      {k}
                    </span>
                  ))
                )}
              </div>
            )}
          </div>

          {timeline && timeline.length > 0 && (
            <div>
              <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5">timeline</div>
              <div className="space-y-0.5 max-h-48 overflow-y-auto">
                {timeline.map((t) => (
                  <div key={t._id} className="flex items-center gap-2 text-[11px]">
                    <span className="mono text-[10px] text-ink-4 w-[110px] shrink-0">
                      {new Date(t.at).toLocaleString(undefined, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="mono text-[10px] text-rust w-[140px] shrink-0 truncate">{t.state}</span>
                    {t.actor && (
                      <span className="mono text-[10px] text-ink-4 w-[70px] shrink-0 truncate">{t.actor}</span>
                    )}
                    <span className="text-ink-2 flex-1 truncate" title={t.note ?? ""}>
                      {t.note ?? ""}
                      {t.artifactRef && <span className="text-ink-4"> · {t.artifactRef}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {fileSummary && (
            <div>
              <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5">
                files ({fileSummary.total})
              </div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(fileSummary.byType).map(([t, n]) => (
                  <span key={t} className="mono text-[10px] text-ink-3 bg-paper-warm px-1.5 py-0.5 rounded">
                    {t} {n}
                  </span>
                ))}
              </div>
            </div>
          )}

          {arxivPapers && arxivPapers.length > 0 && (
            <div>
              <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5">
                arxiv papers ({arxivPapers.length})
              </div>
              <div className="space-y-0.5">
                {arxivPapers.slice(0, 10).map((p) => {
                  const matchedJobId = p.arxivId ? paperJobByArxiv.get(p.arxivId) : undefined;
                  const arxivLink = p.arxivId && (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="mono text-[11px] text-rust w-[80px] truncate"
                    >
                      {p.arxivId}
                    </a>
                  );
                  if (matchedJobId) {
                    return (
                      <button
                        key={p._id}
                        onClick={() => setSelectedJobId(matchedJobId)}
                        className="flex items-center gap-2 text-sm w-full text-left hover:bg-paper-warm/30 rounded px-1 py-0.5 transition-colors"
                        title="Open paper summary"
                      >
                        {arxivLink}
                        <span className="text-ink flex-1 truncate">{p.title}</span>
                        <BookOpen size={12} className="text-rust shrink-0" />
                      </button>
                    );
                  }
                  return (
                    <div key={p._id} className="flex items-center gap-2 text-sm px-1 py-0.5">
                      {arxivLink}
                      <span className="text-ink flex-1 truncate">{p.title}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <HostSetup researchSlug={project.slug} />
          <CitationsPanel researchSlug={project.slug} />

          <div>
            <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5">
              related ({relatedJobs?.filter((rj) => rj.type === "paper" || rj.type === "article").length ?? "..."})
            </div>
            {relatedJobs && relatedJobs.length === 0 ? (
              <div className="mono text-[10px] text-ink-4 italic">no matches — add keywords to find papers</div>
            ) : (
              <div className="space-y-0.5">
                {relatedJobs
                  ?.filter(
                    (rj) => (rj.type === "paper" || rj.type === "article") && rj.score > (usingEmbedding ? 0.25 : 0.02),
                  )
                  .map((rj) => (
                    <button
                      key={rj.jobId}
                      onClick={() => setSelectedJobId(rj.jobId as Id<"jobs">)}
                      className="flex items-center gap-2 text-sm w-full text-left hover:bg-paper-warm/30 rounded px-1 py-0.5 transition-colors"
                    >
                      <span className="mono text-[11px] text-ink-3 w-[40px]">{(rj.score * 100).toFixed(0)}%</span>
                      <span
                        className={`mono text-[10px] uppercase tracking-wider w-[60px] shrink-0 ${
                          rj.type === "paper" ? "text-rust" : "text-ink-3"
                        }`}
                      >
                        {rj.type ?? "—"}
                      </span>
                      <span className="text-ink flex-1 truncate">{rj.title}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          <div>
            <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5">
              related plan items (
              {relatedPlans?.filter((rp) => rp.score > (usingEmbedding ? 0.25 : 0.02)).length ?? "..."})
            </div>
            {relatedPlans && relatedPlans.filter((rp) => rp.score > (usingEmbedding ? 0.25 : 0.02)).length === 0 ? (
              <div className="mono text-[10px] text-ink-4 italic">none</div>
            ) : (
              <div className="space-y-0.5">
                {relatedPlans
                  ?.filter((rp) => rp.score > (usingEmbedding ? 0.25 : 0.02))
                  .map((rp) => (
                    <div key={rp.itemId} className="flex items-center gap-2 text-sm">
                      <span className="mono text-[11px] text-ink-3 w-[40px]">{(rp.score * 100).toFixed(0)}%</span>
                      <span className="mono text-[11px] text-ink-3 w-[80px]">{rp.date}</span>
                      <span className="text-ink flex-1 truncate">{rp.title}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
          <div>
            <div className="mono text-xs font-bold text-ink-2 uppercase tracking-wide mb-1.5">visibility</div>
            <div className="flex items-center gap-2">
              <select
                value={project.visibility ?? "private"}
                onChange={(e) =>
                  setVisibility({
                    id: project._id,
                    visibility: e.target.value as "private" | "workspace" | "unlisted" | "public",
                  })
                }
                className="mono text-xs text-ink-2 bg-paper-warm/60 hover:bg-paper-warm px-2.5 py-1.5 rounded-lg border border-rule-light outline-none focus:border-rust transition-colors cursor-pointer"
              >
                <option value="private">private — owner + members only</option>
                <option value="workspace">workspace — workspace members</option>
                <option value="unlisted">unlisted — anyone with link</option>
                <option value="public">public — anyone</option>
              </select>
              {(project.visibility === "public" || project.visibility === "unlisted") && (
                <span className="mono text-[10px] text-ink-4 truncate">
                  share: {window.location.origin}/?research={project.slug}
                </span>
              )}
            </div>
          </div>
          <CommentsThread researchSlug={project.slug} targetType="research" targetKey={project.slug} />
        </div>
      )}
      {selectedJobId && selectedJob && (
        <div
          className="fixed inset-0 bg-black/15 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedJobId(null)}
        >
          <div
            className="glass-strong rounded-2xl max-w-3xl w-full max-h-[80vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3 sticky top-0">
              <div>
                <div className="mono text-[10px] text-ink-4">{selectedJob.type ?? "newsletter"}</div>
                <h3 className="font-serif text-lg text-ink">{selectedJob.title || "(no title)"}</h3>
                {selectedJob.url && (
                  <a
                    href={selectedJob.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mono text-[10px] text-rust hover:underline"
                  >
                    {selectedJob.url}
                  </a>
                )}
              </div>
              <button onClick={() => setSelectedJobId(null)} className="text-ink-3 hover:text-ink">
                <X size={14} />
              </button>
            </div>
            <SummaryView jobId={selectedJobId} jobType={selectedJob.type} />
            <FollowupChat jobId={selectedJobId} />
          </div>
        </div>
      )}
    </div>
  );
}

function FsmGraph({
  nodes: initialNodes,
  edges,
  width,
  height,
  byPhase,
  storageKey,
  visitedStates,
}: {
  nodes: FsmNode[];
  edges: FsmEdge[];
  width: number;
  height: number;
  byPhase: Map<string, Doc<"researchProjects">[] | undefined>;
  storageKey: string;
  visitedStates?: string[];
  selectedSlug?: string | null;
  onNodeClick: (projectId: Id<"researchProjects"> | null, nodeId: string) => void;
}) {
  const NODE_W = 140;
  const NODE_H = 36;

  const loadPositions = (nodes: FsmNode[], key: string): Record<string, { x: number; y: number }> => {
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, { x: number; y: number }>;
        const result: Record<string, { x: number; y: number }> = {};
        for (const n of nodes) {
          result[n.id] = parsed[n.id] ?? { x: n.x, y: n.y };
        }
        return result;
      }
    } catch {}
    return Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  };

  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() =>
    loadPositions(initialNodes, storageKey),
  );
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number; moved: boolean } | null>(
    null,
  );
  // Panning the empty SVG background — shift everything by an offset that
  // accumulates as the user drags an empty area.
  const [pan, setPan] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}-pan`) ?? "");
      // Guard against NaN/Infinity that an earlier divide-by-zero in the
      // wheel handler could have persisted — that's exactly the kind of
      // state that makes the whole graph render to nothing.
      if (
        saved &&
        typeof saved.x === "number" &&
        typeof saved.y === "number" &&
        Number.isFinite(saved.x) &&
        Number.isFinite(saved.y)
      )
        return saved;
    } catch {}
    return { x: 0, y: 0 };
  });
  const [panning, setPanning] = useState<{ startX: number; startY: number; basePan: { x: number; y: number } } | null>(
    null,
  );
  useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}-pan`, JSON.stringify(pan));
    } catch {}
  }, [pan, storageKey]);
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const saved = parseFloat(localStorage.getItem(`${storageKey}-zoom`) ?? "");
      if (Number.isFinite(saved) && saved > 0.1 && saved < 5) return saved;
    } catch {}
    return 1;
  });
  useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}-zoom`, String(zoom));
    } catch {}
  }, [zoom, storageKey]);
  const clampZoom = (z: number) => Math.min(3, Math.max(0.25, z));
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setPositions(loadPositions(initialNodes, storageKey));
  }, [initialNodes, storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(positions));
    } catch {}
  }, [positions, storageKey]);

  // Convert a viewport-space mouse event to content-coordinate space, undoing
  // both the pan (viewport-px translate) and the zoom (scale). Used while
  // dragging a node, where positions[id] is in content coords.
  const svgPoint = (e: { clientX: number; clientY: number }) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    };
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const svgP = svgPoint(e);
      if (!svgP) return;
      setPositions((prev) => ({
        ...prev,
        [dragging.id]: { x: svgP.x - dragging.offsetX, y: svgP.y - dragging.offsetY },
      }));
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      // pan is in viewport pixel space (applied as a translate BEFORE scale),
      // so cursor delta maps 1:1 — no divide-by-zoom.
      setPan({
        x: panning.basePan.x + (e.clientX - panning.startX),
        y: panning.basePan.y + (e.clientY - panning.startY),
      });
    };
    const onUp = () => setPanning(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panning]);

  const getPath = (edge: FsmEdge) => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return "";
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    if (edge.kind === "backward") {
      const midX = (x1 + x2) / 2;
      const midY = Math.min(y1, y2) - 40;
      return `M ${from.x + NODE_W} ${from.y + NODE_H / 2} Q ${midX} ${midY} ${to.x} ${to.y + NODE_H / 2}`;
    }
    return `M ${x1} ${y1} C ${x1} ${y1 + 20} ${x2} ${y2 - 20} ${x2} ${y2}`;
  };

  // Content extents only used to auto-fit on mount.
  const maxX = Math.max(...Object.values(positions).map((p) => p.x)) + NODE_W + 40;
  const maxY = Math.max(...Object.values(positions).map((p) => p.y)) + NODE_H + 40;
  const contentW = Math.max(width, maxX);
  const contentH = Math.max(height, maxY);

  // On first paint (and when container width changes), pick a zoom that fits
  // the whole graph horizontally. Self-heals when stored pan/zoom would put
  // every node outside the visible viewport — that's the failure mode that
  // makes the graph look "missing" without the reset button.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const cw = svg.clientWidth || 600;
    const ch = svg.clientHeight || 600;
    const anyVisible = initialNodes.some((n) => {
      const pos = positions[n.id] ?? { x: n.x, y: n.y };
      const px = pos.x * zoom + pan.x;
      const py = pos.y * zoom + pan.y;
      return px > -NODE_W && px < cw && py > -NODE_H && py < ch;
    });
    if (!anyVisible) {
      try {
        localStorage.removeItem(`${storageKey}-pan`);
        localStorage.removeItem(`${storageKey}-zoom`);
      } catch {}
      setPan({ x: 0, y: 0 });
      const fit = Math.min(cw / contentW, ch / contentH, 1);
      setZoom(clampZoom(fit > 0.1 ? fit : 1));
    } else if (!localStorage.getItem(`${storageKey}-zoom`)) {
      const fit = Math.min(cw / contentW, ch / contentH, 1);
      if (fit > 0.1) setZoom(clampZoom(fit));
    }
    didFitRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentW, contentH, storageKey]);

  // React's synthetic onWheel is passive by default, so e.preventDefault()
  // is a no-op and the page still scrolls. Attach a native non-passive
  // wheel listener on the svg DOM node instead. Cursor-anchored zoom:
  // viewport point (mx, my) maps to content coord ((mx - pan.x) / zoom);
  // solve for the new pan so that coord stays under the cursor.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom((prevZoom) => {
        // Guard: if prevZoom is somehow 0/NaN/Infinity (e.g. corrupted
        // localStorage), recover to 1 instead of computing -Infinity pan.
        const z = Number.isFinite(prevZoom) && prevZoom > 0 ? prevZoom : 1;
        const newZoom = clampZoom(z * factor);
        if (newZoom === z) return z;
        setPan((prevPan) => {
          const px = Number.isFinite(prevPan.x) ? prevPan.x : 0;
          const py = Number.isFinite(prevPan.y) ? prevPan.y : 0;
          const contentX = (mx - px) / z;
          const contentY = (my - py) / z;
          return { x: mx - contentX * newZoom, y: my - contentY * newZoom };
        });
        return newZoom;
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // Highlight the visited path of the selected project: the set of nodes
  // it has touched and the set of edges (from→to consecutive pairs) it
  // has traversed in the timeline.
  const visitedNodeSet = new Set<string>(visitedStates ?? []);
  const visitedEdgeSet = new Set<string>();
  for (let i = 0; i + 1 < (visitedStates?.length ?? 0); i++) {
    visitedEdgeSet.add(`${visitedStates![i]}::${visitedStates![i + 1]}`);
  }
  const currentState = visitedStates && visitedStates.length > 0 ? visitedStates[visitedStates.length - 1] : null;

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          gap: 4,
          marginBottom: 4,
          pointerEvents: "none",
        }}
      >
        <div style={{ marginLeft: "auto", display: "flex", gap: 2, pointerEvents: "auto" }}>
          <button
            onClick={() => setZoom((z) => clampZoom(z / 1.25))}
            className="mono text-[10px] px-2 py-0.5 bg-paper border border-rule-light text-ink-3 hover:text-ink-2 rounded-full"
            title="Zoom out (or scroll wheel)"
          >
            −
          </button>
          <span className="mono text-[10px] px-2 py-0.5 bg-paper border border-rule-light text-ink-3 min-w-[44px] text-center rounded-full">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => clampZoom(z * 1.25))}
            className="mono text-[10px] px-2 py-0.5 bg-paper border border-rule-light text-ink-3 hover:text-ink-2 rounded-full"
            title="Zoom in (or scroll wheel)"
          >
            +
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="mono text-[10px] px-2 py-0.5 bg-paper border border-rule-light text-ink-3 hover:text-ink-2 rounded-full"
            title="Reset zoom + pan"
          >
            ⟲
          </button>
          <button
            onClick={() => {
              // Hard reset: drop saved node positions, pan, and zoom.
              // Recovers from "graph disappeared" caused by stale localStorage.
              try {
                localStorage.removeItem(storageKey);
                localStorage.removeItem(`${storageKey}-pan`);
                localStorage.removeItem(`${storageKey}-zoom`);
              } catch {}
              setPositions(Object.fromEntries(initialNodes.map((n) => [n.id, { x: n.x, y: n.y }])));
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="mono text-[10px] px-2 py-0.5 bg-paper border border-rule-light text-ink-3 hover:text-rust rounded-full"
            title="Reset node positions + zoom + pan (fixes 'graph disappeared')"
          >
            reset
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        width="100%"
        height={Math.min(contentH, 600)}
        onMouseDown={(e) => {
          // Start pan when grabbing the empty background rect, not a node.
          // The transparent bg rect below is the currentTarget for empty space.
          const tag = (e.target as SVGElement).tagName;
          if (tag === "svg" || (e.target as SVGElement).dataset?.bg === "1") {
            setPanning({ startX: e.clientX, startY: e.clientY, basePan: pan });
          }
        }}
        style={{ userSelect: "none", cursor: panning ? "grabbing" : "grab", display: "block" }}
      >
        <defs>
          <marker id="arrow-fwd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a8a8a" />
          </marker>
          <marker id="arrow-bwd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-rust)" />
          </marker>
        </defs>
        {/* Full-bleed transparent background catches drag events anywhere */}
        {/* the user isn't on top of a node — including outside the content. */}
        <rect data-bg="1" x={0} y={0} width="100%" height="100%" fill="transparent" />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {edges.map((e, i) => {
            const isVisited = visitedEdgeSet.has(`${e.from}::${e.to}`);
            const stroke = isVisited
              ? "var(--color-rust-deep)"
              : e.kind === "backward"
                ? "var(--color-rust)"
                : "#8a8a8a";
            return (
              <path
                key={i}
                d={getPath(e)}
                fill="none"
                stroke={stroke}
                strokeWidth={isVisited ? 2.5 : 1}
                strokeDasharray={!isVisited && e.kind === "backward" ? "3 3" : undefined}
                markerEnd={e.kind === "backward" ? "url(#arrow-bwd)" : "url(#arrow-fwd)"}
                opacity={0.7}
              />
            );
          })}
          {initialNodes.map((n) => {
            const pos = positions[n.id] ?? { x: n.x, y: n.y };
            const projects = byPhase.get(n.id) ?? [];
            const hasProjects = projects.length > 0;
            const isVisited = visitedNodeSet.has(n.id);
            const isCurrent = currentState === n.id;
            return (
              <g
                key={n.id}
                transform={`translate(${pos.x} ${pos.y})`}
                style={{ cursor: dragging?.id === n.id ? "grabbing" : "grab" }}
                onMouseDown={(e) => {
                  const svgP = svgPoint(e);
                  if (!svgP) return;
                  setDragging({ id: n.id, offsetX: svgP.x - pos.x, offsetY: svgP.y - pos.y, moved: false });
                }}
              >
                {/* Double border only on the FSM initial state — the first */}
                {/* node in the kind's list. ideation for own / setup for review. */}
                {n.id === initialNodes[0].id && (
                  <rect
                    width={NODE_W + 6}
                    height={NODE_H + 6}
                    x={-3}
                    y={-3}
                    rx={6}
                    fill="none"
                    stroke="#8a8a8a"
                    strokeWidth={1}
                  />
                )}
                {/* Current state ring for the selected project */}
                {isCurrent && (
                  <rect
                    width={NODE_W + 10}
                    height={NODE_H + 10}
                    x={-5}
                    y={-5}
                    rx={8}
                    fill="none"
                    stroke="var(--color-rust)"
                    strokeWidth={2}
                  />
                )}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  fill={isVisited ? "var(--color-rust-deep)" : hasProjects ? "var(--color-rust)" : "#f4f4f4"}
                  stroke={isVisited ? "#2d4566" : "#8a8a8a"}
                  strokeWidth={1}
                />
                <text
                  x={NODE_W / 2}
                  y={NODE_H / 2 + 4}
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize={10}
                  fill={isVisited || hasProjects ? "#f4f4f4" : "#4a4a4a"}
                  style={{ pointerEvents: "none" }}
                >
                  {n.label}
                </text>
                {hasProjects && <title>{projects.map((p) => p.slug).join(", ")}</title>}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
