import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { requireOwner } from "./auth";

// Display order: whatever still needs the user's attention comes first, then
// recency within each bucket. The paginated list leans on this being a
// concatenation of per-status streams.
const STATUS_RANK = ["suggested", "new", "error", "placed", "dismissed"] as const;

const STATUS = v.union(
  v.literal("new"),
  v.literal("suggested"),
  v.literal("placed"),
  v.literal("dismissed"),
  v.literal("error"),
);

// Manual entry: split the pasted blob on blank lines so each paragraph is one
// insight (an insight is short, at most one paragraph). A multi-line quote with
// no internal blank line stays a single row.
export const add = mutation({
  args: { raw: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const chunks = args.raw
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let added = 0;
    for (const text of chunks) {
      await ctx.db.insert("insights", { text, origin: "manual", status: "new", createdAt: Date.now() });
      added++;
    }
    return { added };
  },
});

// Shortest text that can stand on its own as an insight. Both machine-fed
// paths (Notion bulk import, worker harvest) use it: a one- or two-character
// fragment is a list bullet or a stray line-wrap, never a quote, and once it is
// a row it costs an enrichment round trip and a slot in the dedupe set.
// The two human-fed paths stay exempt on purpose: `add` splits text the user
// typed, and `addImage` inserts an empty text the worker fills in from the
// screenshot.
const MIN_INSIGHT_TEXT = 4;

// Bulk import (e.g. every block of a Notion page): one insight per text,
// deduped case-insensitively against existing rows and the input itself.
export const addBatchTexts = mutation({
  args: {
    texts: v.array(v.string()),
    origin: v.optional(v.union(v.literal("manual"), v.literal("notion"))),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db.query("insights").collect();
    const seen = new Set(existing.map((e) => e.text.trim().toLowerCase()).filter(Boolean));
    let added = 0;
    for (const raw of args.texts) {
      const text = raw.trim();
      if (text.length < MIN_INSIGHT_TEXT) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.db.insert("insights", {
        text,
        origin: args.origin ?? "notion",
        status: "new",
        createdAt: Date.now(),
      });
      added++;
    }
    return { added, skipped: args.texts.length - added };
  },
});

// Image paste: one insight per pasted screenshot. Text starts empty; the worker
// reads the image, extracts the quote verbatim, then enriches like any other.
export const addImage = mutation({
  args: { imageId: v.id("_storage"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.insert("insights", {
      text: "",
      imageId: args.imageId,
      origin: "manual",
      status: "new",
      createdAt: Date.now(),
    });
  },
});

export const generateUploadUrl = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.storage.generateUploadUrl();
  },
});

export const imageUrl = query({
  args: { id: v.id("insights"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await ctx.db.get(args.id);
    if (!row?.imageId) return null;
    return await ctx.storage.getUrl(row.imageId);
  },
});

export const list = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.query("insights").withIndex("by_createdAt").order("desc").collect();
  },
});

// Cursor-paginated feed for the infinite-scroll list. A single status is a
// plain index scan. The unfiltered view is the per-status streams concatenated
// in STATUS_RANK order; Convex allows only one .paginate() per function, so it
// walks the streams with a range cursor of "<rankIndex>:<_creationTime>".
export const listPaged = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(STATUS),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const status = args.status;
    if (status) {
      return await ctx.db
        .query("insights")
        .withIndex("by_status_createdAt", (q) => q.eq("status", status))
        .order("desc")
        .paginate(args.paginationOpts);
    }

    const raw = args.paginationOpts.cursor;
    const sep = raw ? raw.indexOf(":") : -1;
    let rankIdx = sep >= 0 ? Number(raw!.slice(0, sep)) || 0 : 0;
    const inner = sep >= 0 ? raw!.slice(sep + 1) || null : null;

    // Skip statuses with no rows so a scroll never spends a round trip on an
    // empty page. Only valid at a stream boundary; mid-stream the cursor
    // already proves the current stream has rows.
    if (inner === null) {
      while (rankIdx < STATUS_RANK.length) {
        const probe = await ctx.db
          .query("insights")
          .withIndex("by_status", (q) => q.eq("status", STATUS_RANK[rankIdx]))
          .take(1);
        if (probe.length > 0) break;
        rankIdx++;
      }
    }
    if (rankIdx >= STATUS_RANK.length) {
      return { page: [], isDone: true, continueCursor: `${rankIdx}:` };
    }

    const res = await ctx.db
      .query("insights")
      .withIndex("by_status_createdAt", (q) => q.eq("status", STATUS_RANK[rankIdx]))
      .order("desc")
      .paginate({ ...args.paginationOpts, cursor: inner });

    // Exhausting a stream hands the next page to the following status.
    const nextRank = res.isDone ? rankIdx + 1 : rankIdx;
    return {
      page: res.page,
      isDone: res.isDone && nextRank >= STATUS_RANK.length,
      continueCursor: `${nextRank}:${res.isDone ? "" : res.continueCursor}`,
    };
  },
});

// Counts for the filter chips. Bounded on purpose: an unbounded count would
// reintroduce the full-table read that paginating the list removes. Scanned
// newest-first so the capped window describes the same rows list/listPaged put
// on screen; counting the oldest rows would label chips for insights the user
// would have to scroll past everything to reach.
export const statusCounts = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const CAP = 2000;
    const rows = await ctx.db.query("insights").withIndex("by_createdAt").order("desc").take(CAP);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return { counts, total: rows.length, approx: rows.length === CAP };
  },
});

export const remove = mutation({
  args: { id: v.id("insights"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.id);
  },
});

// Rewrite an insight's text (e.g. rejoining Notion line-wrap fragments into
// their preceding row) and re-queue it for enrichment: the previous
// enrichment and Notion target described the partial text, so they're cleared.
// That includes the provider credited for the enrichment and the placement
// stamp, because a row back at status "new" showing "enriched by gemini" or a
// placedAt from the old text is a lie; both are rewritten by the next
// completeEnrich / internalMarkPlaced, as is `source`.
// `sourceUrl` is deliberately kept: addHarvested's insert is the only writer of
// it in the whole repo, so clearing it destroys the harvested quote's link to
// its article forever. `origin` / `originJobId` survive for the same reason.
export const updateText = mutation({
  args: { id: v.id("insights"), text: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, {
      text: args.text,
      status: "new",
      source: undefined,
      provider: undefined,
      placedAt: undefined,
      interpretation: undefined,
      evaluation: undefined,
      tags: undefined,
      notionPageId: undefined,
      notionPageName: undefined,
      notionPageUrl: undefined,
      notionContent: undefined,
      notionContextBefore: undefined,
      notionContextAfter: undefined,
      notionReason: undefined,
      error: undefined,
    });
  },
});

export const setStatus = mutation({
  args: { id: v.id("insights"), status: STATUS, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, { status: args.status });
  },
});

// --- worker: enrichment ---

export const listNew = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("insights")
      .withIndex("by_status", (q) => q.eq("status", "new"))
      .collect();
  },
});

// The folded title is the user's original text. Enrichment may only replace it
// with a grammar/typo/spacing-level cleanup of itself (or fill an empty image
// row) — never a paraphrase, translation, or summary. Enforced here by edit
// distance so no caller can rewrite a title beyond typo range.
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

export const completeEnrich = mutation({
  args: {
    id: v.id("insights"),
    text: v.optional(v.string()),
    source: v.optional(v.string()),
    interpretation: v.optional(v.string()),
    evaluation: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    provider: v.optional(v.string()),
    notionPageId: v.optional(v.string()),
    notionPageName: v.optional(v.string()),
    notionPageUrl: v.optional(v.string()),
    notionContent: v.optional(v.string()),
    notionContextBefore: v.optional(v.string()),
    notionContextAfter: v.optional(v.string()),
    notionReason: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { id, serviceKey: _sk, text, ...fields } = args;
    const patch: Record<string, unknown> = { ...fields, status: "suggested" };
    const incoming = typeof text === "string" ? text.trim() : "";
    if (incoming) {
      const row = await ctx.db.get(id);
      const current = (row?.text ?? "").trim();
      const grammarFix =
        current.length > 0 && editDistance(incoming, current) <= Math.max(4, Math.ceil(current.length * 0.2));
      if (!current || grammarFix) patch.text = incoming;
    }
    await ctx.db.patch(id, patch);
  },
});

export const setError = mutation({
  args: { id: v.id("insights"), error: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, { status: "error", error: args.error.slice(0, 500) });
  },
});

// --- worker: auto-harvest from done newsletter/paper jobs ---

export const addHarvested = mutation({
  args: {
    jobId: v.id("jobs"),
    origin: v.union(v.literal("newsletter"), v.literal("paper")),
    items: v.array(v.object({ text: v.string(), source: v.optional(v.string()), sourceUrl: v.optional(v.string()) })),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db.query("insights").collect();
    const seen = new Set(existing.map((e) => e.text.trim().toLowerCase()).filter(Boolean));
    let added = 0;
    for (const it of args.items) {
      const text = it.text.trim();
      if (text.length < MIN_INSIGHT_TEXT) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.db.insert("insights", {
        text,
        source: it.source,
        sourceUrl: it.sourceUrl,
        origin: args.origin,
        originJobId: args.jobId,
        status: "new",
        createdAt: Date.now(),
      });
      added++;
    }
    return { added };
  },
});

// Nothing but markHarvested ever sets insightsHarvestedAt, so a job the worker
// never reaches stays harvestable forever. Scanning a window of recent jobs and
// filtering in memory starved those rows permanently once enough newer jobs
// existed, so the whole predicate lives in the index instead: every row it
// yields is already harvestable, and the read is `limit` documents rather than a
// fixed window.
// Rows predating the `archived` field have no key at all, which the index sorts
// as `undefined` rather than `false`, so both values are walked: those legacy
// rows are exactly the oldest unharvested jobs this queue exists to rescue.
// The clamp is a read-size cap, not a paging knob: these are job rows carrying
// the full pasted `content` (100k+ chars is normal, papers more), and a Convex
// transaction may read 16MB. 25 x 100KB = 2.5MB leaves room for job rows several
// times the normal size; the only production caller (worker pollInsightHarvest)
// asks for 1.
const HARVESTABLE_LIMIT = 25;

export const listHarvestable = query({
  args: { limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const limit = Math.min(Math.max(args.limit ?? 1, 1), HARVESTABLE_LIMIT);
    const out: { jobId: string; type: string }[] = [];
    for (const type of ["newsletter", "paper"] as const) {
      for (const archived of [false, undefined]) {
        const jobs = await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_status_harvested", (q) =>
            q.eq("type", type).eq("archived", archived).eq("status", "done").eq("insightsHarvestedAt", undefined),
          )
          .order("desc")
          .take(limit - out.length);
        for (const j of jobs) out.push({ jobId: j._id, type });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },
});

export const markHarvested = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.jobId, { insightsHarvestedAt: Date.now() });
  },
});

// --- internal (used by notion.placeInsight) ---

export const internalGetById = internalQuery({
  args: { id: v.id("insights") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const internalMarkPlaced = internalMutation({
  args: { id: v.id("insights") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "placed", placedAt: Date.now() });
  },
});
