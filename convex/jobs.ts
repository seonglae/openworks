import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOwner } from "./auth";
import { truncateSafe } from "@openworks/core";
import { JOB_STATUSES, JOB_TYPES, isTerminalJobStatus } from "@openworks/domain";
import { literals } from "./validators";
import { syncSummaryAggregates } from "./summaryAggregates";

const JOB_TYPE = literals(JOB_TYPES);
const JOB_STATUS = literals(JOB_STATUSES);

// Callers pass the active tab key, which includes tabs that are not job types
// at all (insights, vocab, …), so the args stay v.string() and would reject
// those at runtime if tightened. The index key is the schema's literal union,
// so narrow here and let an unknown type simply match no rows.
const asJobType = (t: string | undefined) => t as Doc<"jobs">["type"] | undefined;

// List payloads carry every field of every row, and `content` is the whole
// pasted newsletter or paper — hundreds of KB each. Lists only ever render a
// one-line preview of it, so ship that and let jobs:getContent fetch the full
// text when the user actually opens it.
const CONTENT_PREVIEW = 120;
const withoutContent = <T extends { content?: string }>(j: T) => {
  const { content, ...rest } = j;
  return { ...rest, ...(content ? { contentPreview: truncateSafe(content, CONTENT_PREVIEW) } : {}) };
};

export const getContent = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const job = await ctx.db.get(args.jobId);
    return job?.content ?? null;
  },
});

export const create = mutation({
  args: {
    url: v.string(),
    content: v.optional(v.string()),
    title: v.optional(v.string()),
    type: v.optional(JOB_TYPE),
    emailId: v.optional(v.string()),
    imageId: v.optional(v.id("_storage")),
    imageIds: v.optional(v.array(v.id("_storage"))),
    createdAt: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (args.emailId) {
      const existing = await ctx.db
        .query("jobs")
        .withIndex("by_emailId", (q) => q.eq("emailId", args.emailId))
        .first();
      if (existing) return existing._id;
    }
    // Keep imageId = first attachment for the single-image worker path / old UI.
    const imageIds = args.imageIds && args.imageIds.length > 0 ? args.imageIds : undefined;
    const firstImage = args.imageId ?? imageIds?.[0];
    return await ctx.db.insert("jobs", {
      url: args.url,
      ...(args.content ? { content: args.content } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(firstImage ? { imageId: firstImage } : {}),
      ...(imageIds ? { imageIds } : {}),
      type: args.type ?? "newsletter",
      archived: false,
      status: "pending",
      emailId: args.emailId,
      createdAt: args.createdAt ?? Date.now(),
    });
  },
});

// Clipboard image upload for paper/article submissions: UI requests an
// upload URL, POSTs the pasted image, and passes the resulting storageId
// to jobs:create as imageId.
export const generateUploadUrl = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.storage.generateUploadUrl();
  },
});

// Worker resolves the pasted image to a short-lived URL to download it
// into ./tmp before spawning the agent.
export const imageUrl = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const job = await ctx.db.get(args.jobId);
    if (!job?.imageId) return null;
    return await ctx.storage.getUrl(job.imageId);
  },
});

// All pasted screenshots for a job as short-lived URLs (multi-image paste).
// Falls back to the single imageId for older rows.
export const imageUrls = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const job = await ctx.db.get(args.jobId);
    if (!job) return [];
    const ids = job.imageIds && job.imageIds.length > 0 ? job.imageIds : job.imageId ? [job.imageId] : [];
    const urls = await Promise.all(ids.map((id) => ctx.storage.getUrl(id)));
    return urls.filter((u): u is string => u !== null);
  },
});

// Agent discovered the canonical source URL from a pasted image — stamp it
// onto the job so the row links out correctly.
export const setUrl = mutation({
  args: { jobId: v.id("jobs"), url: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { url: args.url });
  },
});

export const getPending = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .first();
  },
});

export const getAllPending = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    // Strip large `content` field from the listing for bandwidth. The
    // worker calls jobs:claimJob next, which returns the full job
    // document (including content) — that's what the prompt builder
    // must use. See worker.mts:poll for the pattern.
    return all.map(({ content, ...rest }) => rest);
  },
});

export const claimJob = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "pending") return null;
    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "summarizing",
      processAttempts: (job.processAttempts ?? 0) + 1,
      ...(job.summarizingStartedAt === undefined ? { summarizingStartedAt: now } : {}),
    });
    return job;
  },
});

// Telemetry: stamp terminal completion timestamp + accumulate per-attempt
// token usage. Worker calls this whenever a spawned agent exits, regardless
// of whether the job advanced; tokens accumulate even on failed attempts
// since input/output were still consumed.
export const recordAttemptResult = mutation({
  args: {
    jobId: v.id("jobs"),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    completed: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const patch: Record<string, unknown> = {};
    if (args.inputTokens !== undefined) {
      patch.inputTokens = (job.inputTokens ?? 0) + args.inputTokens;
    }
    if (args.outputTokens !== undefined) {
      patch.outputTokens = (job.outputTokens ?? 0) + args.outputTokens;
    }
    if (args.completed && job.summarizingCompletedAt === undefined) {
      patch.summarizingCompletedAt = Date.now();
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(args.jobId, patch);
  },
});

export const getProcessable = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const [pending, summarizing, suggesting] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "summarizing"))
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "suggesting"))
        .collect(),
    ]);
    return [...pending, ...summarizing, ...suggesting].map(({ content, ...rest }) => rest);
  },
});

export const updateStatus = mutation({
  args: {
    jobId: v.id("jobs"),
    status: JOB_STATUS,
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const job = await ctx.db.get(args.jobId);
    // The worker reports a status after its spawn exits, by which time the user
    // may have deleted the row from the UI. Same contract as recordAttemptResult.
    if (!job) return;
    const terminal = isTerminalJobStatus(args.status);
    const stampCompleted = terminal && job.summarizingCompletedAt === undefined;
    // When a job advances to a successful terminal (suggested/done) clear
    // any leftover `error` from a prior failed attempt — otherwise the UI
    // shows the old failure message next to a completed run.
    const clearError =
      (args.status === "suggested" || args.status === "done") && args.error === undefined && job.error !== undefined;
    await ctx.db.patch(args.jobId, {
      status: args.status,
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(clearError ? { error: undefined } : {}),
      ...(stampCompleted ? { summarizingCompletedAt: Date.now() } : {}),
    });
  },
});

export const setContent = mutation({
  args: { jobId: v.id("jobs"), content: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { content: args.content });
  },
});

export const updateTitle = mutation({
  args: { jobId: v.id("jobs"), title: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { title: args.title });
  },
});

export const setTldr = mutation({
  args: { jobId: v.id("jobs"), tldr: v.array(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { tldr: args.tldr, tldrPending: false });
  },
});

export const setTldrPending = mutation({
  args: { jobId: v.id("jobs"), pending: v.boolean(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { tldrPending: args.pending });
  },
});

export const clearAllTldr = mutation({
  args: { type: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(args.type)).eq("archived", false))
      .collect();
    let cleared = 0;
    for (const r of rows) {
      if (r.tldr && r.tldr.length > 0) {
        await ctx.db.patch(r._id, { tldr: undefined, tldrPending: false });
        cleared++;
      }
    }
    return { cleared, total: rows.length };
  },
});

export const listNeedingTldr = query({
  args: { type: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(args.type)).eq("archived", false))
      .order("desc")
      .collect();
    return all
      .filter((j) => (j.status === "suggested" || j.status === "done") && !(j.tldr && j.tldr.length > 0))
      .map((j) => ({ _id: j._id, title: j.title ?? null }));
  },
});

// Smallest candidate window any call gets, and the default page size, so a
// caller asking for 2 rows still looks at as many candidates as the UI does.
const MIN_CANDIDATE_WINDOW = 50;
// summaries and chats rows are small (no `content` blob), so their pool can be
// far wider than the job pools for a fraction of the bytes.
const SMALL_ROW_POOL = 300;

// Full-content search powered by Convex search indexes (inverted indexes
// built at write time). Does NOT scan rows — each branch hits a search index
// directly. Returns only job docs; no summary/chat bodies cross the wire.
export const searchWithContent = query({
  args: {
    type: v.string(),
    archived: v.optional(v.boolean()),
    query: v.string(),
    limit: v.optional(v.number()),
    // When true, also search the raw `content` field on jobs via the
    // by_content_text search index. Off by default — title/summary/chat is
    // usually enough and content blobs can be very large.
    includeContent: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const q = args.query.trim();
    if (!q) return [];
    const archived = args.archived ?? false;
    const cap = args.limit ?? 50;
    // `cap` bounds the ANSWER, not the candidates: the exact-phrase re-filter
    // below runs after the index read, so taking only `cap` let a query whose
    // individual tokens are common fill the whole take with noise and return
    // nothing even when an exact match existed. Widen the candidate pools,
    // exact-filter them, sort by recency, and cut to `cap` at the very end.
    //
    // Widening is not free: Convex has no projection, so every job row a search
    // index returns, and every job behind a summary / chat hit, costs its whole
    // `content` blob. At the 100k+ chars schema.ts calls normal for a paper,
    // ~160 job rows already fills the 16MB transaction read budget, and the
    // `cap`-per-branch version could reach 4 * cap = 200 of them at the default
    // cap. So the job-row ceiling here is deliberately NOT raised: it stays at
    // 4 * w (title + content + 2 * lookups), which equals the old 4 * cap for
    // every cap >= 50 and equals the default call's 200 below that. All the
    // extra reach comes from the summaries / chats pools, whose rows carry no
    // content blob and cost a few KB each.
    const w = Math.max(cap, MIN_CANDIDATE_WINDOW);
    // Half the job-row allowance is reserved for the summary / chat lookups so
    // that neither of those two branches can be starved by the other; the other
    // half goes to the jobs indexes, split only when both are actually in play.
    const extraLookups = 2 * w;
    // Not widened when the content index is off: doubling it there pushed the
    // default call (Detail toggle off, which is what the UI sends) from HEAD's
    // 150 job rows to 200, past the 16MB budget on a corpus of full papers.
    // w >= cap always, so this branch is still never narrower than HEAD.
    const titlePool = w;
    const contentPool = w;
    const rowPool = Math.max(cap, SMALL_ROW_POOL);

    // The four indexes are independent, so issue them together instead of
    // paying each round trip in sequence.
    const [titleHits, sumHits, chatHits, contentHits] = await Promise.all([
      ctx.db
        .query("jobs")
        .withSearchIndex("by_title", (b) =>
          b.search("title", q).eq("type", asJobType(args.type)).eq("archived", archived),
        )
        .take(titlePool),
      ctx.db
        .query("summaries")
        .withSearchIndex("by_summary_text", (b) => b.search("summary", q))
        .take(rowPool),
      ctx.db
        .query("chats")
        .withSearchIndex("by_content", (b) => b.search("content", q))
        .take(rowPool),
      args.includeContent
        ? ctx.db
            .query("jobs")
            .withSearchIndex("by_content_text", (b) =>
              b.search("content", q).eq("type", asJobType(args.type)).eq("archived", archived),
            )
            .take(contentPool)
        : Promise.resolve([] as Doc<"jobs">[]),
    ]);

    // Convex search indexes tokenize the query and OR the tokens — so a
    // 6-word query like "Steered Generation via Gradient-Based
    // Optimization" matches any doc containing "via" or "generation".
    // After the fuzzy union, re-filter every hit against the exact
    // (case-folded) phrase across the fields the user opted into so the
    // result set actually contains what they typed.
    const needle = q.toLowerCase();
    const matches = (hay: string | undefined | null) =>
      typeof hay === "string" && hay.length > 0 && hay.toLowerCase().includes(needle);
    const keep = (j: Doc<"jobs">) => j.type === args.type && (j.archived ?? false) === archived;

    // The re-filter reads only what the search indexes already returned. The
    // previous version re-queried summaries and chats per candidate and
    // re-fetched every candidate job, which meant hundreds of round trips and
    // megabytes of `content` even with Detail off.
    const found = new Map<string, Doc<"jobs">>();
    for (const j of titleHits) if (matches(j.title) && keep(j)) found.set(j._id, j);
    for (const j of contentHits) if (matches(j.content) && keep(j)) found.set(j._id, j);

    // Summary and chat rows only carry a jobId, so fetch just the jobs that
    // actually matched and are not already in hand. Interleave the two lists
    // before the budget cut: draining summaries first would let a flood of
    // summary matches spend the whole allowance and drop every chat match, and
    // interleaving also keeps the first `n` of each list inside the first
    // `2 * n` lookups, which is what the pre-widening pools could already reach.
    // Neither list can be type-filtered before the read: summaries and chats
    // carry only a jobId, so a lookup spent on a wrong-type job is unavoidable.
    const sumIds = sumHits.filter((s) => matches(s.summary)).map((s) => s.jobId);
    const chatIds = chatHits.filter((c) => matches(c.content)).map((c) => c.jobId);
    const extra = new Set<string>();
    for (let i = 0; i < Math.max(sumIds.length, chatIds.length); i++) {
      if (i < sumIds.length && !found.has(sumIds[i])) extra.add(sumIds[i]);
      if (i < chatIds.length && !found.has(chatIds[i])) extra.add(chatIds[i]);
    }
    for (const id of [...extra].slice(0, extraLookups)) {
      const j = await ctx.db.get(id as Id<"jobs">);
      if (j && keep(j)) found.set(j._id, j);
    }

    return [...found.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, cap)
      .map(withoutContent);
  },
});

export const patchEmailId = mutation({
  args: { jobId: v.id("jobs"), emailId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { emailId: args.emailId });
  },
});

export const setProvider = mutation({
  args: { jobId: v.id("jobs"), provider: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { provider: args.provider });
  },
});

export const getLatest = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.query("jobs").withIndex("by_createdAt").order("desc").first();
  },
});

export const getById = query({
  // Accept a raw string (not v.id) so a malformed ?item= from the URL returns
  // null instead of throwing an ArgumentValidationError that would crash the UI.
  args: { jobId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = ctx.db.normalizeId("jobs", args.jobId);
    if (!id) return null;
    return await ctx.db.get(id);
  },
});

// Per-date histogram of newsletter jobs (total vs done), walked page-by-page
// client-side so the newsletter tab can show a date-distribution figure
// analogous to the paper/article score distribution. Indexed to newsletter
// jobs only and returns just the small bucket map (no content) per page.
// The newsletter's own issue date (e.g. "TLDR 2026-06-25" -> 2026-06-25), so
// the distribution spreads over when issues were PUBLISHED, not the day a batch
// happened to be added to the queue. Falls back to the created date.
function newsletterIssueDate(title: string | undefined, createdAt: number): string {
  const m = (title ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return new Date(createdAt).toISOString().slice(0, 10);
}

// Best-effort source label for a newsletter, inferred from its title / url.
// Pasted issues (no url, has content) are "paste"; everything else "other".
function newsletterSource(title?: string, url?: string, content?: string): string {
  const t = `${title ?? ""} ${url ?? ""}`.toLowerCase();
  if (t.includes("tldr")) return "tldr";
  if (t.includes("alphasignal")) return "alphasignal";
  if (t.includes("alphaxiv")) return "alphaxiv";
  if (!url && content) return "paste";
  return "other";
}

// The date bucket key for a job under a given basis:
//   issue     -> newsletter issue date parsed from the title (day precision)
//   published -> a paper's publication month parsed from its arXiv id
//                (2406.12345 -> 2024-06); falls back to the upload month
//   created   -> the day it was uploaded to Openworks (day precision)
// Day-precision keys are YYYY-MM-DD; published keys are month-precision YYYY-MM.
function jobDateKey(j: Doc<"jobs">, basis: string): string {
  if (basis === "issue") return newsletterIssueDate(j.title, j.createdAt);
  if (basis === "published") {
    const m = (j.url ?? "").match(/arxiv\.org\/(?:abs|pdf)\/(\d{2})(\d{2})\.\d+/i);
    if (m) return `20${m[1]}-${m[2]}`;
    return new Date(j.createdAt).toISOString().slice(0, 7);
  }
  return new Date(j.createdAt).toISOString().slice(0, 10);
}

// Per-date job counts for the clickable distribution bars, aggregated in one
// shot so the result is a single reactive query — archiving / adding a job
// updates the chart live. `published` is only meaningful for papers. Job counts
// per type are small (hundreds), so collecting all is cheap.
export const jobDateStats = query({
  args: { type: v.string(), archived: v.optional(v.boolean()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const archived = args.archived ?? false;
    const all = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(args.type)).eq("archived", archived))
      .order("desc")
      .collect();
    const created: Record<string, number> = {};
    const published: Record<string, number> = {};
    for (const j of all) {
      const c = jobDateKey(j, "created");
      created[c] = (created[c] ?? 0) + 1;
      if (args.type === "paper") {
        const p = jobDateKey(j, "published");
        published[p] = (published[p] ?? 0) + 1;
      }
    }
    const toSorted = (m: Record<string, number>) =>
      Object.entries(m)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
    return { created: toSorted(created), published: toSorted(published) };
  },
});

// All non-archived jobs of a type whose date bucket (under `basis`) matches
// `dateKey` (a clicked distribution bar) and/or `source` (a clicked newsletter
// legend chip). Either or both may be set. A single bucket is small, so this
// returns the whole matching set unpaginated.
export const listByDate = query({
  args: {
    type: v.string(),
    archived: v.optional(v.boolean()),
    basis: v.optional(v.string()),
    dateKey: v.optional(v.string()),
    source: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const archived = args.archived ?? false;
    const all = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(args.type)).eq("archived", archived))
      .order("desc")
      .collect();
    return all.filter((j) => {
      if (args.dateKey != null && jobDateKey(j, args.basis ?? "created") !== args.dateKey) return false;
      if (args.source != null && newsletterSource(j.title, j.url, j.content) !== args.source) return false;
      return true;
    });
  },
});

// Full newsletter distribution aggregated in one reactive query so archiving /
// adding a newsletter updates the chart and the source counts live (Convex
// re-runs the query whenever a row in its read set changes). Summarized-item
// counts come from the denormalized `jobs.summaryCount`; querying each job's
// summaries instead was an N+1 that took ~7.5s on a cache miss and, because
// Convex delivers a consistent snapshot, held the newsletter list behind it.
export const newsletterStats = query({
  args: { archived: v.optional(v.boolean()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const archived = args.archived ?? false;
    const all = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "newsletter").eq("archived", archived))
      .order("desc")
      .collect();
    // Per issue-date: `total` = newsletter COUNT (count distribution), `elements`
    // = summarized-item count (data distribution); `srcElements` splits elements
    // by inferred source for the per-source color stack.
    const buckets: Record<
      string,
      { total: number; done: number; elements: number; srcElements: Record<string, number> }
    > = {};
    const bySource: Record<string, number> = {};
    let count = 0;
    let done = 0;
    let elements = 0;
    for (const j of all) {
      const date = newsletterIssueDate(j.title, j.createdAt);
      const n = j.summaryCount ?? 0;
      const src = newsletterSource(j.title, j.url, j.content);
      const b = buckets[date] ?? { total: 0, done: 0, elements: 0, srcElements: {} };
      b.total++;
      if (j.status === "done") b.done++;
      b.elements += n;
      b.srcElements[src] = (b.srcElements[src] ?? 0) + n;
      buckets[date] = b;
      count++;
      if (j.status === "done") done++;
      elements += n;
      bySource[src] = (bySource[src] ?? 0) + 1;
    }
    const byDate = Object.entries(buckets)
      .map(([date, b]) => ({ date, total: b.total, done: b.done, elements: b.elements, srcElements: b.srcElements }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { count, done, elements, bySource, byDate };
  },
});

// Lightweight (id, url, title) list of every paper job so the research view
// can match its arxiv papers to a registered paper job by arxiv id and open
// the shared summary modal.
export const listPaperRefs = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "paper").eq("archived", false))
      .order("desc")
      .take(150);
    return papers.map((j) => ({ jobId: j._id, url: j.url, title: j.title }));
  },
});

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    type: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const type = args.type ?? "newsletter";
    const showArchived = args.archived ?? false;
    // Archived rows read most-recently-archived first; the active list reads
    // by creation. Matches what the offset query did before infinite scroll.
    const res = showArchived
      ? await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_archivedAt", (q) => q.eq("type", asJobType(type)).eq("archived", true))
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(type)).eq("archived", false))
          .order("desc")
          .paginate(args.paginationOpts);
    return { ...res, page: res.page.map(withoutContent) };
  },
});

export const listOffset = query({
  args: {
    type: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    skip: v.number(),
    limit: v.number(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const type = args.type ?? "newsletter";
    const showArchived = args.archived ?? false;
    // take(skip+limit) instead of collect-then-slice — Convex bills row I/O,
    // and the previous version fetched the entire jobs table on every page
    // change. When viewing archived, sort by archivedAt (most recently
    // archived first) instead of createdAt.
    const window = showArchived
      ? await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_archivedAt", (q) => q.eq("type", asJobType(type)).eq("archived", true))
          .order("desc")
          .take(args.skip + args.limit)
      : await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(type)).eq("archived", false))
          .order("desc")
          .take(args.skip + args.limit);
    return window.slice(args.skip, args.skip + args.limit);
  },
});

export const count = query({
  args: {
    type: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const type = args.type ?? "newsletter";
    const archived = args.archived ?? false;
    const all = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(type)).eq("archived", archived))
      .collect();
    return all.length;
  },
});

export const backfillArchived = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db.query("jobs").collect();
    let count = 0;
    for (const j of all) {
      if (j.archived === undefined) {
        await ctx.db.patch(j._id, { archived: false });
        count++;
      }
    }
    return count;
  },
});

export const retry = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Delete old summaries and suggestions
    const sums = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of sums) await ctx.db.delete(s._id);
    const sugs = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of sugs) await ctx.db.delete(s._id);
    // Reset to pending
    await ctx.db.patch(args.jobId, { status: "pending", error: undefined });
    await syncSummaryAggregates(ctx, args.jobId);
  },
});

// One-shot bulk retry for paper jobs whose URL is arxiv/alphaxiv and whose
// stored content is empty — those were summarized through the old WebFetch
// path before the worker's pdftotext hook landed. Resets each to pending so
// the worker reprocesses with full PDF text. Skips archived rows.
export const retryArxivPapersWithoutContent = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const arxivRe = /(?:arxiv|alphaxiv)\.org\/(?:abs|pdf|html)\//i;
    const candidates = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "paper").eq("archived", false))
      .collect();
    let reset = 0;
    for (const j of candidates) {
      if (!j.url || !arxivRe.test(j.url)) continue;
      // A row that is neither terminal nor still queued has already been
      // claimed by a worker; resetting it to pending would let a second worker
      // start the same job. `pending` stays eligible because nothing is running
      // on it yet and it still needs the stale-summary / tldr cleanup below.
      if (j.status !== "pending" && !isTerminalJobStatus(j.status)) continue;
      if (typeof j.content === "string" && j.content.length > 200) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", j._id))
        .collect();
      for (const s of sums) await ctx.db.delete(s._id);
      const sugs = await ctx.db
        .query("suggestions")
        .withIndex("by_jobId", (q) => q.eq("jobId", j._id))
        .collect();
      for (const s of sugs) await ctx.db.delete(s._id);
      await ctx.db.patch(j._id, { status: "pending", error: undefined, tldr: undefined, tldrPending: false });
      await syncSummaryAggregates(ctx, j._id);
      reset++;
    }
    return { reset, scanned: candidates.length };
  },
});

export const clearScoresOnly = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { scoresOnly: undefined });
  },
});

export const clearTldrOnly = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { tldrOnly: undefined });
  },
});

// One-shot backfill: requeue every job that finished (status suggested or
// done) but never got the 3-line job-level tldr. Sets status=pending +
// tldrOnly=true + tldrPending=true so the worker's tldr-only branch picks
// them up. No new summaries / suggestions are written.
export const queueTldrRetry = mutation({
  args: { type: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const type = args.type ?? "newsletter";
    const candidates = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", asJobType(type)).eq("archived", false))
      .collect();
    let marked = 0;
    for (const j of candidates) {
      if (j.tldr && j.tldr.length > 0) continue;
      if (j.status !== "suggested" && j.status !== "done") continue;
      await ctx.db.patch(j._id, {
        status: "pending",
        tldrOnly: true,
        tldrPending: true,
        error: undefined,
      });
      marked++;
    }
    return { marked, scanned: candidates.length };
  },
});

// One-shot bulk rescore for paper jobs whose summaries are missing
// structured score fields (scores / researchLevel / priorWork / reasoning).
// Marks each job pending with scoresOnly=true. The worker reads the
// existing summary text and full content, then patches only the score
// fields via summaries:patchScores — no re-summarization, no new
// summary rows.
export const retryPaperJobsWithoutScores = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const candidates = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "paper").eq("archived", false))
      .collect();
    let marked = 0;
    for (const j of candidates) {
      // Same reason as retryArxivPapersWithoutContent: a claimed job must not
      // be flipped back to pending under a running worker. Still-queued
      // (`pending`) rows are left eligible so the sweep's reach is unchanged.
      if (j.status !== "pending" && !isTerminalJobStatus(j.status)) continue;
      if (typeof j.content !== "string" || j.content.length < 200) continue; // need full content to rescore
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", j._id))
        .collect();
      if (sums.length === 0) continue;
      const missing = sums.some((s) => !s.scores || !s.researchLevel || !s.reasoning || !s.priorWork);
      if (!missing) continue;
      await ctx.db.patch(j._id, { status: "pending", scoresOnly: true, error: undefined });
      marked++;
    }
    return { marked, scanned: candidates.length };
  },
});

// One-shot bulk rescore for article jobs whose summaries are missing the
// structured articleScores. Mirrors retryPaperJobsWithoutScores: marks each
// job pending with scoresOnly=true; the worker's article-rescore branch
// reads the existing summary (and re-fetches the URL when needed) and
// patches only articleScores — no re-summarization.
export const retryArticleJobsWithoutScores = mutation({
  // force: re-mark even articles that already have articleScores — used
  // after a rubric change so the whole set is rescored under the new caps.
  args: { force: v.optional(v.boolean()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const candidates = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "article").eq("archived", false))
      .collect();
    let marked = 0;
    for (const j of candidates) {
      if (j.status !== "suggested" && j.status !== "done") continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", j._id))
        .collect();
      if (sums.length === 0) continue;
      if (!args.force && !sums.some((s) => !s.articleScores)) continue;
      await ctx.db.patch(j._id, { status: "pending", scoresOnly: true, error: undefined });
      marked++;
    }
    return { marked, scanned: candidates.length };
  },
});

export const archive = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { archived: true, archivedAt: Date.now() });
  },
});

export const unarchive = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { archived: false, archivedAt: undefined });
  },
});

export const updateType = mutation({
  args: {
    jobId: v.id("jobs"),
    type: JOB_TYPE,
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { type: args.type });
    // The rollup reads `scores` for papers and `articleScores` for articles,
    // so retyping a job changes which of them counts.
    await syncSummaryAggregates(ctx, args.jobId);
  },
});

export const listAll = query({
  args: { paginationOpts: paginationOptsValidator, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.query("jobs").withIndex("by_createdAt").order("desc").paginate(args.paginationOpts);
  },
});

export const listAllMeta = query({
  args: { paginationOpts: paginationOptsValidator, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const result = await ctx.db.query("jobs").withIndex("by_createdAt").order("desc").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(({ content, ...rest }) => ({
        ...rest,
        contentLength: content ? content.length : 0,
      })),
    };
  },
});

export const remove = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Delete associated summaries
    const summaries = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of summaries) await ctx.db.delete(s._id);
    // Delete associated suggestions
    const suggestions = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of suggestions) await ctx.db.delete(s._id);
    // Delete job
    await ctx.db.delete(args.jobId);
  },
});

export const internalGetAllPending = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
  },
});
