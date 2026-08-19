import { useState } from "react";
import { useQuery, useMutation, useAction, usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { ChevronRight } from "lucide-react";
import { AgentIcon } from "../AgentIcons";
import { useInfiniteScroll } from "../shared/hooks";
import { OFFSCREEN_SKIP, PaginationFooter } from "../shared/ui";

function InsightImage({ id }: { id: Id<"insights"> }) {
  const url = useQuery(api.insights.imageUrl, { id });
  if (!url) return null;
  return <img src={url} alt="" className="max-h-40 rounded border border-rule-light mb-1.5" />;
}

const INSIGHT_STATUS_STYLE: Record<string, string> = {
  suggested: "text-slate bg-slate/10",
  new: "text-ochre bg-ochre-dim",
  placed: "text-sage bg-sage/10",
  dismissed: "text-ink-4 bg-paper-warm/60",
  error: "text-rust bg-rust/10",
};

type InsightStatus = Doc<"insights">["status"];

function InsightStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`mono text-[9px] tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${INSIGHT_STATUS_STYLE[status] ?? "text-ink-4"}`}
    >
      {status}
    </span>
  );
}

const INSIGHTS_PAGE = 25;

export function InsightsView() {
  const [statusFilter, setStatusFilter] = useState<InsightStatus | null>(null);
  const {
    results: rows,
    status: pageStatus,
    loadMore,
  } = usePaginatedQuery(api.insights.listPaged, statusFilter ? { status: statusFilter } : {}, {
    initialNumItems: INSIGHTS_PAGE,
  });
  const countData = useQuery(api.insights.statusCounts, {});
  const addInsight = useMutation(api.insights.add);
  const addImage = useMutation(api.insights.addImage);
  const genUrl = useMutation(api.insights.generateUploadUrl);
  const removeInsight = useMutation(api.insights.remove);
  const setStatus = useMutation(api.insights.setStatus);
  const placeInsight = useAction(api.notion.placeInsight);
  const importFromNotion = useAction(api.notion.importInsightsFromNotion);

  const field =
    "bg-paper-warm/40 border border-rule-light rounded px-2 py-1.5 text-[12px] text-ink focus:border-rust outline-none";

  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [notionPage, setNotionPage] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const sentinelRef = useInfiniteScroll(pageStatus, loadMore, INSIGHTS_PAGE);

  const doAdd = async () => {
    if (!raw.trim()) return;
    const r = await addInsight({ raw });
    setRaw("");
    setMsg(`added ${r.added}`);
  };

  const doImport = async () => {
    const id = notionPage.replace(/-/g, "").match(/[0-9a-f]{32}/i)?.[0];
    if (!id) {
      setMsg("paste a Notion page URL or id");
      return;
    }
    setMsg("importing from Notion…");
    try {
      const r = await importFromNotion({ pageId: id });
      setMsg(`imported ${r.imported}/${r.found} (${r.skipped} dupes)`);
      setNotionPage("");
    } catch (e) {
      setMsg(`import failed: ${String((e as Error).message).slice(0, 80)}`);
    }
  };

  const uploadFile = async (file: File) => {
    setMsg("uploading image…");
    try {
      const postUrl = await genUrl({});
      const res = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const { storageId } = await res.json();
      await addImage({ imageId: storageId });
      setMsg("image added — worker will read the quote");
    } catch (e) {
      setMsg(`upload failed: ${String((e as Error).message).slice(0, 60)}`);
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          void uploadFile(f);
        }
      }
    }
  };

  const doPlace = async (id: Id<"insights">) => {
    setBusy(id);
    try {
      await placeInsight({ insightId: id });
      setMsg("placed into Notion");
    } catch (e) {
      setMsg(`place failed: ${String((e as Error).message).slice(0, 80)}`);
    } finally {
      setBusy(null);
    }
  };

  // Ordering (actionable first, then recency) is applied server-side by
  // insights:listPaged, so the feed arrives ready to render.
  const counts = countData?.counts ?? {};
  const totalCount = countData?.total ?? 0;
  const pickFilter = (s: InsightStatus | null) => setStatusFilter(s);
  const toggleOpen = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="panel anim d2">
      <div className="mb-3">
        <textarea
          className={`${field} w-full resize-none`}
          rows={3}
          placeholder="Paste a quote / insight — a blank line separates multiple. Or paste a screenshot."
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onPaste={onPaste}
        />
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <button
            onClick={doAdd}
            disabled={!raw.trim()}
            className="droplet px-3 py-1.5 mono text-[10px] tracking-wider text-rust disabled:opacity-40"
          >
            + add insight
          </button>
          <label className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust cursor-pointer">
            + image
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {msg && <span className="mono text-[10px] text-sage">{msg}</span>}
        </div>
        <details className="mt-2">
          <summary className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust cursor-pointer">
            import from notion
          </summary>
          <div className="flex gap-2 mt-2">
            <input
              className={`${field} flex-1 min-w-0`}
              placeholder="Notion page URL or id — every block becomes an insight"
              value={notionPage}
              onChange={(e) => setNotionPage(e.target.value)}
            />
            <button
              onClick={doImport}
              disabled={!notionPage.trim()}
              className="droplet px-3 py-1.5 mono text-[10px] tracking-wider text-rust disabled:opacity-40 shrink-0"
            >
              import
            </button>
          </div>
        </details>
      </div>

      <div className="flex flex-wrap items-center gap-1 mb-2">
        {([null, "suggested", "new", "placed", "dismissed", "error"] as const).map((s) => {
          const n = s ? (counts[s] ?? 0) : totalCount;
          if (s && n === 0) return null;
          return (
            <button
              key={s ?? "all"}
              onClick={() => pickFilter(s)}
              className={`mono text-[10px] tracking-wider px-2 py-0.5 rounded-full transition-colors ${
                statusFilter === s ? "droplet text-rust" : "text-ink-4 hover:text-ink-3"
              }`}
            >
              {s ?? "all"} {n}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col divide-y divide-rule-light">
        {rows.map((it) => {
          const open = openIds.has(it._id);
          return (
            <div key={it._id} className={open ? undefined : OFFSCREEN_SKIP}>
              <button onClick={() => toggleOpen(it._id)} className="w-full flex items-start gap-2 text-left py-2.5">
                <ChevronRight
                  size={12}
                  className={`mt-1 shrink-0 text-ink-4 transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span
                  className={`flex-1 min-w-0 text-[13px] text-ink break-words ${open ? "whitespace-pre-line" : "line-clamp-2"}`}
                >
                  {it.text || "[image] awaiting extraction…"}
                </span>
                {it.provider && (
                  <span className="mt-1 shrink-0 flex items-center" title={`enriched by ${it.provider}`}>
                    <AgentIcon provider={it.provider} size={11} />
                  </span>
                )}
                <InsightStatusPill status={it.status} />
              </button>
              {open && (
                <div className="pl-5 pb-3 space-y-1.5">
                  {it.imageId && <InsightImage id={it._id} />}
                  {it.source && <div className="mono text-[10px] text-ink-4">— {it.source}</div>}
                  {it.interpretation && <div className="text-[12px] text-ink-2">{it.interpretation}</div>}
                  {it.evaluation && <div className="text-[12px] text-ink-3 italic">{it.evaluation}</div>}
                  {it.tags && it.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {it.tags.map((t) => (
                        <span
                          key={t}
                          className="mono text-[9px] tracking-wider px-1.5 py-0.5 rounded-full bg-paper-warm/60 text-ink-4"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {it.status === "error" && (
                    <div className="flex items-center gap-2">
                      <span className="mono text-[10px] text-rust break-words">{it.error}</span>
                      <button
                        onClick={() => setStatus({ id: it._id, status: "new" })}
                        className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust"
                      >
                        retry
                      </button>
                    </div>
                  )}

                  {it.status === "suggested" &&
                    (it.notionPageId ? (
                      <div className="border border-rule-light rounded p-2 bg-paper-warm/30">
                        <div className="mono text-[10px] text-ink-3">
                          →{" "}
                          <a
                            href={it.notionPageUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-rust hover:underline break-all"
                          >
                            {it.notionPageName}
                          </a>
                        </div>
                        {it.notionContent && (
                          <pre className="mono text-[10px] text-ink-2 whitespace-pre-wrap mt-1">{it.notionContent}</pre>
                        )}
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => doPlace(it._id)}
                            disabled={busy === it._id}
                            className="droplet px-3 py-1 mono text-[10px] tracking-wider text-rust disabled:opacity-40"
                          >
                            {busy === it._id ? "placing…" : "place"}
                          </button>
                          <button
                            onClick={() => setStatus({ id: it._id, status: "dismissed" })}
                            className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust"
                          >
                            dismiss
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="mono text-[10px] text-ink-4 break-words">
                          no fitting Notion page{it.notionReason ? `: ${it.notionReason}` : ""}
                        </span>
                        <button
                          onClick={() => setStatus({ id: it._id, status: "dismissed" })}
                          className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust"
                        >
                          dismiss
                        </button>
                      </div>
                    ))}

                  {it.status === "placed" && (
                    <div className="mono text-[10px] text-sage">
                      ✓ placed
                      {it.notionPageUrl && (
                        <>
                          {" → "}
                          <a href={it.notionPageUrl} target="_blank" rel="noreferrer" className="hover:underline">
                            {it.notionPageName}
                          </a>
                        </>
                      )}
                    </div>
                  )}

                  <button
                    onClick={() => removeInsight({ id: it._id })}
                    className="mono text-[9px] tracking-wider text-ink-4 hover:text-rust"
                  >
                    delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && pageStatus !== "LoadingFirstPage" && (
          <div className="mono text-[12px] text-ink-4 py-10 text-center">
            No insights yet. Paste a quote or a screenshot above.
          </div>
        )}
      </div>

      <PaginationFooter status={pageStatus} count={rows.length} sentinelRef={sentinelRef} />
    </div>
  );
}
