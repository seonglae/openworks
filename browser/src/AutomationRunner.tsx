import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type SummaryInput = {
  index: number;
  title: string;
  category: string;
  summary: string;
  keywords: string[];
  url: string;
};

type SuggestionInput = {
  summaryIndex: number;
  topic: string;
  pageName: string;
  pageId: string;
  pageUrl: string;
  action: string;
  content: string;
  contextBefore?: string;
  contextAfter?: string;
};

type BaseInput = {
  runId?: string;
  server?: string;
};

type AutomationInput =
  | (BaseInput & { type: "idle" })
  | (BaseInput & { type: "ping"; note?: string })
  | (BaseInput & { type: "getJob"; jobId: string })
  | (BaseInput & { type: "getSummaries"; jobId: string })
  | (BaseInput & { type: "getSuggestions"; jobId: string })
  | (BaseInput & { type: "retryJob"; jobId: string })
  | (BaseInput & {
      type: "searchPages";
      queries: Array<{ key: string; query: string; pageSize?: number }>;
    })
  | (BaseInput & {
      type: "fetchPageMarkdown";
      pages: Array<{ key: string; pageId: string }>;
    })
  | (BaseInput & {
      type: "commitNewsletter";
      jobId: string;
      title: string;
      tldr?: string[];
      summaries?: SummaryInput[];
      suggestions?: SuggestionInput[];
    });

type AutomationResult =
  | {
      status: "ok";
      stage: string;
      [key: string]: unknown;
    }
  | {
      status: "error";
      stage: string;
      error: string;
    };

const RESULT_KEY = "openworks:result";
const LAST_RUN_KEY = "openworks:lastRunId";
const POLL_MS = 1500;

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}${path}`;
}

function inputRunId(input: AutomationInput) {
  return input.runId ?? JSON.stringify(input);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }
  return (await res.json()) as T;
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST failed (${res.status}) for ${url}`);
  }
}

export default function AutomationRunner() {
  const [input, setInput] = useState<AutomationInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const pendingRunIdRef = useRef<string | null>(null);
  const processingRunIdRef = useRef<string | null>(null);

  const searchParams = useMemo(() => new URL(window.location.href).searchParams, []);
  const queryServer = searchParams.get("server") ?? "";
  const visible = searchParams.has("automation");

  const jobId = input?.type === "getJob" ? (input.jobId as Id<"jobs">) : null;
  const listJobId =
    input?.type === "getSummaries" || input?.type === "getSuggestions" ? (input.jobId as Id<"jobs">) : null;

  const job = useQuery(api.jobs.getById, jobId ? { jobId } : "skip");
  const summaries = useQuery(api.summaries.listByJob, listJobId ? { jobId: listJobId } : "skip");
  const suggestions = useQuery(api.suggestions.listByJob, listJobId ? { jobId: listJobId } : "skip");

  const updateStatus = useMutation(api.jobs.updateStatus);
  const updateTitle = useMutation(api.jobs.updateTitle);
  const setTldr = useMutation(api.jobs.setTldr);
  const addSummaries = useMutation(api.summaries.addBatch);
  const addSuggestions = useMutation(api.suggestions.addBatch);
  const retryJob = useMutation(api.jobs.retry);
  const searchPages = useAction(api.notion.searchPages);
  const fetchPageAsMarkdown = useAction(api.notion.fetchPageAsMarkdown);

  const finish = async (runId: string, server: string, result: AutomationResult) => {
    const payload = { runId, ...result };

    try {
      localStorage.setItem(RESULT_KEY, JSON.stringify(payload));
      localStorage.setItem(LAST_RUN_KEY, runId);
    } catch {}

    window.location.hash = `result=${encodeURIComponent(JSON.stringify(payload))}`;

    if (visible) {
      document.title = `automation:${result.status}:${result.stage}`;
    }

    if (server) {
      await postJson(joinUrl(server, "/result"), payload);
    }
  };

  useEffect(() => {
    // Only the automation harness (?automation) polls for input. The normal app
    // must never poll /automation-input.json — in dev the SPA fallback returns
    // index.html, JSON parsing fails, and the error handler used to write a
    // "load-error" result into the URL hash (the #result=... garbage).
    if (!visible) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await fetchJson<AutomationInput>(`/automation-input.json?ts=${Date.now()}`);
        if (cancelled) return;

        if (next.type === "idle") {
          setLoadError(null);
          return;
        }

        const runId = inputRunId(next);
        const lastRunId = (() => {
          try {
            return localStorage.getItem(LAST_RUN_KEY);
          } catch {
            return null;
          }
        })();

        if (runId === lastRunId || runId === pendingRunIdRef.current || runId === processingRunIdRef.current) {
          setLoadError(null);
          return;
        }

        pendingRunIdRef.current = runId;
        setLoadError(null);
        setInput(next);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    if (visible) {
      document.title = "automation:loading";
    }

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible]);

  useEffect(() => {
    if (!loadError) return;

    const runId = processingRunIdRef.current ?? pendingRunIdRef.current ?? `load-error:${Date.now()}`;
    const server = queryServer;
    void finish(runId, server, {
      status: "error",
      stage: "loadInput",
      error: loadError,
    });
  }, [finish, loadError, queryServer]);

  useEffect(() => {
    if (!input) return;

    const runId = inputRunId(input);
    if (processingRunIdRef.current === runId) return;
    if (input.type === "getJob" && job === undefined) return;
    if (input.type === "getSummaries" && summaries === undefined) return;
    if (input.type === "getSuggestions" && suggestions === undefined) return;

    const server = input.server ?? queryServer;

    processingRunIdRef.current = runId;
    pendingRunIdRef.current = null;

    if (server) {
      void fetch(joinUrl(server, "/ping"), { method: "POST" }).catch(() => undefined);
    }

    const run = async () => {
      try {
        if (input.type === "ping") {
          await finish(runId, server, {
            status: "ok",
            stage: "ping",
            note: input.note ?? null,
            at: new Date().toISOString(),
          });
          return;
        }

        if (input.type === "getJob") {
          await finish(runId, server, {
            status: "ok",
            stage: "getJob",
            job,
          });
          return;
        }

        if (input.type === "getSummaries") {
          await finish(runId, server, {
            status: "ok",
            stage: "getSummaries",
            summaries,
          });
          return;
        }

        if (input.type === "getSuggestions") {
          await finish(runId, server, {
            status: "ok",
            stage: "getSuggestions",
            suggestions,
          });
          return;
        }

        if (input.type === "retryJob") {
          await retryJob({ jobId: input.jobId as Id<"jobs"> });
          await finish(runId, server, {
            status: "ok",
            stage: "retryJob",
            jobId: input.jobId,
          });
          return;
        }

        if (input.type === "searchPages") {
          const results = [] as Array<{ key: string; query: string; pages: unknown }>;
          for (const query of input.queries) {
            const pages = await searchPages({
              query: query.query,
              pageSize: query.pageSize ?? 5,
            });
            results.push({ key: query.key, query: query.query, pages });
          }
          await finish(runId, server, {
            status: "ok",
            stage: "searchPages",
            results,
          });
          return;
        }

        if (input.type === "fetchPageMarkdown") {
          const results = [] as Array<{ key: string; pageId: string; markdown: string }>;
          for (const page of input.pages) {
            const markdown = await fetchPageAsMarkdown({ pageId: page.pageId });
            results.push({ key: page.key, pageId: page.pageId, markdown });
          }
          await finish(runId, server, {
            status: "ok",
            stage: "fetchPageMarkdown",
            results,
          });
          return;
        }

        if (input.type === "commitNewsletter") {
          const typedJobId = input.jobId as Id<"jobs">;
          await updateStatus({ jobId: typedJobId, status: "summarizing" });
          await updateTitle({ jobId: typedJobId, title: input.title });
          if (input.tldr && input.tldr.length > 0) {
            await setTldr({ jobId: typedJobId, tldr: input.tldr });
          }

          if (input.summaries && input.summaries.length > 0) {
            await addSummaries({ jobId: typedJobId, summaries: input.summaries });
          }

          await updateStatus({ jobId: typedJobId, status: "suggesting" });

          if (input.suggestions && input.suggestions.length > 0) {
            await addSuggestions({ jobId: typedJobId, suggestions: input.suggestions });
          } else {
            await updateStatus({ jobId: typedJobId, status: "suggested" });
          }

          await finish(runId, server, {
            status: "ok",
            stage: "commitNewsletter",
            jobId: input.jobId,
            title: input.title,
            summaryCount: input.summaries?.length ?? 0,
            suggestionCount: input.suggestions?.length ?? 0,
          });
        }
      } catch (err) {
        await finish(runId, server, {
          status: "error",
          stage: input.type,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        processingRunIdRef.current = null;
        setInput((current) => {
          if (!current) return current;
          return inputRunId(current) === runId ? null : current;
        });
      }
    };

    void run();
  }, [
    fetchPageAsMarkdown,
    finish,
    input,
    job,
    summaries,
    suggestions,
    queryServer,
    searchPages,
    updateStatus,
    updateTitle,
    setTldr,
    addSummaries,
    addSuggestions,
    retryJob,
  ]);

  if (!visible) return null;

  return (
    <div style={{ padding: 24, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
      {loadError
        ? `Automation load failed: ${loadError}`
        : input
          ? `Running automation: ${input.type}`
          : "Waiting for automation input..."}
    </div>
  );
}
