import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Check, ChevronDown, ChevronRight, GitPullRequest, Loader2, MessageSquare, RefreshCw, X } from "lucide-react";
import { BlockSkeleton } from "../shared/ui";
import { isTerminalJobStatus } from "@openworks/domain";
import { usePRData, type PR } from "./usePRData";

function RepoTaskInput({ repo }: { repo: string }) {
  const [input, setInput] = useState("");
  const createJob = useMutation(api.jobs.create);
  const [acting, setActing] = useState(false);
  const [localChats, setLocalChats] = useState<{ role: string; content: string }[]>([]);
  const repoUrl = `https://github.com/${repo}`;

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    setActing(true);
    setLocalChats((p) => [...p, { role: "user", content: text }]);
    try {
      await createJob({
        url: repoUrl,
        content: JSON.stringify({ repo, action: "repo-task", prompt: text }),
        type: "pr-fix" as "newsletter",
      });
      setInput("");
    } catch (err) {
      alert(String(err));
    }
    setActing(false);
  };

  return (
    <div className="px-3 py-2 ml-4 border-l border-rule-light">
      {localChats.length > 0 && (
        <div className="space-y-1 mb-2">
          {localChats.map((msg, i) => (
            <div key={i} className={`mono text-[10px] ${msg.role === "user" ? "text-ink-3" : "text-ink-2"}`}>
              <span className="text-ink-4">{msg.role === "user" ? "> " : "  "}</span>
              {msg.content}
            </div>
          ))}
          {acting && (
            <div className="flex items-center gap-1 mono text-[10px] text-ink-4">
              <Loader2 size={8} className="animate-spin" /> working...
            </div>
          )}
        </div>
      )}
      <form
        className="flex items-start gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={input.split("\n").length || 1}
          placeholder="Task for this repo... (shift+enter for newline)"
          className="flex-1 bg-transparent outline-none mono text-[10px] text-ink-2 placeholder:text-ink-4 py-1 border-b border-rule-light focus:border-rust transition-colors resize-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || acting}
          className="mono text-[9px] px-1.5 py-0.5 w-[32px] h-[20px] flex items-center justify-center text-ink-3 bg-paper-warm rounded hover:text-ink transition-colors disabled:opacity-30"
        >
          {acting ? <Loader2 size={10} className="animate-spin" /> : "run"}
        </button>
      </form>
    </div>
  );
}

function PRChatHistory({ url, isFixing }: { url: string; isFixing: boolean }) {
  const chats = useQuery(api.chats.listByUrl, { url });
  if (!chats || chats.length === 0) {
    if (isFixing) {
      return (
        <div className="px-3 pb-1 ml-5">
          <div className="flex items-center gap-1 mono text-[10px] text-ink-4">
            <Loader2 size={8} className="animate-spin" /> working...
          </div>
        </div>
      );
    }
    return null;
  }
  return (
    <div className="px-3 pb-2 ml-5 space-y-1.5">
      {chats.map((msg, i) => {
        const isUser = msg.role === "user";
        return (
          <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] px-2.5 py-1.5 text-[11px] leading-snug whitespace-pre-wrap break-words ${
                isUser
                  ? "bg-rust/10 text-ink-2 rounded-l-md rounded-tr-md rounded-br-sm"
                  : "bg-paper-warm text-ink-2 rounded-r-md rounded-tl-md rounded-bl-sm"
              }`}
            >
              {msg.content}
            </div>
          </div>
        );
      })}
      {isFixing && (
        <div className="flex justify-start">
          <div className="bg-paper-warm text-ink-4 px-2.5 py-1.5 text-[11px] rounded-r-md rounded-tl-md rounded-bl-sm flex items-center gap-1">
            <Loader2 size={8} className="animate-spin" /> working...
          </div>
        </div>
      )}
    </div>
  );
}
export function PRView({ prData, focus }: { prData: ReturnType<typeof usePRData>; focus?: string | null }) {
  const { grouped, loading, loaded, load, removePR } = prData;
  const mergePR = useAction(api.github.mergePR);
  const rebasePR = useAction(api.github.updatePRBranch);
  const closePRAction = useAction(api.github.closePR);
  const getChecks = useAction(api.github.getChecks);
  const createJob = useMutation(api.jobs.create);
  const sendChat = useMutation(api.chats.send);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [prInputs, setPrInputs] = useState<Record<number, string>>({});
  const [showAllRepos, setShowAllRepos] = useState<Set<string>>(new Set());
  const [prFixing, setPrFixing] = useState<Record<number, string>>({}); // prId -> jobId
  // prChats removed — now using PRChatHistory component with reactive query
  const REPOS_PER_PAGE = 5;
  const [checks, setChecks] = useState<
    Record<
      number,
      { checksPass: number; checksTotal: number; checksState: string; mergeable?: boolean; mergeableState?: string }
    >
  >({});
  const fetchedChecksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // Poll fix job status
  // Always query pr-fix jobs to restore working status on refresh
  const fixJobs = useQuery(api.jobs.listOffset, {
    type: "pr-fix" as "newsletter",
    archived: false,
    skip: 0,
    limit: 100,
  });
  // PR URLs with in-progress jobs (persisted in DB, survives refresh)
  const workingPrUrls = new Set(
    (fixJobs ?? [])
      .filter((j) => j.status === "pending" || j.status === "summarizing" || j.status === "suggesting")
      .map((j) => j.url),
  );

  useEffect(() => {
    if (!fixJobs) return;
    const fixEntries = Object.entries(prFixing);
    for (const [prIdStr, jobId] of fixEntries) {
      const job = fixJobs.find((j) => j._id === jobId);
      if (job && isTerminalJobStatus(job.status)) {
        setPrFixing((prev) => {
          const next = { ...prev };
          delete next[Number(prIdStr)];
          return next;
        });
        load();
      }
    }
  }, [fixJobs, prFixing, load]);

  const loadChecksForRepo = useCallback(
    async (repo: string) => {
      if (!grouped || fetchedChecksRef.current.has(repo)) return;
      fetchedChecksRef.current.add(repo);
      const prs = grouped[repo] ?? [];
      const results = await Promise.all(
        prs.map(async (pr) => {
          try {
            const c = await getChecks({ repo: pr.repo, number: pr.number });
            return { id: pr.id, ...c };
          } catch {
            return { id: pr.id, checksPass: 0, checksTotal: 0, checksState: "none" };
          }
        }),
      );
      setChecks((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.id] = r;
        return next;
      });
    },
    [grouped, getChecks],
  );

  const toggle = (repo: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) {
        next.delete(repo);
      } else {
        next.add(repo);
        loadChecksForRepo(repo);
      }
      return next;
    });
  };

  // A digest link names `owner/repo`, optionally `owner/repo#123`. The row it
  // points at is hidden twice over on arrival: its repo group is collapsed,
  // and past the fifth repo the owner is paged as well. Both are opened here,
  // and the setters return the previous value untouched when nothing changes,
  // since `grouped` is a fresh object on every render.
  const focusRepo = focus ? focus.split("#")[0] : null;
  const focusNumber = focus && focus.includes("#") ? Number(focus.split("#")[1]) : null;
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRepo || !grouped || !grouped[focusRepo]) return;
    const owner = focusRepo.split("/")[0];
    setShowAllRepos((prev) => (prev.has(owner) ? prev : new Set(prev).add(owner)));
    setExpanded((prev) => (prev.has(focusRepo) ? prev : new Set(prev).add(focusRepo)));
    loadChecksForRepo(focusRepo);
  }, [focusRepo, grouped, loadChecksForRepo]);
  useEffect(() => {
    if (!focusNumber) return;
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusNumber, expanded]);

  if (loading && !grouped) {
    return <BlockSkeleton rows={5} className="py-6" />;
  }

  if (!grouped) return null;

  const repos = Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]));
  const totalPRs = repos.reduce((s, [, prs]) => s + prs.length, 0);

  // Group repos by owner
  const byOwner: Record<string, typeof repos> = {};
  for (const entry of repos) {
    const owner = entry[0].split("/")[0];
    (byOwner[owner] ??= []).push(entry);
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function prCounts(prs: PR[]) {
    const green = prs.filter(
      (p) =>
        p.mergeable !== false && (checks[p.id]?.checksState === "success" || (!checks[p.id] && p.mergeable === true)),
    ).length;
    const red = prs.filter((p) => checks[p.id]?.checksState === "failure").length;
    const orange = prs.filter((p) => p.mergeable === false || checks[p.id]?.mergeable === false).length;
    return { green, red, orange };
  }

  const allPRsFlat = repos.flatMap(([, prs]) => prs);
  const topCounts = prCounts(allPRsFlat);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="mono text-[10px] text-ink-4 flex items-center gap-2">
          {totalPRs} open across {repos.length} repos
          {topCounts.green > 0 && (
            <span className="text-green-800 dark:text-green-400">{topCounts.green} mergeable</span>
          )}
          {topCounts.red > 0 && <span className="text-red-500">{topCounts.red} failed</span>}
          {topCounts.orange > 0 && (
            <span className="text-yellow-700 dark:text-yellow-400">{topCounts.orange} conflict</span>
          )}
        </span>
        <button onClick={load} disabled={loading} className="p-1 text-ink-4 hover:text-ink-2 transition-colors">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="space-y-4">
        {Object.entries(byOwner).map(([owner, ownerRepos]) => (
          <div key={owner}>
            <div className="mono text-[10px] text-ink-4 uppercase tracking-wider pb-1 mb-1 border-b border-rule-light flex items-center gap-2">
              {owner}
              <span>{ownerRepos.reduce((s, [, p]) => s + p.length, 0)}</span>
              {(() => {
                const c = prCounts(ownerRepos.flatMap(([, p]) => p));
                return (
                  <>
                    {c.green > 0 && <span className="text-green-800 dark:text-green-400">{c.green}</span>}
                    {c.red > 0 && <span className="text-red-500">{c.red}</span>}
                    {c.orange > 0 && <span className="text-yellow-700 dark:text-yellow-400">{c.orange}</span>}
                  </>
                );
              })()}
            </div>
            <div className="space-y-0">
              {(showAllRepos.has(owner) ? ownerRepos : ownerRepos.slice(0, REPOS_PER_PAGE)).map(([repo, prs]) => {
                const isOpen = expanded.has(repo);
                return (
                  <div key={repo} className="ruled">
                    <button
                      onClick={() => toggle(repo)}
                      className="w-full flex items-center gap-2 px-2 py-2 hover:bg-paper-warm transition-colors text-left"
                    >
                      {isOpen ? (
                        <ChevronDown size={12} className="text-ink-3" />
                      ) : (
                        <ChevronRight size={12} className="text-ink-3" />
                      )}
                      <a
                        href={`https://github.com/${repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mono text-xs text-rust hover:text-ink transition-colors"
                      >
                        {repo}
                      </a>
                      <span className="mono text-[10px] ml-auto flex items-center gap-1.5">
                        {(() => {
                          const c = prCounts(prs);
                          return (
                            <>
                              {c.green > 0 && <span className="text-green-800 dark:text-green-400">{c.green}</span>}
                              {c.red > 0 && <span className="text-red-500">{c.red}</span>}
                              {c.orange > 0 && <span className="text-yellow-700 dark:text-yellow-400">{c.orange}</span>}
                              {prs.length - c.green - c.red - c.orange > 0 && (
                                <span className="text-ink-4">{prs.length - c.green - c.red - c.orange}</span>
                              )}
                            </>
                          );
                        })()}
                      </span>
                    </button>
                    {isOpen && (
                      <>
                        <RepoTaskInput repo={repo} />
                        <div className="ml-6 border-l border-rule-light">
                          {prs.map((pr) => (
                            <div
                              key={pr.id}
                              ref={repo === focusRepo && pr.number === focusNumber ? focusRef : undefined}
                            >
                              <div
                                className={`flex items-start gap-2 px-3 py-2 transition-colors group ${
                                  repo === focusRepo && pr.number === focusNumber
                                    ? "bg-rust/10 ring-1 ring-rust/40"
                                    : "hover:bg-paper-warm"
                                }`}
                              >
                                <GitPullRequest
                                  size={12}
                                  className={`mt-0.5 shrink-0 ${pr.draft ? "text-ink-3" : "text-green-800 dark:text-green-400"}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <a
                                    href={pr.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mono text-xs text-rust hover:text-ink transition-colors truncate block"
                                  >
                                    #{pr.number} {pr.title}
                                  </a>
                                  {(prFixing[pr.id] || workingPrUrls.has(pr.url)) && (
                                    <span className="flex items-center gap-1 mono text-[10px] text-yellow-700 dark:text-yellow-400">
                                      <Loader2 size={10} className="animate-spin" /> working...
                                    </span>
                                  )}
                                  <div className="flex items-center gap-2 mt-0.5 flex-wrap overflow-hidden">
                                    <span className="mono text-[10px] text-ink-4">{pr.author}</span>
                                    {pr.branch && (
                                      <span
                                        className="mono text-[10px] text-ink-3 bg-paper-warm px-1 rounded truncate max-w-[200px]"
                                        title={pr.branch}
                                      >
                                        {pr.branch}
                                      </span>
                                    )}
                                    <span className="mono text-[10px] text-ink-4">{timeAgo(pr.updatedAt)}</span>
                                    {pr.comments > 0 && (
                                      <span className="flex items-center gap-0.5 mono text-[10px] text-ink-4">
                                        <MessageSquare size={8} />
                                        {pr.comments}
                                      </span>
                                    )}
                                    {(() => {
                                      const c = checks[pr.id];
                                      if (!c)
                                        return (
                                          <span className="flex items-center gap-0.5 mono text-[10px] text-ink-4">
                                            <Loader2 size={8} className="animate-spin" />
                                          </span>
                                        );
                                      if (c.checksState === "loading" || c.checksTotal === 0) return null;
                                      return (
                                        <span
                                          className={`flex items-center gap-0.5 mono text-[10px] ${
                                            c.checksState === "success"
                                              ? "text-green-800 dark:text-green-400"
                                              : c.checksState === "failure"
                                                ? "text-red-500"
                                                : c.checksState === "pending"
                                                  ? "text-yellow-500"
                                                  : "text-ink-4"
                                          }`}
                                        >
                                          {c.checksState === "success" ? (
                                            <Check size={8} />
                                          ) : c.checksState === "failure" ? (
                                            <X size={8} />
                                          ) : (
                                            <Loader2 size={8} className="animate-spin" />
                                          )}
                                          {c.checksPass}/{c.checksTotal}
                                        </span>
                                      );
                                    })()}
                                    {pr.changedFiles > 0 && (
                                      <span className="mono text-[10px] text-ink-2">{pr.changedFiles} files</span>
                                    )}
                                    {pr.commits > 0 && (
                                      <span className="mono text-[10px] text-ink-2">{pr.commits} commits</span>
                                    )}
                                    {(pr.additions > 0 || pr.deletions > 0) && (
                                      <span className="mono text-[10px]">
                                        <span className="text-green-800 dark:text-green-400">+{pr.additions}</span>
                                        <span className="text-red-500 ml-0.5">-{pr.deletions}</span>
                                      </span>
                                    )}
                                    {pr.draft && (
                                      <span className="mono text-[9px] text-ink-4 bg-paper-warm px-1 rounded">
                                        draft
                                      </span>
                                    )}
                                    {pr.labels.map((l) => (
                                      <span key={l} className="mono text-[9px] text-ink-4 bg-paper-warm px-1 rounded">
                                        {l}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {(pr.mergeable === false || checks[pr.id]?.mergeable === false) && (
                                    <span className="mono text-[9px] text-red-500 px-1">conflict</span>
                                  )}
                                  {pr.behindBy > 0 && pr.mergeable !== false && (
                                    <span className="mono text-[9px] text-yellow-700 dark:text-yellow-400 px-1">
                                      behind
                                    </span>
                                  )}
                                  {checks[pr.id]?.checksState === "success" &&
                                    pr.mergeable !== false &&
                                    checks[pr.id]?.mergeable !== false && (
                                      <button
                                        disabled={acting.has(`merge-${pr.id}`)}
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          setActing((p) => new Set(p).add(`merge-${pr.id}`));
                                          try {
                                            await mergePR({ repo: pr.repo, number: pr.number, method: "squash" });
                                            removePR(pr.repo, pr.id);
                                          } catch (err) {
                                            const msg = String(err);
                                            if (
                                              msg.includes("already in progress") ||
                                              msg.includes("Base branch was modified")
                                            ) {
                                              loadChecksForRepo(pr.repo);
                                            } else if (msg.includes("not mergeable") || msg.includes("conflict")) {
                                              setChecks((prev) => ({
                                                ...prev,
                                                [pr.id]: { ...prev[pr.id], mergeable: false, mergeableState: "dirty" },
                                              }));
                                            } else {
                                              alert(msg);
                                            }
                                          }
                                          setActing((p) => {
                                            const n = new Set(p);
                                            n.delete(`merge-${pr.id}`);
                                            return n;
                                          });
                                        }}
                                        className="mono text-[9px] px-1.5 py-0.5 w-[42px] h-[20px] flex items-center justify-center bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-50"
                                      >
                                        {acting.has(`merge-${pr.id}`) ? (
                                          <Loader2 size={10} className="animate-spin" />
                                        ) : (
                                          "merge"
                                        )}
                                      </button>
                                    )}
                                  <button
                                    disabled={
                                      acting.has(`rebase-${pr.id}`) ||
                                      pr.mergeable === false ||
                                      checks[pr.id]?.mergeable === false ||
                                      pr.behindBy === 0
                                    }
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      setActing((p) => new Set(p).add(`rebase-${pr.id}`));
                                      try {
                                        await rebasePR({ repo: pr.repo, number: pr.number });
                                        load();
                                      } catch (err) {
                                        const msg = String(err);
                                        if (msg.includes("conflict")) {
                                          setChecks((prev) => ({
                                            ...prev,
                                            [pr.id]: { ...prev[pr.id], mergeable: false, mergeableState: "dirty" },
                                          }));
                                        } else if (msg.includes("no new commits")) {
                                          // already up to date, ignore
                                        } else {
                                          alert(msg);
                                        }
                                      }
                                      setActing((p) => {
                                        const n = new Set(p);
                                        n.delete(`rebase-${pr.id}`);
                                        return n;
                                      });
                                    }}
                                    className="mono text-[9px] px-1.5 py-0.5 w-[46px] h-[20px] flex items-center justify-center text-ink-3 bg-paper-warm rounded hover:text-ink transition-colors disabled:opacity-50"
                                  >
                                    {acting.has(`rebase-${pr.id}`) ? (
                                      <Loader2 size={10} className="animate-spin" />
                                    ) : (
                                      "update"
                                    )}
                                  </button>
                                  <button
                                    disabled={acting.has(`close-${pr.id}`)}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      setActing((p) => new Set(p).add(`close-${pr.id}`));
                                      try {
                                        await closePRAction({ repo: pr.repo, number: pr.number });
                                        removePR(pr.repo, pr.id);
                                      } catch (err) {
                                        alert(String(err));
                                      }
                                      setActing((p) => {
                                        const n = new Set(p);
                                        n.delete(`close-${pr.id}`);
                                        return n;
                                      });
                                    }}
                                    className="mono text-[9px] px-1.5 py-0.5 w-[36px] h-[20px] flex items-center justify-center text-ink-2 bg-paper-warm rounded hover:bg-red-500 hover:text-white transition-colors disabled:opacity-50"
                                  >
                                    {acting.has(`close-${pr.id}`) ? (
                                      <Loader2 size={10} className="animate-spin" />
                                    ) : (
                                      "close"
                                    )}
                                  </button>
                                </div>
                              </div>
                              <PRChatHistory
                                url={pr.url}
                                isFixing={prFixing[pr.id] !== undefined || workingPrUrls.has(pr.url)}
                              />
                              <form
                                className="flex items-center gap-1 px-3 pb-2 ml-5"
                                onSubmit={async (e) => {
                                  e.preventDefault();
                                  const text = (prInputs[pr.id] || "").trim();
                                  if (!text) return;
                                  const key = `ask-${pr.id}`;
                                  setActing((p) => new Set(p).add(key));
                                  try {
                                    const jobId = await createJob({
                                      url: pr.url,
                                      content: JSON.stringify({
                                        repo: pr.repo,
                                        number: pr.number,
                                        title: pr.title,
                                        action: "ask",
                                        prompt: text,
                                      }),
                                      type: "pr-fix" as "newsletter",
                                    });
                                    await sendChat({ jobId: jobId as Id<"jobs">, content: text });
                                    setPrInputs((p) => ({ ...p, [pr.id]: "" }));
                                    setPrFixing((p) => ({ ...p, [pr.id]: jobId }));
                                  } catch (err) {
                                    alert(String(err));
                                  }
                                  setActing((p) => {
                                    const n = new Set(p);
                                    n.delete(key);
                                    return n;
                                  });
                                }}
                              >
                                <input
                                  type="text"
                                  value={prInputs[pr.id] || ""}
                                  onChange={(e) => setPrInputs((p) => ({ ...p, [pr.id]: e.target.value }))}
                                  placeholder="Ask or describe fix..."
                                  className="flex-1 bg-transparent outline-none mono text-[10px] text-ink-2 placeholder:text-ink-4 py-1 border-b border-rule-light focus:border-rust transition-colors"
                                />
                                <button
                                  type="submit"
                                  disabled={!(prInputs[pr.id] || "").trim() || acting.has(`ask-${pr.id}`)}
                                  className="mono text-[9px] px-1.5 py-0.5 w-[28px] h-[20px] flex items-center justify-center text-ink-3 bg-paper-warm rounded hover:text-ink transition-colors disabled:opacity-30"
                                >
                                  {acting.has(`ask-${pr.id}`) ? <Loader2 size={10} className="animate-spin" /> : "ask"}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    acting.has(`fix-input-${pr.id}`) ||
                                    prFixing[pr.id] !== undefined ||
                                    workingPrUrls.has(pr.url)
                                  }
                                  onClick={async () => {
                                    const text = (prInputs[pr.id] || "").trim();
                                    const key = `fix-input-${pr.id}`;
                                    setActing((p) => new Set(p).add(key));
                                    try {
                                      const jobId = await createJob({
                                        url: pr.url,
                                        content: JSON.stringify({
                                          repo: pr.repo,
                                          number: pr.number,
                                          title: pr.title,
                                          action: "fix",
                                          prompt: text,
                                        }),
                                        type: "pr-fix" as "newsletter",
                                      });
                                      setPrInputs((p) => ({ ...p, [pr.id]: "" }));
                                      setPrFixing((p) => ({ ...p, [pr.id]: jobId }));
                                    } catch (err) {
                                      alert(String(err));
                                    }
                                    setActing((p) => {
                                      const n = new Set(p);
                                      n.delete(key);
                                      return n;
                                    });
                                  }}
                                  className="mono text-[9px] px-1.5 py-0.5 w-[28px] h-[20px] flex items-center justify-center text-rust bg-paper-warm rounded hover:bg-rust hover:text-white transition-colors disabled:opacity-30"
                                >
                                  {acting.has(`fix-input-${pr.id}`) ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    "fix"
                                  )}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    acting.has(`eval-${pr.id}`) ||
                                    prFixing[pr.id] !== undefined ||
                                    workingPrUrls.has(pr.url)
                                  }
                                  onClick={async () => {
                                    const key = `eval-${pr.id}`;
                                    setActing((p) => new Set(p).add(key));
                                    try {
                                      const jobId = await createJob({
                                        url: pr.url,
                                        content: JSON.stringify({
                                          repo: pr.repo,
                                          number: pr.number,
                                          title: pr.title,
                                          action: "eval",
                                          prompt: "",
                                        }),
                                        type: "pr-fix" as "newsletter",
                                      });
                                      await sendChat({ jobId: jobId as Id<"jobs">, content: "[eval] PR evaluation" });
                                      setPrFixing((p) => ({ ...p, [pr.id]: jobId }));
                                    } catch (err) {
                                      alert(String(err));
                                    }
                                    setActing((p) => {
                                      const n = new Set(p);
                                      n.delete(key);
                                      return n;
                                    });
                                  }}
                                  className="mono text-[9px] px-1.5 py-0.5 w-[32px] h-[20px] flex items-center justify-center text-ink-3 bg-paper-warm rounded hover:text-ink transition-colors disabled:opacity-30"
                                >
                                  {acting.has(`eval-${pr.id}`) ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    "eval"
                                  )}
                                </button>
                              </form>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {!showAllRepos.has(owner) && ownerRepos.length > REPOS_PER_PAGE && (
                <button
                  onClick={() => setShowAllRepos((p) => new Set(p).add(owner))}
                  className="mono text-[10px] text-ink-4 hover:text-ink-2 transition-colors px-2 py-2"
                >
                  Show {ownerRepos.length - REPOS_PER_PAGE} more repos
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
