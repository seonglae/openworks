import { v } from "convex/values";
import { lowestBy } from "@openworks/core";

// Summaries are keyed by `index`, which is not the order they were inserted in.
// Exported because authors.ts needs the same rule, and had a byte-identical copy.
export const headOf = <T extends { index: number }>(sums: readonly T[]) => lowestBy(sums, (s) => s.index);
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./auth";
import { syncSummaryAggregates } from "./summaryAggregates";

// A paper/article scoring at or above this overall is "recommended" and worth a
// push notification. Set high so only genuinely strong reads notify.
const RECOMMEND_THRESHOLD = 8;

// Worker calls this after the agent finishes writing summaries via addBatch,
// to stamp the provider that actually completed the job onto every row.
export const setProviderForJob = mutation({
  args: { jobId: v.id("jobs"), provider: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const r of rows) {
      if (!r.provider) await ctx.db.patch(r._id, { provider: args.provider });
    }
  },
});

export const addBatch = mutation({
  args: {
    jobId: v.id("jobs"),
    summaries: v.array(
      v.object({
        index: v.number(),
        title: v.string(),
        category: v.string(),
        summary: v.string(),
        keywords: v.array(v.string()),
        url: v.string(),
        researchLevel: v.optional(v.string()),
        scores: v.optional(
          v.object({
            soundness: v.number(),
            originality: v.number(),
            experiments: v.number(),
            clarity: v.number(),
            impact: v.number(),
            significance: v.number(),
            overall: v.number(),
            confidence: v.optional(v.number()),
          }),
        ),
        priorWork: v.optional(
          v.array(
            v.object({
              citation: v.string(),
              relation: v.string(),
            }),
          ),
        ),
        reasoning: v.optional(v.string()),
        articleScores: v.optional(
          v.object({
            evidence: v.number(),
            logic: v.number(),
            objectivity: v.number(),
            novelty: v.number(),
            clarity: v.number(),
            impact: v.number(),
            overall: v.number(),
            verdict: v.optional(v.string()),
          }),
        ),
        tldr: v.optional(v.array(v.string())),
        provider: v.optional(v.string()),
      }),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    for (const s of args.summaries) {
      await ctx.db.insert("summaries", {
        jobId: args.jobId,
        ...s,
      });
    }
    await syncSummaryAggregates(ctx, args.jobId);
  },
});

// Rescore patch: agent re-reads existing summary + full paper content and
// fills only the peer-review structured fields. Used by the worker when a
// job is queued with jobs.scoresOnly === true — we keep the existing
// summary text untouched and only stamp scores/level/priorWork/reasoning
// /tldr on top.
export const patchScores = mutation({
  args: {
    summaryId: v.id("summaries"),
    researchLevel: v.optional(v.string()),
    scores: v.optional(
      v.object({
        soundness: v.number(),
        originality: v.number(),
        experiments: v.number(),
        clarity: v.number(),
        impact: v.number(),
        significance: v.number(),
        overall: v.number(),
        confidence: v.optional(v.number()),
      }),
    ),
    priorWork: v.optional(
      v.array(
        v.object({
          citation: v.string(),
          relation: v.string(),
        }),
      ),
    ),
    reasoning: v.optional(v.string()),
    articleScores: v.optional(
      v.object({
        evidence: v.number(),
        logic: v.number(),
        objectivity: v.number(),
        novelty: v.number(),
        clarity: v.number(),
        impact: v.number(),
        overall: v.number(),
        verdict: v.optional(v.string()),
      }),
    ),
    tldr: v.optional(v.array(v.string())),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { summaryId, serviceKey: _serviceKey, ...patch } = args;
    const filtered: Record<string, unknown> = {};
    for (const [k, v_] of Object.entries(patch)) {
      if (v_ !== undefined) filtered[k] = v_;
    }
    if (Object.keys(filtered).length === 0) return;
    await ctx.db.patch(summaryId, filtered);
    const patched = await ctx.db.get(summaryId);
    if (patched) await syncSummaryAggregates(ctx, patched.jobId);

    // Recommend → notify: a fresh high overall score on a non-archived paper /
    // article fires a single Web Push deep-linking straight to the item. Deduped
    // via the job's recommendedNotifiedAt so re-scoring never re-notifies.
    const overall = args.scores?.overall ?? args.articleScores?.overall;
    if (typeof overall === "number" && overall >= RECOMMEND_THRESHOLD) {
      const summary = await ctx.db.get(summaryId);
      const job = summary ? await ctx.db.get(summary.jobId) : null;
      if (job && !job.archived && !job.recommendedNotifiedAt && (job.type === "paper" || job.type === "article")) {
        await ctx.db.patch(job._id, { recommendedNotifiedAt: Date.now() });
        await ctx.scheduler.runAfter(0, internal.pushNode.broadcast, {
          title: `Recommended ${job.type} · ${overall.toFixed(1)}`,
          body: job.title || job.url || "New recommended read",
          url: `/?item=${job._id}`,
        });
      }
    }
  },
});

// Score distribution for paper + article, aggregated in one reactive query so
// archiving / rescoring updates the chart live. Buckets are 0.5-wide over the
// 1-10 overall score for both rubrics (paper `scores`, article `articleScores`).
//
// Reads the scores off the denormalized `jobs.summaryScores` rollup rather than
// querying each job's summaries. The per-job version was an N+1 that took ~7.5s
// on a cache miss, and since Convex delivers a consistent snapshot it dragged
// the row list along with it. Summary rows also carry a 384-d embedding plus
// the full summary prose, so scanning them wholesale is not an option either.
export const scoreStats = query({
  args: { archived: v.optional(v.boolean()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const archived = args.archived ?? false;
    const empty = () => ({
      count: 0,
      min: Infinity as number,
      max: -Infinity as number,
      sum: 0,
      buckets: {} as Record<string, number>,
    });
    const acc = { paper: empty(), article: empty() };
    const fold = (slot: ReturnType<typeof empty>, overall: number) => {
      slot.count++;
      slot.sum += overall;
      if (overall < slot.min) slot.min = overall;
      if (overall > slot.max) slot.max = overall;
      const bin = (Math.floor(overall * 2) / 2).toFixed(1);
      slot.buckets[bin] = (slot.buckets[bin] ?? 0) + 1;
    };
    // `archived` is optional in the schema, and Convex indexes a missing field
    // under its own `undefined` key that matches neither false nor true. Rows
    // predating jobs:create stamping the flag would otherwise vanish from the
    // chart in both directions, so the unarchived side reads that key as well:
    // an unstamped row has never been archived. This folds in exactly the rows a
    // deployment that had always written the flag would have read anyway, so the
    // transaction still reads one job set per kind, just over two index ranges.
    const ranges: (boolean | undefined)[] = archived ? [true] : [false, undefined];
    for (const kind of ["paper", "article"] as const) {
      for (const flag of ranges) {
        const jobs = await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_createdAt", (q) => q.eq("type", kind).eq("archived", flag))
          .collect();
        for (const j of jobs) {
          for (const overall of j.summaryScores ?? []) fold(acc[kind], overall);
        }
      }
    }
    // Infinity doesn't survive JSON — null the empty sentinels.
    const out = (slot: ReturnType<typeof empty>) => ({
      count: slot.count,
      min: slot.count ? slot.min : null,
      max: slot.count ? slot.max : null,
      sum: slot.sum,
      buckets: slot.buckets,
    });
    return { paper: out(acc.paper), article: out(acc.article) };
  },
});

// Worker link-validation pass: after a job completes, the worker HEAD-checks
// every URL in each summary (inline markdown links + the url field) and
// strips ones that are definitively dead (404/410/NXDOMAIN). This patches
// the cleaned body / url back. Only these two fields are touchable.
export const patchLinks = mutation({
  args: {
    summaryId: v.id("summaries"),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { summaryId, serviceKey: _serviceKey, ...patch } = args;
    const filtered: Record<string, string> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) filtered[k] = val;
    }
    if (Object.keys(filtered).length === 0) return;
    await ctx.db.patch(summaryId, filtered);
  },
});

export const deleteDuplicates = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const seen = new Set<number>();
    for (const s of all) {
      if (seen.has(s.index)) {
        await ctx.db.delete(s._id);
      } else {
        seen.add(s.index);
      }
    }
    await syncSummaryAggregates(ctx, args.jobId);
  },
});

export const remove = mutation({
  args: { summaryId: v.id("summaries"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await ctx.db.get(args.summaryId);
    // The UI and the worker can both fire this for the same row, so a second
    // delete has to be a no-op rather than an error the caller has to swallow.
    if (!row) return;
    await ctx.db.delete(args.summaryId);
    await syncSummaryAggregates(ctx, row.jobId);
  },
});

export const listByJob = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const results = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    return results.sort((a, b) => a.index - b.index);
  },
});

// Similarity search over summarized articles. Pass `query` (free-text topic,
// keywords, or a sentence) and/or `jobId` (find articles like an existing one).
// Ranks by the full-text relevance of the `summary` field, then re-weights by
// keyword overlap so topically-adjacent items rise. Deduped to one entry per
// source job. Used by the `similar_articles` MCP tool so chat / agents can pull
// related reading and connect insights across the archive.
export const findSimilar = query({
  args: {
    query: v.optional(v.string()),
    jobId: v.optional(v.id("jobs")),
    limit: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 25);

    // Build the query text + the keyword set to re-weight against.
    let queryText = (args.query ?? "").trim();
    const seedKeywords = new Set<string>();
    let excludeJob: string | null = null;
    if (args.jobId) {
      excludeJob = args.jobId.toString();
      const src = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId!))
        .collect();
      const parts: string[] = [];
      for (const s of src) {
        parts.push(s.title);
        for (const k of s.keywords) {
          seedKeywords.add(k.toLowerCase());
          parts.push(k);
        }
      }
      // Prefer the explicit query, but fall back to the seed article's text.
      if (!queryText) queryText = parts.join(" ");
    }
    if (args.query) for (const k of args.query.toLowerCase().split(/[\s,]+/)) if (k) seedKeywords.add(k);
    queryText = queryText.slice(0, 480).trim();
    if (!queryText) return [];

    const hits = await ctx.db
      .query("summaries")
      .withSearchIndex("by_summary_text", (q) => q.search("summary", queryText))
      .take(limit * 6);

    // Collapse to one row per job, keeping the best-scoring summary, and blend
    // the search rank with keyword overlap.
    const byJob = new Map<
      string,
      { jobId: string; title: string; category: string; keywords: string[]; url: string; score: number }
    >();
    hits.forEach((h, rank) => {
      const jid = h.jobId.toString();
      if (jid === excludeJob) return;
      const overlap = h.keywords.reduce((n, k) => n + (seedKeywords.has(k.toLowerCase()) ? 1 : 0), 0);
      const score = (hits.length - rank) / hits.length + overlap * 0.5;
      const prev = byJob.get(jid);
      if (!prev || score > prev.score) {
        byJob.set(jid, {
          jobId: jid,
          title: h.title,
          category: h.category,
          keywords: h.keywords,
          url: h.url,
          score: Math.round(score * 1000) / 1000,
        });
      }
    });
    return [...byJob.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  },
});

// Token-overlap helper used by the mismatch scanner below. Lowercase,
// split on non-word, drop short tokens and obvious Korean particles —
// we want content words only (paper titles like 'Softmax', 'Transformer',
// 'Automata' show up verbatim in the source text so a single hit is enough).
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of s.toLowerCase().split(/[^a-zA-Z0-9\uAC00-\uD7A3]+/)) {
    if (tok.length < 4) continue;
    out.add(tok);
  }
  return out;
}

// The by_jobId index hands rows back in insertion order, so the first element is
// whichever row was written first, not the job's leading summary. A batch that
// arrived out of order, or a second batch appended later, makes those two
// disagree. Everything that wants "the job's summary" wants the lowest index.
// Find paper jobs whose stored summary doesn't match the paste content
// (token overlap between summary.title and content[0..1500] = 0). Returns
// a preview list so the caller can confirm before mutating.
export const previewMismatched = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .collect();
    const mismatched: {
      jobId: string;
      jobTitle: string;
      summaryTitle: string;
      contentHead: string;
      archived: boolean;
      overlap: number;
      titleTokens: number;
      ratio: number;
    }[] = [];
    for (const job of papers) {
      if (!job.content || job.content.length < 50) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      const head = headOf(sums);
      if (!head) continue;
      // Compare the agent-set English job.title (matches the paper the
      // agent actually summarized) against the user's paste content.
      // Mismatch = less than 30% of title tokens appear anywhere in the
      // content's first ~3000 chars. Looser than strict 0-overlap so we
      // catch cases where one accidental common word ("model", "learning")
      // makes a wrong title look like a match.
      const probe = (job.title ?? "").trim() || head.title;
      const titleTokens = tokenize(probe);
      if (titleTokens.size === 0) continue;
      const contentTokens = tokenize(job.content.slice(0, 3000));
      let overlap = 0;
      for (const t of titleTokens) if (contentTokens.has(t)) overlap++;
      const ratio = overlap / titleTokens.size;
      const isMismatch = ratio < 0.3;
      if (isMismatch) {
        mismatched.push({
          jobId: job._id.toString(),
          jobTitle: job.title ?? "",
          summaryTitle: head.title,
          contentHead: job.content.slice(0, 200),
          archived: job.archived ?? false,
          overlap,
          titleTokens: titleTokens.size,
          ratio,
        });
      }
    }
    // Lowest-overlap first → most confident mismatches at the top.
    mismatched.sort((a, b) => a.ratio - b.ratio);
    return mismatched;
  },
});

// Unarchive every archived paste-mode paper and reset for re-summarization.
// User-facing intent: "those archived ones — most were archived because the
// summaries looked like duplicates, but those summaries were generated by
// the bugged worker, so I want them all redone with new titles + new
// summaries." Deletes existing summaries + suggestions, clears archived,
// sets status='pending' so the worker picks them up.
// Restore archived state on every paste paper currently pending EXCEPT
// the ones in keepIds. Used to undo a blanket unarchive that shouldn't
// have included papers the user had already read + archived.
export const restoreArchiveExcept = mutation({
  args: { keepIds: v.array(v.id("jobs")), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const keep = new Set(args.keepIds.map((i) => i.toString()));
    const pending = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    let rearchived = 0;
    for (const job of pending) {
      if (job.type !== "paper") continue;
      if (keep.has(job._id.toString())) continue;
      await ctx.db.patch(job._id, { archived: true, status: "done" });
      rearchived++;
    }
    return { rearchived };
  },
});

// Reset every unarchived paste-mode paper: delete summaries + suggestions,
// status='pending'. Used after a prompt change so all currently-visible
// papers get re-summarized under the new rubric.
// Restore summaries from external recovery payload. For each entry,
// inserts the summary rows and sets job.title + status='suggested'.
// Idempotent: deletes any existing summaries for the jobId first so
// double-runs don't accumulate duplicates.
export const restoreBulk = mutation({
  args: {
    entries: v.array(
      v.object({
        jobId: v.id("jobs"),
        title: v.optional(v.string()),
        summaries: v.array(
          v.object({
            index: v.number(),
            title: v.string(),
            category: v.string(),
            summary: v.string(),
            keywords: v.array(v.string()),
            url: v.string(),
          }),
        ),
      }),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    let restored = 0;
    let summariesInserted = 0;
    for (const e of args.entries) {
      const job = await ctx.db.get(e.jobId);
      if (!job) continue;
      const existing = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", e.jobId))
        .collect();
      for (const s of existing) await ctx.db.delete(s._id);
      for (const s of e.summaries) {
        await ctx.db.insert("summaries", { jobId: e.jobId, ...s });
        summariesInserted++;
      }
      const patch: { status: "suggested"; title?: string } = { status: "suggested" };
      if (e.title) patch.title = e.title;
      await ctx.db.patch(e.jobId, patch);
      await syncSummaryAggregates(ctx, e.jobId);
      restored++;
    }
    return { restored, summariesInserted };
  },
});

export const resetUnarchivedPastePapers = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "paper").eq("archived", false))
      .collect();
    let touched = 0;
    let summariesDeleted = 0;
    let suggestionsDeleted = 0;
    for (const job of papers) {
      if (!job.content || job.content.length < 50) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      const sugs = await ctx.db
        .query("suggestions")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      for (const s of sums) await ctx.db.delete(s._id);
      for (const s of sugs) await ctx.db.delete(s._id);
      await ctx.db.patch(job._id, { status: "pending" });
      await syncSummaryAggregates(ctx, job._id);
      touched++;
      summariesDeleted += sums.length;
      suggestionsDeleted += sugs.length;
    }
    return { touched, summariesDeleted, suggestionsDeleted };
  },
});

export const resetArchivedPastePapers = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", "paper").eq("archived", true))
      .collect();
    let summariesDeleted = 0;
    let suggestionsDeleted = 0;
    let touched = 0;
    for (const job of papers) {
      if (!job.content || job.content.length < 50) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      const sugs = await ctx.db
        .query("suggestions")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      for (const s of sums) await ctx.db.delete(s._id);
      for (const s of sugs) await ctx.db.delete(s._id);
      await ctx.db.patch(job._id, { status: "pending", archived: false });
      await syncSummaryAggregates(ctx, job._id);
      summariesDeleted += sums.length;
      suggestionsDeleted += sugs.length;
      touched++;
    }
    return { touched, summariesDeleted, suggestionsDeleted };
  },
});

// Dump every paste-mode paper's (jobId, title, summary title, content
// head). For external judging: read this list, pick which jobIds are
// mismatched, then call resetByIds with that list.
export const listAllPasteHeads = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .collect();
    const out: {
      jobId: string;
      jobTitle: string;
      summaryTitle: string;
      contentHead: string;
      archived: boolean;
    }[] = [];
    for (const job of papers) {
      if (!job.content || job.content.length < 50) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      out.push({
        jobId: job._id.toString(),
        jobTitle: job.title ?? "",
        summaryTitle: headOf(sums)?.title ?? "",
        contentHead: job.content.slice(0, 400),
        archived: job.archived ?? false,
      });
    }
    return out;
  },
});

// Reset a specific set of jobIds (delete summaries + suggestions,
// unarchive, status='pending'). Pair with listAllPasteHeads when you
// want manual selection instead of heuristic matching.
export const resetByIds = mutation({
  args: { jobIds: v.array(v.id("jobs")), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    let summariesDeleted = 0;
    let suggestionsDeleted = 0;
    for (const id of args.jobIds) {
      const job = await ctx.db.get(id);
      if (!job) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", id))
        .collect();
      const sugs = await ctx.db
        .query("suggestions")
        .withIndex("by_jobId", (q) => q.eq("jobId", id))
        .collect();
      for (const s of sums) await ctx.db.delete(s._id);
      for (const s of sugs) await ctx.db.delete(s._id);
      await ctx.db.patch(id, { status: "pending", archived: false });
      await syncSummaryAggregates(ctx, id);
      summariesDeleted += sums.length;
      suggestionsDeleted += sugs.length;
    }
    return { count: args.jobIds.length, summariesDeleted, suggestionsDeleted };
  },
});

// Reset every paste-mode paper job: delete all its summaries +
// suggestions, unarchive, clear job.title, set status='pending' so the
// worker re-runs it from scratch. Use this when the previous run was
// contaminated by the content-stripping bug and you no longer trust the
// heuristic to identify which rows are wrong. dryRun returns counts
// without mutating.
export const resetAllPastePapers = mutation({
  args: { dryRun: v.optional(v.boolean()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const dry = args.dryRun ?? false;
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .collect();
    let jobsTouched = 0;
    let summariesDeleted = 0;
    let suggestionsDeleted = 0;
    for (const job of papers) {
      if (!job.content || job.content.length < 50) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      const sugs = await ctx.db
        .query("suggestions")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      if (!dry) {
        for (const s of sums) await ctx.db.delete(s._id);
        for (const s of sugs) await ctx.db.delete(s._id);
        await ctx.db.patch(job._id, { status: "pending", archived: false });
        await syncSummaryAggregates(ctx, job._id);
      }
      jobsTouched++;
      summariesDeleted += sums.length;
      suggestionsDeleted += sugs.length;
    }
    return { jobsTouched, summariesDeleted, suggestionsDeleted, dryRun: dry };
  },
});

// Reconcile: delete the wrong summaries, unarchive, set status back to
// pending so the worker re-summarizes with the fixed code path. Same
// token-overlap heuristic as previewMismatched.
export const reconcileMismatched = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .collect();
    const fixed: { jobId: string; oldSummaryTitle: string }[] = [];
    for (const job of papers) {
      if (!job.content || job.content.length < 50) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      const head = headOf(sums);
      if (!head) continue;
      // Compare the agent-set English job.title (matches the paper the
      // agent actually summarized) against the user's paste content.
      // Mismatch = less than 30% of title tokens appear anywhere in the
      // content's first ~3000 chars. Looser than strict 0-overlap so we
      // catch cases where one accidental common word ("model", "learning")
      // makes a wrong title look like a match.
      const probe = (job.title ?? "").trim() || head.title;
      const titleTokens = tokenize(probe);
      if (titleTokens.size === 0) continue;
      const contentTokens = tokenize(job.content.slice(0, 3000));
      let overlap = 0;
      for (const t of titleTokens) if (contentTokens.has(t)) overlap++;
      const ratio = overlap / titleTokens.size;
      const isMismatch = ratio < 0.3;
      if (isMismatch) {
        const oldTitle = head.title;
        for (const s of sums) await ctx.db.delete(s._id);
        // also wipe any suggestions tied to this job — they were
        // generated against the wrong summary and would mislead
        const oldSuggestions = await ctx.db
          .query("suggestions")
          .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
          .collect();
        for (const s of oldSuggestions) await ctx.db.delete(s._id);
        await ctx.db.patch(job._id, { status: "pending", archived: false, title: undefined });
        await syncSummaryAggregates(ctx, job._id);
        fixed.push({ jobId: job._id.toString(), oldSummaryTitle: oldTitle });
      }
    }
    return { count: fixed.length, fixed };
  },
});
