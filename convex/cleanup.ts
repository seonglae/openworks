// Storage cleanup: stored full content that can always be re-fetched from a
// canonical source is dead weight. Paper jobs with an arXiv URL keep their
// summaries/scores/chat (our derived work) but drop the raw full text — the
// worker agents re-fetch from arXiv when they need it (retry, chat). A daily
// cron strips new arrivals; the paginated mutation lets the backlog be drained
// from the CLI without blowing the per-execution read limit.

import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { requireOwner } from "./auth";

const ARXIV_RE = /arxiv(?:\.org\/(?:abs|pdf)\/|[:\s/])([0-9]{4}\.[0-9]{4,6})(?:v[0-9]+)?/i;
// Terminal states whose derived artifacts (summaries etc.) already exist.
const STRIPPABLE_STATUS = new Set(["done", "suggested"]);
const MIN_CONTENT = 2_000; // don't bother with tiny content

// A paper job's content is heavy only in paste mode (URL-mode jobs fetch at
// process time and store nothing), so its own url is usually empty. Detect the
// arXiv identity from, in order: the job url, the summaries the worker wrote
// (their url points at the resolved paper), or an arXiv id printed in the
// content head.
function preStrippable(job: { type?: string; status: string; content?: string; contentStrippedAt?: number }): boolean {
  return (
    job.type === "paper" &&
    STRIPPABLE_STATUS.has(job.status) &&
    !job.contentStrippedAt &&
    typeof job.content === "string" &&
    job.content.length > MIN_CONTENT
  );
}

async function findArxivId(ctx: any, job: any): Promise<string | null> {
  const m = job.url.match(ARXIV_RE);
  if (m) return m[1];
  const sums = await ctx.db
    .query("summaries")
    .withIndex("by_jobId", (q: any) => q.eq("jobId", job._id))
    .collect();
  for (const s of sums) {
    const m2 = (s.url ?? "").match(ARXIV_RE);
    if (m2) return m2[1];
  }
  const m3 = (job.content ?? "").slice(0, 20_000).match(ARXIV_RE);
  return m3 ? m3[1] : null;
}

// Generic per-table storage probe: pages through any table and attributes
// bytes per field (JSON-encoded length), so storage hogs can be found from the
// CLI without the dashboard. Drive with a cursor loop and sum the pages.
export const tableBytes = query({
  args: {
    table: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const page = await (ctx.db.query(args.table as any) as any).paginate({ numItems: 25, cursor: args.cursor ?? null });
    let bytes = 0;
    const fields: Record<string, number> = {};
    for (const d of page.page) {
      for (const [k, val] of Object.entries(d)) {
        const n = val === undefined ? 0 : JSON.stringify(val).length;
        bytes += n;
        fields[k] = (fields[k] ?? 0) + n;
      }
    }
    return { cursor: page.continueCursor, isDone: page.isDone, rows: page.page.length, bytes, fields };
  },
});

// Debug sample: shape of paper jobs (why is a row not strippable?).
export const samplePapers = query({
  args: { cursor: v.optional(v.union(v.string(), v.null())), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const page = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .order("desc")
      .paginate({ numItems: 20, cursor: args.cursor ?? null });
    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      rows: page.page.map((j) => ({
        url: j.url.slice(0, 80),
        status: j.status,
        contentLen: j.content?.length ?? 0,
        stripped: Boolean(j.contentStrippedAt),
        arxiv: ARXIV_RE.test(j.url),
      })),
    };
  },
});

// Paginated size probe: how much stored content is arXiv-replaceable.
export const arxivStripStats = query({
  args: { cursor: v.optional(v.union(v.string(), v.null())), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const page = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .order("desc")
      .paginate({ numItems: 25, cursor: args.cursor ?? null });
    let candidates = 0;
    let bytes = 0;
    let totalBytes = 0;
    for (const j of page.page) {
      totalBytes += j.content?.length ?? 0;
      if (preStrippable(j) && (await findArxivId(ctx, j))) {
        candidates++;
        bytes += j.content!.length;
      }
    }
    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      candidates,
      bytes,
      totalBytes,
    };
  },
});

async function stripPage(ctx: any, cursor: string | null) {
  const page = await ctx.db
    .query("jobs")
    .withIndex("by_type_createdAt", (q: any) => q.eq("type", "paper"))
    .order("desc")
    .paginate({ numItems: 15, cursor });
  let stripped = 0;
  let freedBytes = 0;
  for (const j of page.page) {
    if (!preStrippable(j)) continue;
    const id = await findArxivId(ctx, j);
    if (!id) continue;
    freedBytes += j.content.length;
    await ctx.db.patch(j._id, {
      content: `[content stripped — re-fetch from https://arxiv.org/abs/${id}]`,
      contentStrippedAt: Date.now(),
    });
    stripped++;
  }
  return { cursor: page.continueCursor, isDone: page.isDone, stripped, freedBytes };
}

export const stripArxivContent = mutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await stripPage(ctx, args.cursor ?? null);
  },
});

// Daily cron entry point: newest-first single page is enough to catch each
// day's new paper jobs once they reach a terminal status.
export const stripDaily = internalMutation({
  args: {},
  handler: async (ctx) => {
    const r = await stripPage(ctx, null);
    if (r.stripped > 0) console.log(`[cleanup] stripped ${r.stripped} arxiv paper contents (${r.freedBytes} bytes)`);
    return r;
  },
});
