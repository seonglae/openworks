// Paper tab "suggestion" backend. Two products off the same 384-dim vector
// space (see convex/embeddings.ts):
//   - relatedPapers: for a paper summary, the nearest other summaries. Pure
//     vector recall, no agent. This is the "Related papers" section.
//   - paperLinks:    agent-judged "worth referencing in this research project"
//     rows. A loose vector prefilter (candidatesForSummary) recalls projects;
//     the worker CLI agent decides which are genuine and calls writeLinks.
//     This is the "Related research" section. Clicking a row links/rejects it.
//
// No model call happens here: Convex only does vector search and storage. The
// judgment runs in the worker via actor.mts.

import { v } from "convex/values";
import { action, mutation, query, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./auth";

// --- internal hydration helpers ---

export const summaryVec = internalQuery({
  args: { summaryId: v.id("summaries") },
  handler: async (ctx, { summaryId }) => {
    const s = await ctx.db.get(summaryId);
    if (!s) return null;
    return { embedding: s.embedding ?? null, jobId: s.jobId };
  },
});

export const summaryCards = internalQuery({
  args: { ids: v.array(v.id("summaries")) },
  handler: async (ctx, { ids }) => {
    const out: { _id: string; jobId: string; title: string; url: string; keywords: string[]; type?: string }[] = [];
    for (const id of ids) {
      const s = await ctx.db.get(id);
      if (!s) continue;
      const job = await ctx.db.get(s.jobId);
      out.push({ _id: s._id, jobId: s.jobId, title: s.title, url: s.url, keywords: s.keywords, type: job?.type });
    }
    return out;
  },
});

export const projectsByIds = internalQuery({
  args: { ids: v.array(v.id("researchProjects")) },
  handler: async (ctx, { ids }) => {
    const out: { _id: string; slug: string; title: string }[] = [];
    for (const id of ids) {
      const p = await ctx.db.get(id);
      if (p) out.push({ _id: p._id, slug: p.slug, title: p.title });
    }
    return out;
  },
});

// --- Related papers (vector only, loose) ---

const RELATED_PAPERS_FLOOR = 0.3;

export const relatedPapers = action({
  args: { summaryId: v.id("summaries"), serviceKey: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      summaryId: string;
      jobId: string;
      title: string;
      url: string;
      keywords: string[];
      type?: string;
      score: number;
    }>
  > => {
    await requireOwner(ctx, args.serviceKey);
    const meta = await ctx.runQuery(internal.paperLinks.summaryVec, { summaryId: args.summaryId });
    if (!meta?.embedding) return [];
    const results = await ctx.vectorSearch("summaries", "by_embedding", { vector: meta.embedding, limit: 30 });
    const kept = results.filter((r) => r._id !== args.summaryId && r._score >= RELATED_PAPERS_FLOOR);
    if (kept.length === 0) return [];
    const docs = await ctx.runQuery(internal.paperLinks.summaryCards, { ids: kept.map((r) => r._id) });
    const out: Array<{
      summaryId: string;
      jobId: string;
      title: string;
      url: string;
      keywords: string[];
      type?: string;
      score: number;
    }> = [];
    for (const r of kept) {
      const d = docs.find((x) => x._id === r._id.toString());
      if (!d || d.jobId === meta.jobId) continue;
      out.push({
        summaryId: d._id,
        jobId: d.jobId,
        title: d.title,
        url: d.url,
        keywords: d.keywords,
        type: d.type,
        score: r._score,
      });
      if (out.length >= 8) break;
    }
    return out;
  },
});

// --- Related research candidates (loose prefilter for the worker agent) ---

const CANDIDATE_FLOOR = 0.1;

export const candidatesForSummary = action({
  args: { summaryId: v.id("summaries"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Array<{ researchId: string; slug: string; title: string; score: number }>> => {
    await requireOwner(ctx, args.serviceKey);
    const meta = await ctx.runQuery(internal.paperLinks.summaryVec, { summaryId: args.summaryId });
    if (!meta?.embedding) return [];
    const results = await ctx.vectorSearch("researchProjects", "by_embedding", { vector: meta.embedding, limit: 12 });
    const kept = results.filter((r) => r._score >= CANDIDATE_FLOOR).slice(0, 8);
    if (kept.length === 0) return [];
    const projs = await ctx.runQuery(internal.paperLinks.projectsByIds, { ids: kept.map((r) => r._id) });
    const out: Array<{ researchId: string; slug: string; title: string; score: number }> = [];
    for (const r of kept) {
      const p = projs.find((x) => x._id === r._id.toString());
      if (p) out.push({ researchId: p._id, slug: p.slug, title: p.title, score: r._score });
    }
    return out;
  },
});

// --- UI query: the agent-judged research links for a job ---

export const listByJob = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("paperLinks")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    return rows.filter((r) => r.status !== "rejected").sort((a, b) => b.score - a.score);
  },
});

// --- worker: paper summaries still awaiting link generation ---

export const pendingForLinks = query({
  args: { serviceKey: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "paper").eq("archived", false))
      .order("desc")
      .take(200);
    const out: { summaryId: string; jobId: string; title: string; summary: string; url: string }[] = [];
    for (const job of jobs) {
      if (job.status !== "done") continue;
      const s = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .first();
      if (!s || !s.embedding || s.paperLinksAt) continue;
      out.push({ summaryId: s._id, jobId: job._id, title: s.title, summary: s.summary, url: s.url });
      if (out.length >= (args.limit ?? 3)) break;
    }
    return out;
  },
});

// --- worker: write the agent's accepted links (and mark the summary done) ---

export const writeLinks = mutation({
  args: {
    summaryId: v.id("summaries"),
    jobId: v.id("jobs"),
    links: v.array(
      v.object({
        researchId: v.id("researchProjects"),
        researchSlug: v.string(),
        researchTitle: v.string(),
        score: v.number(),
        reason: v.string(),
      }),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    // Idempotent: clear any prior suggested rows for this summary before writing.
    const prior = await ctx.db
      .query("paperLinks")
      .withIndex("by_summary", (q) => q.eq("summaryId", args.summaryId))
      .collect();
    for (const p of prior) if (p.status === "suggested") await ctx.db.delete(p._id);
    for (const l of args.links) {
      await ctx.db.insert("paperLinks", {
        jobId: args.jobId,
        summaryId: args.summaryId,
        researchId: l.researchId,
        researchSlug: l.researchSlug,
        researchTitle: l.researchTitle,
        score: l.score,
        reason: l.reason,
        status: "suggested",
        createdAt: now,
      });
    }
    await ctx.db.patch(args.summaryId, { paperLinksAt: now });
    return { count: args.links.length };
  },
});

// --- UI action: keep (link) or dismiss (reject) a suggested link ---

export const setStatus = mutation({
  args: {
    linkId: v.id("paperLinks"),
    status: v.union(v.literal("linked"), v.literal("rejected"), v.literal("suggested")),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.linkId, { status: args.status });
  },
});

// --- research side: papers linked into a given project (backlink view) ---

export const listByResearch = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db.query("paperLinks").collect();
    return rows
      .filter((r) => r.researchSlug === args.researchSlug && r.status === "linked")
      .sort((a, b) => b.score - a.score);
  },
});
